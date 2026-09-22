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
 * Request bodies are the REAL Zod schemas the routes validate with, so
 * they cannot drift from the handlers. Response bodies stay `z.unknown()`
 * with the shape in prose — a mirrored response schema is a second
 * spelling of a payload, free to drift, and the description is the honest
 * maximum for a shape nobody has pinned with a DTO yet.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';
import {
    CreateTaskSchema,
    UpdateTaskSchema,
    SetTaskStatusSchema,
    AssignTaskSchema,
    AddTaskCommentSchema,
} from '@/lib/schemas';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});
const TaskParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
    taskId: z.string().openapi({ param: { name: 'taskId', in: 'path' } }),
});

/**
 * The single most important sentence in this file.
 *
 * `GET /tasks` returns TWO DIFFERENT SHAPES, keyed differently, decided by
 * whether the request carries pagination:
 *
 *     GET /tasks              -> { rows: Task[], truncated: boolean }
 *     GET /tasks?limit=50     -> { items: Task[], pageInfo: {...} }
 *
 * `rows` and `items`. Same endpoint. A client that decodes one and then
 * adds `?limit` to the URL gets an empty list and no error, because the
 * key it is looking for is simply absent — the failure is a screen that
 * renders "no tasks" over a tenant that has hundreds.
 *
 * Note also that `/journal` splits the same way but the OTHER way round:
 * its paginated branch is `{ rows, nextCursor }`. So "the paginated
 * branch is keyed `rows`" is true there and false here. Read this per
 * endpoint; do not carry the answer across.
 */
const LIST_SHAPE_WARNING =
    'TWO RESPONSE SHAPES. Without `limit`/`cursor`: `{ rows, truncated }` — a ' +
    'backfill-capped list where `truncated: true` means rows were dropped and the ' +
    'UI must say so. With `limit` or `cursor`: `{ items, pageInfo }` — note the key ' +
    'is `items`, NOT `rows`. A client that decodes one shape and later adds `?limit` ' +
    'silently reads an absent key and renders an empty list over a full tenant. ' +
    '`/journal` splits the same way but keys its paginated branch `rows`, so the ' +
    'answer does not carry between endpoints.';

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
        success: { status: 200, description: 'Tasks — see the description for WHICH shape.', schema: z.unknown() },
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
        success: { status: 201, description: 'The created task.', schema: z.unknown() },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}',
        operationId: 'getTask',
        summary: 'Get one task',
        tags: ['Tasks'],
        params: TaskParams,
        success: { status: 200, description: 'The task.', schema: z.unknown() },
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
        success: { status: 200, description: 'The updated task.', schema: z.unknown() },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/tasks/{taskId}',
        operationId: 'deleteTask',
        summary: 'Delete a task',
        description: 'Soft delete — reads filter it out, the row survives.',
        tags: ['Tasks'],
        params: TaskParams,
        success: { status: 200, description: 'Deleted.', schema: z.unknown() },
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
        success: { status: 200, description: 'The updated task.', schema: z.unknown() },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/assign',
        operationId: 'assignTask',
        summary: 'Assign a task',
        tags: ['Tasks'],
        params: TaskParams,
        body: AssignTaskSchema,
        success: { status: 200, description: 'The updated task.', schema: z.unknown() },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/comments',
        operationId: 'listTaskComments',
        summary: 'List task comments',
        tags: ['Tasks'],
        params: TaskParams,
        success: { status: 200, description: 'Comments.', schema: z.unknown() },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/tasks/{taskId}/comments',
        operationId: 'addTaskComment',
        summary: 'Add a task comment',
        description:
            'The body is sanitised server-side at the usecase boundary (`addTaskComment` routes ' +
            'it through `sanitizeRichTextHtml`), so a literal `<` is ESCAPED rather than dropped ' +
            'and comes back as `&lt;`. A client that flattens the HTML must decode entities.',
        tags: ['Tasks'],
        params: TaskParams,
        body: AddTaskCommentSchema,
        success: { status: 201, description: 'The created comment.', schema: z.unknown() },
    });
}
