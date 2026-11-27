/**
 * The task engine's HTTP contract.
 *
 * `work.prisma` is described in CLAUDE.md as "THE farm task system", and
 * until now not one of its 15 routes was described in the spec — a client
 * building against it had to read `src/` and infer. That inference has
 * already cost this project once: the iOS journal list shipped decoding
 * `items` because the use case returns `{ items, pageInfo }` while the
 * ROUTE reshapes it to `{ rows, nextCursor }`. The wire is what a client
 * sees, and nothing was telling it what the wire holds.
 *
 * Request bodies are the REAL Zod schemas the routes validate with, so they
 * cannot drift from the handlers.
 *
 * Response bodies now reference `TaskDTOSchema`, and that SATISFIES the rule
 * this note used to state rather than overriding it. The rule was that
 * `z.unknown()` is the honest maximum "for a shape nobody has pinned with a DTO
 * yet" — and a task HAD been pinned all along: `TaskDTOSchema` is already the
 * documented response for `farm-tasks.paths.ts` and `field-operations.paths.ts`,
 * and `use-tasks.ts` validates with it on the client. So the second spelling
 * the note warns about already existed and was already trusted; these routes
 * were simply the ones not pointing at it.
 *
 * `TaskCommentDTOSchema` is new, and is the one place here that adds a
 * spelling. It is eight fields read off the repository's own `include` rather
 * than guessed, and it lives in `task.dto.ts` beside `Task` so the next reader
 * finds them together instead of finding a copy inlined in a paths module.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { codedErrorResponses, op } from './helpers';
// `TaskDTOSchema` is ALREADY the documented response shape for
// `farm-tasks.paths.ts` and `field-operations.paths.ts`, and the client
// validates with it in `use-tasks.ts`. Referencing it here is using the
// spelling this repo already trusts for the same record — not adding a third
// one, which is what the note below rightly warns against.
import {
    TaskDTOSchema,
    TaskListItemDTOSchema,
    TaskActivityDTOSchema,
    TaskDetailDTOSchema,
    TaskCommentDTOSchema,
    TaskLinkDTOSchema,
    TaskParcelDTOSchema,
} from '@/lib/dto/task.dto';
import { EvidenceLinkDTOSchema, EvidenceListItemDTOSchema } from '@/lib/dto/evidence.dto';
import {
    CreateTaskSchema,
    UpdateTaskSchema,
    SetTaskStatusSchema,
    AssignTaskSchema,
    AddTaskCommentSchema,
    AddTaskLinkSchema,
    BulkTaskAssignSchema,
    LinkTaskEvidenceSchema,
    BulkTaskDeleteSchema,
    BulkTaskDueDateSchema,
    BulkTaskStatusSchema,
} from '@/lib/schemas';
import { CreateTaskWeedObservationSchema } from '@/app-layer/schemas/parcel-history.schemas';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const TaskParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
    taskId: z.string().openapi({ param: { name: 'taskId', in: 'path' } }),
});

/**
 * `GET /tasks` returns one key in both branches — and it did not until
 * this change, which is the reason the comment is this long.
 *
 *     GET /tasks            -> { rows, truncated }
 *     GET /tasks?limit=50   -> { rows, nextCursor }
 *
 * Documenting this endpoint is what surfaced the divergence: the paginated
 * branch used to return the use case's `{ items, pageInfo }` verbatim while
 * the bare branch returned `{ rows, truncated }`. Two shapes from one
 * endpoint, keyed differently.
 *
 * What makes that worse than an inconsistency is WHEN it springs. A client
 * decodes `rows`, everything works, and months later someone adds `?limit`
 * for paging — a change with nothing to do with decoding. The key silently
 * becomes `items`, the array is absent, and the screen shows "no tasks"
 * over a tenant with hundreds. No error, no decode failure, no log line.
 * The bug is not in the code that adds pagination; it was planted in the
 * decoder and detonates there.
 *
 * Nothing consumed the old shape — `useCursorPagination`, this app's own
 * accumulator, reads `rows`/`nextCursor`, so `/tasks` was not paginable by
 * the client that would have paginated it. The journal route already
 * reshaped for exactly that reason; tasks now matches.
 *
 * The difference that remains is honest and worth reading: `truncated`
 * means rows were DROPPED by a backfill cap and the UI must say so;
 * `nextCursor` means there are more and here is how to ask.
 */
const LIST_SHAPE_WARNING =
    'Both branches are keyed `rows`. Without `limit`/`cursor`: `{ rows, truncated }` — a ' +
    'backfill-capped list where `truncated: true` means rows were DROPPED and the UI must ' +
    'say so, not silently show fewer. With `limit` or `cursor`: `{ rows, nextCursor }`, the ' +
    'shape `useCursorPagination` consumes. Until 2026-09 the paginated branch returned ' +
    '`{ items, pageInfo }` instead, so a client that decoded `rows` and later added `?limit` ' +
    'read an absent key and rendered an empty list with no error. If you are reading an older ' +
    'client, check which key it expects before trusting it.';

/**
 * Three facts that govern ALL FOUR `tasks/bulk/*` routes (#3080). Shared so the
 * four descriptions cannot drift into disagreeing about the cap or about what
 * `count` means — which is the drift this file exists to prevent.
 */
const BULK_COUNT_AND_CAP =
    '\n\n**`count` is what was WRITTEN, not what was asked for.** All four bulk '
    + 'routes are an `updateMany` filtered on `{ id: { in: taskIds }, tenantId }`, so an '
    + 'id that does not exist or belongs to another farm drops out silently. A `count` '
    + 'below `taskIds.length` is therefore normal and not an error — #2103 is the issue '
    + 'filed because a summary saying twenty tasks when three were written misreports '
    + 'the one thing it exists to report. Render the number the server returns, never '
    + 'the size of your own selection.'
    + '\n\n**At most 100 ids**, the same cap as the other three: all four back one '
    + 'multi-select on one screen, so a farmer who could assign a hundred rows and not '
    + 're-date a hundred would be meeting an arbitrary edge.';

const BULK_ALL_OR_NOTHING =
    '\n\n**All-or-nothing.** The whole operation runs in one transaction, so a refusal '
    + 'part-way through writes NOTHING — every selected row keeps the value it had. Do '
    + 'not design a client around partial results.';

export function registerTaskPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks',
        operationId: 'listTasks',
        summary: 'List tasks',
        description:
            LIST_SHAPE_WARNING +
            ' Filters: `status`, `type`, `severity`, `priority`, `assigneeUserId`, `due`, `q`, ' +
            '`linkedEntityType`, `linkedEntityId`. These two surfaces are single-select and the ' +
            'route wraps each into the array the repository takes — do not send a ' +
            'comma-separated list here expecting the farm-tasks behaviour.',
        tags: ['Tasks'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'Tasks. TWO shapes, and the query decides which — see the operation description.',
            schema: z.union([
                z.object({
                    rows: z.array(TaskListItemDTOSchema),
                    nextCursor: z.string().nullable(),
                }),
                z.object({ rows: z.array(TaskListItemDTOSchema), truncated: z.boolean() }),
            ]),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks',
        operationId: 'createTask',
        summary: 'Create a task',
        description: 'Returns 201 with the created task.',
        tags: ['Tasks'],
        params: TenantParams,
        body: CreateTaskSchema,
        success: { status: 201, description: 'The created task.', schema: TaskDTOSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}',
        operationId: 'getTask',
        summary: 'Get one task',
        tags: ['Tasks'],
        params: TaskParams,
        success: {
            status: 200,
            // `TaskDetail`, not `Task`: this route returns the relations
            // `getById` includes plus the `sla` `getTask` derives. The LIST
            // above serves `TaskListItem`, a twelve-field projection. Both
            // were documented as `Task` until this change, so each promised
            // what only the other sends.
            description: 'The task, with its relations.',
            schema: TaskDetailDTOSchema,
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/tasks/{taskId}',
        operationId: 'updateTask',
        summary: 'Update a task',
        description:
            'Partial update. `description` and `resolution` are ENCRYPTED at rest and sanitised ' +
            'server-side on write, so send plain text and expect plain text back.\n\n' +
            '**Editing is creator-or-admin** (#2169). A writer who did not create the task is ' +
            'refused with `TASK_EDIT_NOT_PERMITTED` — distinct from the role refusal, so a ' +
            'client can tell "this is not yours" from "your role cannot edit tasks" and say so. ' +
            'The check reads `createdByUserId` off the stored ROW, so a patch cannot name its ' +
            'own author.',
        tags: ['Tasks'],
        params: TaskParams,
        body: UpdateTaskSchema,
        extraResponses: codedErrorResponses({
            403:
                'Signed in, but not permitted to edit THIS task.\n\n' +
                '- `TASK_EDIT_NOT_PERMITTED` — the task was created by somebody else and this ' +
                'caller is not a farm admin. Retrying will not help; the task has to be edited ' +
                'by its creator or an admin.\n' +
                '- `WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.\n\n' +
                'The middleware 403s listed on the shared envelope are reachable here too.',
        }),
        success: { status: 200, description: 'The updated task.', schema: TaskDTOSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/tasks/{taskId}',
        operationId: 'deleteTask',
        summary: 'Delete a task',
        description:
            '**A HARD delete.** The row is removed and its children cascade — comments, ' +
            'links and evidence links go with it. This said "Soft delete — reads filter it ' +
            'out, the row survives", which was wrong: `Task.deletedAt` exists and is ' +
            'indexed, and the repository filters on it, but nothing writes it on this ' +
            'path. Corrected 2026-10-23 (#2187).\n\n' +
            '**Creator-or-admin** (#2187). A writer who did not create the task is refused ' +
            'with `TASK_DELETE_NOT_PERMITTED`, closing an asymmetry #2169 opened: editing ' +
            'was gated and deleting was not, so the weaker permission guarded the more ' +
            'destructive verb. The check reads `createdByUserId` off the STORED row.\n\n' +
            '`POST /tasks/bulk/delete` raises the SAME code and is **all-or-nothing**: if ' +
            'any selected task was created by somebody else, nothing is deleted and the ' +
            'error carries `refused` and `selected` counts so a client can say how many. A ' +
            'partial success would leave the farmer reconciling an outcome against their ' +
            'own selection with no way to tell which rows went.\n\n' +
            '**A treatment\'s task cannot be deleted here at all** (#2220). Four child ' +
            'models cascade on this delete and `OperationParcel` is one of them — those ' +
            'rows ARE the lines the БАБХ ДНЕВНИК prints, and `TaskLink` is the LOCATION ' +
            'link it joins through. So this route would destroy register lines from a ' +
            'filed regulatory document, permanently, while `DELETE ' +
            '/journal/treatments/{treatmentGroupId}` does the same job reversibly: it ' +
            'flags rather than deletes, leaves DONE lines intact, audits the withdrawal ' +
            'and restores from «Кошче».\n\n' +
            'The discriminator is `treatmentGroupId`, not `type`: a FIELD_OPERATION ' +
            'planned through `POST /locations/{id}/operations` leaves it null and stays ' +
            'deletable here, which matters because the withdrawal route keys on a group ' +
            'such a task does not have.',
        tags: ['Tasks'],
        extraResponses: codedErrorResponses({
            403:
                'Signed in, but not permitted to delete THIS task.\n\n' +
                '- `TASK_DELETE_NOT_PERMITTED` — created by somebody else and this caller ' +
                'is not a farm admin. On the bulk route it carries `refused` / `selected`.\n' +
                '- `WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            409:
                'Permitted, but the wrong route for this row.\n\n' +
                '- `TASK_BELONGS_TO_TREATMENT` — the task is one block\'s share of a ' +
                'recorded treatment. `reference` names `treatmentGroupId`, which is the ' +
                'handle for `DELETE /journal/treatments/{treatmentGroupId}`. On the bulk ' +
                'route it is all-or-nothing and carries `refused` / `selected` instead.',
        }),
        params: TaskParams,
        success: {
            status: 200,
            description: 'Deleted. `{ ok: true }` — no body of the deleted row.',
            schema: z.object({ ok: z.boolean() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/status',
        operationId: 'setTaskStatus',
        summary: 'Set task status',
        description:
            'The field action. This is the write an operator makes standing in a field, so it is ' +
            'the one that arrives twice: the offline outbox replays it, and the route has an ' +
            'ALREADY-APPLIED arm precisely because its commonest 400 was a replay whose write had ' +
            'already landed. Send `Idempotency-Key` and treat an already-applied response as ' +
            'success, not as a conflict to surface.',
        tags: ['Tasks'],
        params: TaskParams,
        body: SetTaskStatusSchema,
        success: { status: 200, description: 'The updated task.', schema: TaskDTOSchema },
        // These three had bg and en copy and no spec entry, for as long as the
        // route has existed. They were invisible to
        // `error-codes-are-documented` because the throw passes
        // `transitionErrorCode(transitionErr)` — a function call, not a literal
        // — and the extractor reads only literals (#2370). A client reading the
        // contract had no way to learn they exist, so an unmapped code degrades
        // to a generic message on exactly the write an operator makes most.
        extraResponses: codedErrorResponses({
            400:
                'The state machine refused the move, or a replayed write no longer applies.\n\n'
                + '- `TASK_STATUS_UNCHANGED` — the task is ALREADY in that status. The commonest '
                + 'cause is the offline outbox replaying a write that already landed, which is why '
                + 'this is the arm to treat as success rather than surface as a conflict. '
                + '`params.status` names the status it is already in.\n'
                + '- `ILLEGAL_TRANSITION` — a move the state machine does not allow: a CLOSED → '
                + 'OPEN re-open, CANCELED → IN_PROGRESS, or OPEN → CLOSED skipping RESOLVED. '
                + '`params.from` and `params.to` name both ends, so a client can say which move '
                + 'was refused without guessing.\n'
                + '- `UNKNOWN_TASK_STATUS` — one end of the move is not a status this server '
                + 'knows: a stored value it cannot parse, or a target a newer client sent.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/assign',
        operationId: 'assignTask',
        summary: 'Assign a task',
        tags: ['Tasks'],
        params: TaskParams,
        body: AssignTaskSchema,
        success: { status: 200, description: 'The updated task.', schema: TaskDTOSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/comments',
        operationId: 'listTaskComments',
        summary: 'List task comments',
        tags: ['Tasks'],
        params: TaskParams,
        success: {
            status: 200,
            description: 'Comments, OLDEST first — a conversation read in order.',
            schema: z.array(TaskCommentDTOSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/comments',
        operationId: 'addTaskComment',
        summary: 'Add a task comment',
        description:
            '**The body is PLAIN TEXT. Render it as text — never as HTML.**' +
            '\n\nThis replaces a description that said the opposite. It claimed `addTaskComment` ' +
            'routes the body through `sanitizeRichTextHtml`, and that a literal `<` comes back as ' +
            '`&lt;`. Neither is true: the usecase calls `sanitizePlainText`, which strips every tag ' +
            'and then DECODES entities. Measured:' +
            '\n\n| sent | stored and returned |\n| --- | --- |\n' +
            '| `<b>x</b> &amp;amp; y` | `x & y` |\n' +
            '| `a < b` | `a < b` — unchanged, NOT escaped |\n' +
            '| `&amp;lt;script&amp;gt;` | `<script>` — entities decoded to literal characters |\n' +
            '| `<script>alert(1)</script>` | empty — the element is removed |' +
            '\n\nSo the returned string can contain `<script>` as literal text even though no tag ' +
            'was sent, because the decode happens after the strip. Interpolating this value into ' +
            'markup would execute it — and "flatten the HTML and decode entities", which the old ' +
            'description advised, is exactly that mistake. There is no HTML to flatten and no ' +
            'entities left to decode. The web client renders it as a JSX child so React escapes it ' +
            'on output; that is the handling to copy.' +
            '\n\n**Honours `Idempotency-Key`.** Send one, minted BEFORE the first attempt and ' +
            'reused on every retry of the same logical write. The server stores it as ' +
            '`clientMutationId` under a unique `(tenantId, clientMutationId)` index, and a replay ' +
            'returns the ORIGINAL comment — with no second audit event and no second cache bump, ' +
            'neither of which a deduped row alone would prevent.' +
            '\n\nThe read-back is scoped to the TASK as well as the tenant, so reusing one key ' +
            'across two different tasks is an error rather than a silent mis-delivery: the insert ' +
            'hits the tenant-wide index, the task-scoped re-read finds nothing, and the conflict ' +
            'surfaces instead of handing you the comment you posted on the other task. Mint a ' +
            'fresh key per logical write.',
        tags: ['Tasks'],
        params: TaskParams,
        body: AddTaskCommentSchema,
        success: {
            status: 201,
            description:
                'The created comment — or, on a replay of the same `Idempotency-Key`, the original. ' +
                'Both are 201: the response describes the comment that exists, not which attempt made it.',
            schema: TaskCommentDTOSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/parcels',
        operationId: 'getTaskParcels',
        summary: "The parcels a task touches, for a map",
        description:
            'Built for agrent-ios#177. The shape is **uniform across task types**: a FIELD_OPERATION\'s ' +
            'parcels come from its operation lines and every other type\'s come from its `PARCEL` links, ' +
            'and both answer identically. That is the point — one decoder, and the meaning does not ' +
            'depend on the type.' +
            '\n\n**Deduplicated by parcel id, and that is load-bearing rather than tidy.** Operation ' +
            'lines are per (parcel, product), not per parcel: a spray job records a fertilizer line AND ' +
            'a treatment line for the same parcel. Two products over three parcels is six rows covering ' +
            'three parcels, and this returns three.' +
            '\n\n**Ordered by `name`, then `id`.** The order is part of the contract: a client rendering ' +
            'a legend keyed on name would otherwise see it reshuffle between loads, and parcel names are ' +
            'not unique so the id is what makes the order total.' +
            '\n\n**A task with no parcels is `200 { "parcels": [] }`, never a 404.** The 404 belongs to ' +
            'the task alone, so "no parcels yet" stays distinguishable from "wrong id".' +
            '\n\nDeliberately **status-free** and carrying **no `boundsJson`** — per-parcel operation ' +
            'status is on `GET /field-operations/{taskId}`, which is where a client should draw a field ' +
            'operation from anyway since it also carries the location backdrop. A `LOCATION` link is ' +
            'NOT expanded into that location\'s parcels: whether that should mean "its parcels now" or ' +
            '"the parcels it had when linked" has not been decided, so it is left undone rather than guessed.',
        tags: ['Tasks'],
        params: TaskParams,
        success: {
            status: 200,
            description:
                'The task\'s parcels, deduplicated and ordered by name then id. Empty when the task links none.',
            schema: z.object({ parcels: z.array(TaskParcelDTOSchema) }).openapi('TaskParcelsResponse', {
                description:
                    'Wrapped in an object rather than returned as a bare array, so a count or a bounds can be added later without a breaking change. The sibling `/links` returns a bare array and is the route that now cannot grow.',
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/weed-observations',
        operationId: 'createTaskWeedObservation',
        summary: 'Record the weeds met while doing a task',
        description:
            'Built for agrent-ios#226 — the weeds half of the task-closing form, filled in by the ' +
            'person standing in the field.' +
            '\n\n**This is the route a MECHANISATOR can use.** The sibling ' +
            '`POST /agro/parcels/{parcelId}/weed-observations` writes the same row but requires general ' +
            'write permission, which a mechanisator does not have — so closing their own task used to ' +
            'return 403 on the only write the form makes. Here the authorization is **general task ' +
            'write OR being the task\'s assignee**, and the task id in the path is what bounds the ' +
            'widening. Use this route from a task; use the parcel route for an observation that is not ' +
            'tied to one.' +
            '\n\n**`parcelId` must be one of the task\'s own parcels**, resolved by exactly the ' +
            'function behind `GET /tasks/{taskId}/parcels`. So the parcels you can draw on the map are ' +
            'exactly the parcels you can post against, and the two cannot drift. Anything else is ' +
            '`PARCEL_NOT_ON_TASK`, a **400** rather than a 403: the request is mis-addressed, which is ' +
            'a client bug worth surfacing, not a permission the farmer could be granted. That check ' +
            'applies to PRIVILEGED callers too — an editor does not get to post to a parcel the task ' +
            'does not touch.' +
            '\n\n**One list of weeds, mixed.** The server decides which entries are catalogue keys ' +
            'and which are free text; a client cannot choose the column, which is what keeps the ' +
            'reportable half reportable. An empty resolution is `WEEDS_REQUIRED`.' +
            '\n\n**Honours `Idempotency-Key`.** Send one, minted BEFORE the first attempt and ' +
            'reused on every retry of the same logical write. The server stores it as ' +
            '`clientMutationId` under a unique `(tenantId, clientMutationId)` index, and a replay ' +
            'returns the ORIGINAL observation with no second audit entry. A replay is **201**, the ' +
            'same as the first write: the response describes the observation that exists, not which ' +
            'attempt filed it, so there is no extra branch to decode.' +
            '\n\nThe read-back is scoped to the PARCEL as well as the tenant, so reusing one key ' +
            'across two parcels is an error rather than a silent mis-delivery — mint a fresh key per ' +
            'logical write. Handing back the row filed against a different parcel would let a client ' +
            'mark its outbox item delivered having lost an observation, and these feed the ДНЕВНИК ' +
            'record: a dropped one misstates what was seen in a field on a date.' +
            '\n\nThe replay read runs AFTER both authorisation gates, so a key alone never returns ' +
            'a row to a caller who could not have written one.' +
            '\n\nRefusal codes: `TASK_NOT_FOUND` (404, and decided before any permission verdict so ' +
            'a typo\'d id never reads as a permission problem), `PARCEL_NOT_ON_TASK` (400), ' +
            '`PARCEL_NOT_FOUND` (404), `WEEDS_REQUIRED` (400).',
        tags: ['Tasks'],
        params: TaskParams,
        body: CreateTaskWeedObservationSchema,
        success: {
            status: 201,
            description:
                'The observation exists. Only its `id` is returned — read the parcel\'s history for the row.',
            schema: z.object({ id: z.string() }).openapi('CreateTaskWeedObservationResponse'),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/links',
        operationId: 'listTaskLinks',
        summary: 'List a task\'s links to other entities',
        description:
            'The route has existed since Feature 1 and was absent from this spec until now, so a client ' +
            'had to learn the shape by calling it (reported in #1391).' +
            '\n\n`entityType` is a MIXED set on one task — `ASSET`, `EVIDENCE`, `FILE`, `LOCATION`, ' +
            '`PARCEL`, `EQUIPMENT`, `PLANTING` — so a client wanting one kind must filter. For parcels ' +
            'specifically, prefer `GET …/parcels`, which filters in the database and also resolves the ' +
            'geometry.' +
            '\n\nReturns a **bare array**, NEWEST first. The bare array is a shape this route is stuck ' +
            'with rather than one to copy.',
        tags: ['Tasks'],
        params: TaskParams,
        success: {
            status: 200,
            description: 'The task\'s links, newest first.',
            schema: z.array(TaskLinkDTOSchema),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/metrics',
        operationId: 'getTaskMetrics',
        summary: 'Counts and trends across the farm\'s tasks',
        description:
            'Backs the tasks dashboard. Live and **undocumented until now** (#3080).'
            + '\n\n**Every count is tenant-wide, not filtered.** It ignores whatever filters '
            + 'the list page has applied, so a client must not present these numbers as '
            + 'describing the rows on screen.'
            + '\n\n`byStatus`, `bySeverity` and `byType` are OPEN MAPS built from the rows '
            + 'that exist — a status with no tasks is **absent, not zero**. Read them with a '
            + '`?? 0` fallback rather than assuming every enum member is a key.'
            + '\n\n`overdue`, `dueIn7d` and `dueIn30d` count only NON-TERMINAL tasks, so a '
            + 'resolved task with a past due date is not overdue. `trend.resolved30d` counts '
            + 'a task once, on the day it was resolved, so a task resolved then closed later '
            + 'is not double-counted.',
        tags: ['Tasks'],
        params: TenantParams,
        extraResponses: codedErrorResponses({
            403: '`READ_FORBIDDEN_FOR_ROLE` — the role cannot read records at all.',
        }),
        success: {
            status: 200,
            description: 'Tenant-wide task counts and 30-day trend.',
            schema: z.object({
                total: z.number().int(),
                byStatus: z.record(z.string(), z.number().int()),
                bySeverity: z.record(z.string(), z.number().int()),
                byType: z.record(z.string(), z.number().int()),
                overdue: z.number().int(),
                dueIn7d: z.number().int(),
                dueIn30d: z.number().int(),
                trend: z.object({
                    created30d: z.number().int(),
                    resolved30d: z.number().int(),
                }),
                topLinkedEntities: z.array(
                    z.object({
                        entityType: z.string(),
                        entityId: z.string(),
                        count: z.number().int(),
                    }),
                ).openapi({
                    description:
                        'The five ASSETS most linked to open tasks, busiest first. Assets only '
                        + '— the query filters `entityType` to ASSET, so a client should not '
                        + 'expect locations or parcels here.',
                }),
            }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/evidence',
        operationId: 'getTaskEvidence',
        summary: 'Evidence attached to a task',
        description:
            'Live and **undocumented until now** (#3080).'
            + '\n\n**`links` is ALWAYS EMPTY, and that is not a bug.** The payload is the '
            + '`{ links, evidence }` shape the shared `<EvidenceSubTable>` renders, which '
            + 'exists for a bridge-table case — a separate link model between the subject and '
            + 'the evidence. Tasks do not have one: evidence points at a task directly through '
            + '`Evidence.taskId`. The asset attached-evidence route returns `links: []` for the '
            + 'same reason, so **no live producer populates it**. Do not branch on it.'
            + '\n\nSoft-deleted evidence is excluded, and the list is newest-first.',
        tags: ['Tasks'],
        params: TaskParams,
        extraResponses: codedErrorResponses({
            403: '`READ_FORBIDDEN_FOR_ROLE` — the role cannot read records at all.',
            404: '`TASK_NOT_FOUND` — no such task in this farm.',
        }),
        success: {
            status: 200,
            description: 'Attached evidence, newest first. `links` is always `[]`.',
            schema: z.object({
                links: z.array(EvidenceLinkDTOSchema),
                evidence: z.array(EvidenceListItemDTOSchema),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/evidence',
        operationId: 'linkTaskEvidence',
        summary: 'Attach a URL as evidence on a task',
        description:
            'Live and **undocumented until now** (#3080). Answers **201**, not 200, with the '
            + 'created evidence row.'
            + '\n\n**This is for a URL. A FILE goes to the multipart `/evidence/uploads` '
            + 'endpoint with a `taskId`** — that path scans the bytes before storing them, '
            + 'which this one has nothing to scan.'
            + '\n\n**`url` is narrowed to https.** It uses the repo\'s `httpsUrl()` rather '
            + 'than a bare URL string, so `http://`, `ftp://`, `data:` and `javascript:` are '
            + 'all 400s — the loose form accepts every one of them. A client offering a URL '
            + 'field should validate for https before submitting rather than surfacing a '
            + 'validation error.',
        tags: ['Tasks'],
        params: TaskParams,
        body: LinkTaskEvidenceSchema,
        extraResponses: codedErrorResponses({
            403: '`WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            404: '`TASK_NOT_FOUND` — no such task in this farm.',
        }),
        success: {
            status: 201,
            description: 'The created evidence row.',
            schema: EvidenceListItemDTOSchema,
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/evidence/{evidenceId}',
        operationId: 'unlinkTaskEvidence',
        summary: 'Detach evidence from a task',
        description:
            'Live and **undocumented until now** (#3080).'
            + '\n\nIt DETACHES rather than destroying: the evidence row survives and only its '
            + 'attachment to this task goes, which is why the verb here is unlink and not '
            + 'delete. Deleting the evidence itself is the evidence surface\'s own operation.'
            + '\n\nThe refusal is specific — `TASK_EVIDENCE_NOT_FOUND` rather than a bare '
            + '404 — so a client can tell "that evidence is not on this task" from "no such '
            + 'task".',
        tags: ['Tasks'],
        params: TaskParams.extend({
            evidenceId: z.string().openapi({ param: { name: 'evidenceId', in: 'path' } }),
        }),
        extraResponses: codedErrorResponses({
            403: '`WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            404: '`TASK_EVIDENCE_NOT_FOUND` — that evidence is not attached to this task.',
        }),
        success: {
            status: 200,
            description: 'Detached. `{ success: true }`.',
            schema: z.object({ success: z.boolean() }),
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/links/{linkId}',
        operationId: 'removeTaskLink',
        summary: 'Remove a link between a task and another record',
        description:
            'Live and **undocumented until now** (#3080). The counterpart of `POST '
            + '/tasks/{taskId}/links`.'
            + '\n\n**`linkId` is the LINK\'s id, not the linked record\'s.** The link row is '
            + 'what is removed; neither the task nor the asset, location or parcel it pointed '
            + 'at is touched.'
            + '\n\n**`taskId` is in the path and is NOT used to scope the delete** — the '
            + 'usecase takes the link id alone and resolves the tenant from the session. So a '
            + 'link id belonging to another task in the same farm is removed regardless of '
            + 'which `taskId` the path names. Tenant isolation holds; task-level scoping does '
            + 'not, which is worth knowing before building a client that relies on the path '
            + 'being checked.',
        tags: ['Tasks'],
        params: TaskParams.extend({
            linkId: z.string().openapi({ param: { name: 'linkId', in: 'path' } }),
        }),
        extraResponses: codedErrorResponses({
            403: '`WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            404: '`TASK_LINK_NOT_FOUND` — no such link in this farm.',
        }),
        success: {
            status: 200,
            description: 'Removed. `{ success: true }`.',
            schema: z.object({ success: z.boolean() }),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/activity',
        operationId: 'getTaskActivity',
        summary: 'The task\'s activity list',
        description:
            'The 50 most recent audit entries for this task, newest first. Live and '
            + '**undocumented until now** (#3080), and deliberately documented only once its '
            + 'shape was narrowed (#3264).'
            + '\n\n**It used to return much more than this.** The read `include`d the whole '
            + '`AuditLog` row plus `user.email`, and the route returned it unmapped — so '
            + 'anything passing `assertCanReadTasks`, which includes READER and the '
            + 'deliberately-confined MECHANISATOR persona, received the actor\'s email '
            + 'address, `diffJson` (before and after of a Task, whose `description` and '
            + '`resolution` are encrypted columns, at values since edited away), '
            + '`detailsJson`, `metadataJson`, `recordIds`, `details`, and the hash chain\'s '
            + '`entryHash` / `previousHash`. None of it was rendered by anything.'
            + '\n\nThe fix is in the QUERY, not a mapper: `email` is an `ENCRYPTED_FIELDS` '
            + 'column, so not selecting it means it is never decrypted. A client must not '
            + 'expect any of those fields to come back.'
            + '\n\n**`user` is null for a SYSTEM action** — `AuditLog.userId` is nullable — '
            + 'so render your own fallback label rather than treating null as an error.'
            + '\n\n**`action` is a bare string, not an enum.** `AuditEventPayload.action` is '
            + 'one too: two thirds of this codebase\'s audit writes use a domain verb rather '
            + 'than CREATE/UPDATE/DELETE, and the list is not closed. Match on the values you '
            + 'know and show the raw verb for the rest.'
            + '\n\n**The name is `User.name`, not a published profile.** This is a tenant '
            + 'surface whose readers already see each other by that name in the member list '
            + 'and the assignee picker; `PersonProfile.displayName` is an opt-in publication '
            + 'for the public social surfaces and almost nobody has made one, so requiring it '
            + 'here would render a nameless placeholder for most colleagues.',
        tags: ['Tasks'],
        params: TaskParams,
        extraResponses: codedErrorResponses({
            403: '`READ_FORBIDDEN_FOR_ROLE` — the role cannot read records at all.',
        }),
        success: {
            status: 200,
            description: 'Up to 50 activity entries, newest first.',
            schema: z.array(TaskActivityDTOSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/bulk/assign',
        operationId: 'bulkAssignTasks',
        summary: 'Assign or unassign several tasks at once',
        description:
            'Backs the tasks table\'s multi-select, beside its three siblings. Live since '
            + 'the bulk actions shipped and **undocumented until now** (#3080).'
            + '\n\n**`assigneeUserId: null` UNASSIGNS.** The field is nullable rather than '
            + 'optional on purpose: omitting it is a validation error, so a client cannot '
            + 'clear twenty assignees with a malformed body the way a missing key would.'
            + '\n\n**The assignee must be an ACTIVE member of this farm.** An invited, '
            + 'suspended or removed person is refused — as a 404 rather than a 403, because '
            + 'a 403 would confirm the id names a real person somewhere.'
            + '\n\nOnly the tasks that actually CARRY the new assignee are notified, read '
            + 'back after the write rather than assumed from the request — so a stale id in '
            + 'the selection cannot tell somebody they were given a task they were not.'
            + BULK_COUNT_AND_CAP
            + BULK_ALL_OR_NOTHING,
        tags: ['Tasks'],
        params: TenantParams,
        body: BulkTaskAssignSchema,
        extraResponses: codedErrorResponses({
            403: '`WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            404:
                '`TARGET_USER_NOT_IN_TENANT` — the `assigneeUserId` is not an ACTIVE member '
                + 'of this farm.',
        }),
        success: {
            status: 200,
            description: 'The number of tasks whose assignee was written.',
            schema: z.object({ count: z.number().int() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/bulk/status',
        operationId: 'bulkSetTaskStatus',
        summary: 'Move several tasks to a status at once',
        description:
            'Live since the bulk actions shipped and **undocumented until now** (#3080).'
            + '\n\n**The same transition rules as the single-task route, per task.** A bulk '
            + 'operation is an admin convenience, not an escape hatch: every selected row is '
            + 'checked before anything is written, and the refusal names WHICH task could '
            + 'not move.'
            + '\n\n**A terminal status needs a `resolution`.** It is sanitised BEFORE the '
            + 'emptiness check, so a resolution consisting only of markup is refused as '
            + 'missing rather than stored as a non-empty string that renders as nothing.'
            + '\n\n`resolution` is an encrypted column, so it is never echoed back — the '
            + 'response is a count.'
            + BULK_COUNT_AND_CAP
            + BULK_ALL_OR_NOTHING,
        tags: ['Tasks'],
        params: TenantParams,
        body: BulkTaskStatusSchema,
        extraResponses: codedErrorResponses({
            403: '`WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            404: '`TASK_NOT_FOUND` — one of the selected ids is not a task of this farm.',
        }),
        success: {
            status: 200,
            description: 'The number of tasks whose status was written.',
            schema: z.object({ count: z.number().int() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/bulk/due',
        operationId: 'bulkSetTaskDueDate',
        summary: 'Set or clear the due date on several tasks at once',
        description:
            'Live since the bulk actions shipped and **undocumented until now** (#3080).'
            + '\n\n**`dueAt: null` CLEARS the due date**, and the field is nullable rather '
            + 'than optional for its sibling\'s reason: omitting it is a validation error, '
            + 'so a client cannot wipe twenty due dates with a malformed body.'
            + '\n\n`dueAt` is an INSTANT, not a calendar day. A date picked in the farm\'s '
            + 'own timezone must be sent as the instant that day begins there, or a task due '
            + 'tomorrow morning locally can read as due today.'
            + BULK_COUNT_AND_CAP
            + BULK_ALL_OR_NOTHING,
        tags: ['Tasks'],
        params: TenantParams,
        body: BulkTaskDueDateSchema,
        extraResponses: codedErrorResponses({
            403: '`WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
        }),
        success: {
            status: 200,
            description: 'The number of tasks whose due date was written.',
            schema: z.object({ count: z.number().int() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/bulk/delete',
        operationId: 'bulkDeleteTasks',
        summary: 'Delete several tasks at once',
        description:
            'Backs the tasks table\'s multi-select. It has existed since #2187 and was '
            + '**live but undocumented** until now, which is how the iOS client came to miss it and '
            + 'propose building a second one (#3063) — the same way a spec gap cost that client twice '
            + 'before.'
            + '\n\n**ALL-OR-NOTHING, by owner ruling.** A refusal deletes NOTHING: every selected '
            + 'row stays intact. The reason recorded in `task.policies.ts` is that a partial success '
            + 'leaves the farmer working out which of twenty selected rows actually went, and the ones '
            + 'that went took ДНЕВНИК register lines with them. Do not design a client around partial '
            + 'results here.'
            + '\n\n**It is a SOFT delete.** `Task` is soft-deleted, so this stamps `deletedAt` rather '
            + 'than destroying rows, and task COMMENTS are untouched — no row is removed, so no cascade '
            + 'runs. Permanent removal happens later through retention. A client must not describe this '
            + 'action as permanent or irreversible.'
            + '\n\n**Authorisation is per task, not per call**, and reads the stored rows: a caller who '
            + 'is not a farm admin may delete only tasks it created. Ids the tenant does not own are '
            + 'filtered out rather than refused, so they are not something to fail over.'
            + '\n\n**Idempotent.** A repeat is harmless: already-deleted or unowned ids simply do not '
            + 'match, and an empty match returns `{ deleted: 0 }`.',
        tags: ['Tasks'],
        params: TenantParams,
        body: BulkTaskDeleteSchema,
        extraResponses: codedErrorResponses({
            403:
                'Signed in, but not permitted to delete one or more of the SELECTED tasks — so none '
                + 'were deleted.\n\n'
                + '- `TASK_DELETE_NOT_PERMITTED` — at least one selected task was created by somebody '
                + 'else and this caller is not a farm admin. `params` carries `{ refused, selected }` '
                + 'for the sentence, and **`details.refusedTaskIds` carries WHICH ids were refused** so '
                + 'a client can untick exactly those rather than make the farmer find them.\n'
                + '- `WRITE_FORBIDDEN_FOR_ROLE` — the role cannot modify records at all.',
            409:
                '`TASK_BELONGS_TO_TREATMENT` — at least one selected task is a share of a recorded '
                + 'treatment, so none were deleted; delete those treatments whole instead. Carries the '
                + 'same `params` `{ refused, selected }` and the same `details.refusedTaskIds` as the '
                + '403 above, deliberately one spelling so a client needs one parser for both '
                + 'refusals.',
        }),
        success: {
            status: 200,
            description:
                'How many tasks were soft-deleted. Equals the number of SELECTED ids that existed and '
                + 'belonged to this tenant, which may be fewer than were sent.',
            schema: z.object({ deleted: z.number().int() }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/links',
        operationId: 'createTaskLink',
        summary: 'Link a task to another entity',
        description:
            'The pair `(entityType, entityId)` is UNIQUE per task — the constraint is ' +
            '`(tenantId, taskId, entityType, entityId)` — so re-linking the same entity is a conflict ' +
            'rather than a second row. Linking is not validated against the target existing: the link ' +
            'is a loose reference, so an `entityId` that names nothing is accepted and simply resolves ' +
            'to nothing on read.',
        tags: ['Tasks'],
        params: TaskParams,
        body: AddTaskLinkSchema,
        success: { status: 201, description: 'The created link.', schema: TaskLinkDTOSchema },
    });
}
