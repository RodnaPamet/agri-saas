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
import { op } from './helpers';
// `TaskDTOSchema` is ALREADY the documented response shape for
// `farm-tasks.paths.ts` and `field-operations.paths.ts`, and the client
// validates with it in `use-tasks.ts`. Referencing it here is using the
// spelling this repo already trusts for the same record — not adding a third
// one, which is what the note below rightly warns against.
import {
    TaskDTOSchema,
    TaskListItemDTOSchema,
    TaskDetailDTOSchema,
    TaskCommentDTOSchema,
    TaskLinkDTOSchema,
    TaskParcelDTOSchema,
} from '@/lib/dto/task.dto';
import {
    CreateTaskSchema,
    UpdateTaskSchema,
    SetTaskStatusSchema,
    AssignTaskSchema,
    AddTaskCommentSchema,
    AddTaskLinkSchema,
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
            'server-side on write, so send plain text and expect plain text back.',
        tags: ['Tasks'],
        params: TaskParams,
        body: UpdateTaskSchema,
        success: { status: 200, description: 'The updated task.', schema: TaskDTOSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/tasks/{taskId}',
        operationId: 'deleteTask',
        summary: 'Delete a task',
        description: 'Soft delete — reads filter it out, the row survives.',
        tags: ['Tasks'],
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
