/**
 * Farm tasks — the operator's work queue, and the first screen a field
 * client opens.
 *
 * Two operations on one path, and they do NOT round-trip: the list returns
 * the narrow `taskListSelect` projection, while the create returns the full
 * Task row. A client that types its list rows from the create response will
 * find `tenantId`, `priority` and `description` missing at runtime.
 *
 * The request schema below is a MIRROR, not an import. `CreateFarmTaskSchema`
 * is declared inside `src/app/api/t/[tenantSlug]/farm-tasks/route.ts` and not
 * exported, and that module pulls in `@/app-layer/context` → prisma, which
 * spec generation cannot load (see the note in `helpers.ts`). The mirror is
 * kept field-for-field with the handler; the per-schema contract snapshot is
 * what makes a divergence visible in review.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { TaskDTOSchema } from '@/lib/dto/task.dto';
import { UserRefSchema } from '@/lib/dto/common';
import { op } from './helpers';

// A ZodObject, because that is what the generator reads to build inline
// parameters — see the note on OperationInput.params.
const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

/**
 * Wire form of the list filters.
 *
 * `assigneeUserId` and `status` are `csvIdField()` / `csvEnumField()` — a
 * SINGLE comma-joined string on the wire that the handler splits into an
 * array, because that is how the multi-select facets serialise
 * (`filterStateToUrlParams` does `values.join(',')`). Documenting them as
 * arrays would tell a client to send `?status=A&status=B`, which the handler
 * reads as the last value only.
 */
const FarmTaskListQuery = z.object({
    assigneeUserId: z
        .string()
        .optional()
        .openapi({
            param: { name: 'assigneeUserId', in: 'query' },
            description:
                'Comma-separated user ids (max 100). Overrides the default "assigned to me". ' +
                'With `scope=all` an empty value means every assignee.',
            example: 'usr_01HG7,usr_01HG8',
        }),
    status: z
        .string()
        .optional()
        .openapi({
            param: { name: 'status', in: 'query' },
            description:
                'Comma-separated WorkItemStatus members: OPEN, TRIAGED, IN_PROGRESS, BLOCKED, ' +
                'PENDING_REVIEW, RESOLVED, CLOSED, CANCELED. An unknown member is a 400 for the ' +
                'WHOLE request — a filter that silently drops a member would widen the result ' +
                'set past what the operator asked for.',
            example: 'OPEN,IN_PROGRESS',
        }),
    open: z
        .enum(['1', 'true'])
        .optional()
        .openapi({
            param: { name: 'open', in: 'query' },
            description:
                'Only the caller’s OUTSTANDING work — OPEN/TRIAGED/IN_PROGRESS/BLOCKED. Drops ' +
                'PENDING_REVIEW as well as the terminal statuses: a field operation whose ' +
                'parcels are all marked is the reviewer’s turn, not the operator’s. It is a ' +
                'PRESENCE flag once it validates — the handler tests `!== undefined`, not the ' +
                'value — but only `1` and `true` validate; anything else is a 400, so there is ' +
                'no way to send `open=0` and mean "off". Omit it instead.',
        }),
    scope: z
        .enum(['mine', 'all'])
        .optional()
        .openapi({
            param: { name: 'scope', in: 'query' },
            description:
                '`mine` (default) → tasks assigned to the caller. `all` → every FARM_TASK and ' +
                'FIELD_OPERATION in the tenant, for the manager queue.',
        }),
});

/**
 * The list projection — `taskListSelect` in `WorkItemRepository`, exactly.
 *
 * Narrower than `Task`: no `tenantId`, `description`, `priority`, `source`,
 * `resolution` or `metadataJson`. Stated as its own component rather than
 * reusing `Task` because the difference is the bug a client would otherwise
 * write.
 */
const FarmTaskListItem = z
    .object({
        id: z.string(),
        key: z.string().nullable().optional(),
        title: z.string(),
        type: z.string().openapi({ description: 'FARM_TASK or FIELD_OPERATION — the queue merges both.' }),
        severity: z.string().nullable().optional(),
        status: z.string(),
        dueAt: z.string().nullable().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
        assigneeUserId: z.string().nullable().optional(),
        assignee: UserRefSchema.nullable().optional(),
    })
    .passthrough()
    .openapi('FarmTaskListItem', {
        description:
            'One row of the operator queue. This is the `taskListSelect` projection, NOT the ' +
            'full Task returned by the create — it carries no tenantId, description, priority ' +
            'or metadataJson.',
    });

const FarmTaskCreateRequest = z
    .object({
        title: z.string().min(1).max(500),
        farmTaskType: z.string().min(1).openapi({
            description:
                'A key from the LiteFarm-derived farm-task-type catalog ' +
                '(`src/lib/agriculture/farm-task-types`). An unknown key is a 400 ' +
                '`INVALID_FARM_TASK_TYPE`.',
        }),
        description: z.string().max(5000).nullable().optional(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
        dueAt: z.string().nullable().optional(),
        assigneeUserId: z.string().nullable().optional().openapi({
            description: 'Assigning fires the existing TASK_ASSIGNED notification.',
        }),
        locationIds: z.array(z.string().min(1)).max(100).optional(),
        parcelIds: z.array(z.string().min(1)).max(100).optional(),
        equipmentIds: z.array(z.string().min(1)).max(100).optional(),
    })
    .openapi('FarmTaskCreateRequest', {
        description:
            'Create a FARM_TASK. Every id in locationIds/parcelIds/equipmentIds is checked for ' +
            'tenant ownership BEFORE the task is written, so a bad link is a 400 `INVALID_LINK` ' +
            'and never leaves an orphan task. Unknown properties are stripped.',
    });

export function registerFarmTaskPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/farm-tasks',
        operationId: 'listFarmTasks',
        summary: 'List the operator’s farm-task queue',
        description:
            'FARM_TASK + FIELD_OPERATION rows, soonest-due first (null `dueAt` sinks to the ' +
            'bottom, newest `createdAt` breaks ties), capped at 200 AFTER the merge — so a ' +
            'tenant with more than 200 open jobs sees a truncated queue with no marker saying so. ' +
            'Carries a weak ETag and honours `If-None-Match` with a 304, which is what makes ' +
            'a focus-revalidate cheap on rural LTE.',
        tags: ['Farm tasks'],
        params: TenantParams,
        query: FarmTaskListQuery,
        success: {
            status: 200,
            description: 'A flat array of queue rows (never an envelope).',
            schema: z.array(FarmTaskListItem),
        },
        extraResponses: {
            304: {
                description:
                    'Not Modified — the payload still matches the `If-None-Match` tag the client sent.',
            },
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/farm-tasks',
        operationId: 'createFarmTask',
        summary: 'Create a farm task',
        description:
            'Send `Idempotency-Key` ALWAYS, minted BEFORE the first attempt and reused on every ' +
            'retry of the same logical write — the outbox uses its queue-item id. The server ' +
            'stores it as `clientMutationId` under a unique (tenantId, clientMutationId) index, ' +
            'scoped to `type: FARM_TASK`, and returns the ORIGINAL task on a replay. Without the ' +
            'header a re-send over flaky LTE mints a SECOND task, and creation is not just a row: ' +
            'it also writes an audit event, emits TASK_CREATED and enqueues an assignee ' +
            'notification, all of which would fire twice.',
        tags: ['Farm tasks'],
        params: TenantParams,
        body: FarmTaskCreateRequest,
        success: {
            status: 201,
            description:
                'The created Task — the FULL row, wider than a list item, with `assignee` and ' +
                '`createdBy` resolved. On an idempotent replay this is the ORIGINAL task, still ' +
                '201, but read back WITHOUT those two includes — treat both as optional rather ' +
                'than assuming the shape of the first response.',
            schema: TaskDTOSchema,
        },
    });
}
