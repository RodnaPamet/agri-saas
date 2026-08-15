import { RequestContext } from '../types';
import { WorkItemRepository, TaskLinkRepository, TaskCommentRepository, TaskWatcherRepository, TaskFilters, TaskListParams } from '../repositories/WorkItemRepository';
import { assertCanReadTasks, assertCanWriteTasks, assertCanCommentOnTasks } from '../policies/task.policies';
import { logEvent } from '../events/audit';
import { emitAutomationEvent } from '../automation';
import { enqueueEmail } from '../notifications/enqueue';
import { createTaskDueNotification } from '../notifications/task-due';
import { createAssignmentNotification } from '../notifications/assignment';
import { sendWebPushToUser } from '@/lib/notifications/web-push';
import { runInTenantContext } from '@/lib/db-context';
import { env } from '@/env';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { validateTaskMetadata } from '../schemas/json-columns.schemas';
import { logger } from '@/lib/observability/logger';
import { cachedListRead, bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import type { PrismaTx } from '@/lib/db-context';
import {
    checkWorkItemTransition,
    formatTransitionError,
    isTerminalStatus,
} from '../domain/work-item-status';
import { getSlaStatus } from '../services/sla';

// GRC teardown phase 2 (operator decision A6). `validateTypeRelevance`
// lived here: AUDIT_FINDING / PRACTICE_GAP had to carry a practiceId or a
// PRACTICE / FRAMEWORK_REQUIREMENT link, and INCIDENT an ASSET / PRACTICE
// one, checked on the move to RESOLVED / CLOSED. All three task types are
// gone and so are Practice and FrameworkRequirement, and the surviving
// TASK / IMPROVEMENT returned on the function's first line — so it was a
// total no-op, not a shrunken rule.

// ─── List / Get ───

export async function listTasks(
    ctx: RequestContext,
    filters: TaskFilters = {},
    options: { take?: number } = {},
) {
    assertCanReadTasks(ctx);
    return cachedListRead({
        ctx,
        entity: 'task',
        operation: 'list',
        // `take` must be in the cache key — bounded and unbounded
        // results have different shapes; sharing a key would let a
        // bounded SSR fetch poison the unbounded API GET cache.
        params: options.take ? { ...filters, _take: options.take } : filters,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                WorkItemRepository.list(db, ctx, filters, options),
            ),
    });
}

export async function listTasksPaginated(ctx: RequestContext, params: TaskListParams) {
    assertCanReadTasks(ctx);
    return cachedListRead({
        ctx,
        entity: 'task',
        operation: 'listPaginated',
        params,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                WorkItemRepository.listPaginated(db, ctx, params),
            ),
    });
}

export async function getTask(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await WorkItemRepository.getById(db, ctx, taskId);
        if (!task) throw notFound('Task not found');
        // Audit Coherence S8 (2026-05-24) — attach the derived SLA
        // status alongside the raw row. The service is pure (severity
        // + createdAt + currentStatus); no extra query, no schema
        // column. Frontend reads `sla.label` to render the breach
        // pill; auditors see triage vs resolve breach booleans.
        return {
            ...task,
            sla: getSlaStatus(task.severity, task.createdAt, task.status),
        };
    });
}

// ─── Create ───

export async function createTask(ctx: RequestContext, input: {
    title: string;
    type?: string;
    description?: string | null;
    severity?: string;
    priority?: string;
    source?: string;
    dueAt?: string | null;
    assigneeUserId?: string | null;
    reviewerUserId?: string | null;
    clientMutationId?: string | null;
    metadataJson?: unknown;
}) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // Validate metadataJson on write
        if (input.metadataJson !== undefined) {
            input.metadataJson = validateTaskMetadata(input.metadataJson);
        }
        const task = await WorkItemRepository.create(db, ctx, input);

        await logEvent(db, ctx, {
            action: 'TASK_CREATED',
            entityType: 'Task',
            entityId: task.id,
            details: `Created task ${task.key}: ${task.title}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'created', summary: 'TASK_CREATED' },
            metadata: { type: input.type, severity: input.severity, priority: input.priority },
        });

        await emitAutomationEvent(ctx, {
            event: 'TASK_CREATED',
            entityType: 'Task',
            entityId: task.id,
            actorUserId: ctx.userId,
            stableKey: task.id,
            data: {
                key: task.key,
                title: task.title,
                type: task.type,
                severity: task.severity,
                priority: task.priority,
                assigneeUserId: task.assigneeUserId,
            },
        });

        // Enqueue email to assignee if set
        if (input.assigneeUserId) {
            await enqueueTaskAssignedNotification(db, ctx, task.id, task.title, task.key, input.type || 'TASK', input.assigneeUserId);
        }

        return task;
    });
    // In-app TASK_DUE notification if the new task is already assigned
    // and due within a reminder window. Runs AFTER the task
    // transaction commits — see `emitTaskDueNotification`.
    await emitTaskDueNotification(ctx, result);
    // PR-A 2026-05-27 — also fire the in-app TASK_ASSIGNED bell.
    // Pre-PR-A, only the email path ran on create-with-assignee, so
    // the bell stayed silent until the task entered a due-window.
    if (result.assigneeUserId) {
        await emitTaskAssignedNotification(ctx, result);
    }
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Update ───

export async function updateTask(ctx: RequestContext, taskId: string, patch: {
    title?: string;
    description?: string | null;
    type?: string;
    severity?: string;
    priority?: string;
    dueAt?: string | null;
    reviewerUserId?: string | null;
    metadataJson?: unknown;
}) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // Validate metadataJson on write
        if (patch.metadataJson !== undefined) {
            patch.metadataJson = validateTaskMetadata(patch.metadataJson);
        }
        const task = await WorkItemRepository.update(db, ctx, taskId, patch);
        if (!task) throw notFound('Task not found');
        await logEvent(db, ctx, {
            action: 'TASK_UPDATED',
            entityType: 'Task',
            entityId: taskId,
            details: 'Updated task fields',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'updated', summary: 'TASK_UPDATED' },
            metadata: patch,
        });
        return task;
    });
    // A rescheduled `dueAt` may move the task into a reminder window —
    // re-evaluate the in-app notification after the commit.
    await emitTaskDueNotification(ctx, result);
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Delete ───
//
// Hard delete. The Task model's child rows (TaskComment / TaskLink /
// TaskWatcher) all cascade via `onDelete: Cascade`, so removing the
// task row cleans up its comments, entity links, and watchers in one
// statement. Gated on write permission (same tier as edit) and audited.
export async function deleteTask(ctx: RequestContext, taskId: string) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const existing = await WorkItemRepository.getById(db, ctx, taskId);
        if (!existing) throw notFound('Task not found');
        await db.task.delete({ where: { id: taskId } });
        await logEvent(db, ctx, {
            action: 'TASK_DELETED',
            entityType: 'Task',
            entityId: taskId,
            details: `Deleted task: ${existing.title}`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'deleted', summary: 'TASK_DELETED' },
            metadata: { title: existing.title, type: existing.type },
        });
        return { id: taskId };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

/**
 * Bulk soft-delete tasks — the tasks table selection action-row. Mirrors
 * {@link deleteTask}: write-gated, soft-delete (Task ∈ SOFT_DELETE_MODELS),
 * tenant-scoped, one TASK_DELETED audit row per task. Idempotent.
 */
export async function bulkDeleteTask(
    ctx: RequestContext,
    taskIds: string[],
): Promise<{ deleted: number }> {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const rows = await db.task.findMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            select: { id: true, title: true, type: true },
        });
        if (rows.length === 0) return { deleted: 0 };

        await db.task.deleteMany({
            where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId },
        });

        for (const t of rows) {
            await logEvent(db, ctx, {
                action: 'TASK_DELETED',
                entityType: 'Task',
                entityId: t.id,
                details: `Deleted task: ${t.title} (bulk)`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'deleted', summary: 'TASK_DELETED' },
                metadata: { title: t.title, type: t.type },
            });
        }
        return { deleted: rows.length };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Status ───

export async function setTaskStatus(ctx: RequestContext, taskId: string, status: string, resolution?: string | null) {
    const result = await runInTenantContext(ctx, async (db) => {
        // Pre-fetch once so we can both validate + capture fromStatus
        // for the automation event.
        const existing = await WorkItemRepository.getById(db, ctx, taskId);
        if (!existing) throw notFound('Task not found');

        // Authorization. Task-write permission is the general gate, BUT an
        // operator ASSIGNED to a task may change its status without general
        // write — a restricted MECHANISATOR (or any low-privilege assignee)
        // must be able to complete their own farm tasks. This mirrors the
        // assignee self-serve rule already applied to FIELD_OPERATION parcel
        // marking in `markOperationParcel`.
        const isAssignee = !!ctx.userId && existing.assigneeUserId === ctx.userId;
        if (!ctx.permissions.canWrite && !isAssignee) {
            assertCanWriteTasks(ctx); // throws the canonical 403 for non-assignees
        }

        const fromStatus = existing.status;

        // Audit Coherence S8 (2026-05-24) — state-machine gate runs
        // BEFORE the type-relevance check. Catches no-op + illegal
        // shapes (e.g. CLOSED → OPEN re-open, CANCELED → IN_PROGRESS,
        // OPEN → CLOSED skipping RESOLVED) so the only paths that
        // reach the repository write are documented transitions.
        const transitionErr = checkWorkItemTransition(fromStatus, status);
        if (transitionErr) throw badRequest(formatTransitionError(transitionErr));

        // Audit Coherence S8 — every terminal write requires a non-
        // empty `resolution` text. The auditor reads it from the
        // audit-log row + the task body; "closed without why" was
        // a recurring SOC 2 review finding.
        if (isTerminalStatus(status)) {
            const trimmed = (resolution ?? '').trim();
            if (!trimmed) {
                throw badRequest(
                    `A resolution is required when moving a task to ${status}.`,
                );
            }
            resolution = trimmed;
        }

        const task = await WorkItemRepository.setStatus(db, ctx, taskId, status, resolution);
        if (!task) throw notFound('Task not found');
        await logEvent(db, ctx, {
            action: 'TASK_STATUS_CHANGED',
            entityType: 'Task',
            entityId: taskId,
            details: `Status changed to ${status}`,
            // Audit Coherence S8 — write the REAL fromStatus + toStatus.
            // Pre-S8 these were hardcoded to (null, 'TASK_STATUS_CHANGED')
            // which left the audit row useless for "did this row pass
            // through TRIAGED?" queries that auditors regularly run.
            detailsJson: {
                category: 'status_change',
                entityName: 'Task',
                fromStatus,
                toStatus: status,
            },
            metadata: { status, resolution },
        });
        await emitAutomationEvent(ctx, {
            event: 'TASK_STATUS_CHANGED',
            entityType: 'Task',
            entityId: taskId,
            actorUserId: ctx.userId,
            stableKey: `${taskId}:${fromStatus}:${status}`,
            data: {
                fromStatus,
                toStatus: status,
                resolution: resolution ?? null,
            },
        });
        return task;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Assign ───

export async function assignTask(ctx: RequestContext, taskId: string, assigneeUserId: string | null) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const task = await WorkItemRepository.assign(db, ctx, taskId, assigneeUserId);
        if (!task) throw notFound('Task not found');
        await logEvent(db, ctx, {
            action: 'TASK_ASSIGNED',
            entityType: 'Task',
            entityId: taskId,
            details: assigneeUserId ? `Assigned to ${assigneeUserId}` : 'Unassigned',
            detailsJson: { category: 'custom', event: 'task_assigned' },
            metadata: { assigneeUserId },
        });

        // Enqueue email to new assignee
        if (assigneeUserId) {
            await enqueueTaskAssignedNotification(db, ctx, taskId, task.title, task.key, task.type, assigneeUserId);
        }
        return task;
    });
    // In-app TASK_DUE notification for the new assignee if the task
    // is due within a reminder window — after the commit.
    await emitTaskDueNotification(ctx, result);
    // PR-A 2026-05-27 — in-app TASK_ASSIGNED bell notification.
    // Mirrors the email path that's already wired in
    // `enqueueTaskAssignedNotification` above; this one routes the
    // alert to the notification bell so the assignee sees it
    // without waiting for the daily digest.
    if (result.assigneeUserId) {
        await emitTaskAssignedNotification(ctx, result);
    }
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

/** Look up assignee email and enqueue TASK_ASSIGNED notification */
async function enqueueTaskAssignedNotification(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    taskTitle: string,
    taskKey: string | null | undefined,
    taskType: string,
    assigneeUserId: string,
): Promise<void> {
    try {
        const assignee = await db.user.findUnique({
            where: { id: assigneeUserId },
            select: { email: true, name: true },
        });
        if (!assignee?.email) return;

        const assigner = await db.user.findUnique({
            where: { id: ctx.userId },
            select: { name: true, email: true },
        });

        await enqueueEmail(db, {
            tenantId: ctx.tenantId,
            type: 'TASK_ASSIGNED',
            toEmail: assignee.email,
            entityId: taskId,
            requestId: ctx.requestId,
            payload: {
                taskTitle,
                taskKey,
                taskType,
                assigneeName: assignee.name || assignee.email,
                // Who assigned it — name, or email as a fallback so the
                // "assigned by …" line always shows.
                assignerName: assigner?.name || assigner?.email || undefined,
                tenantSlug: ctx.tenantSlug || '',
            },
        });
    } catch (err) {
        // Fire-and-forget — never break the task operation
        logger.warn('failed to enqueue task assignment email', { component: 'notifications' });
    }
}

/**
 * Fire the in-app `TASK_DUE` notification the moment a task is
 * created / rescheduled / assigned, so a near-term deadline reaches
 * the notification bell immediately — instead of waiting on the
 * daily 08:00 `task-due-notification` cron (which also depends on
 * the scheduler having registered the repeatable).
 *
 * Runs AFTER the task's own transaction has committed, in its own
 * short `runInTenantContext` transaction. It must NOT share the
 * caller's transaction:
 *   - A notification write must never roll back the task write — the
 *     task is the user's intent; the notification is a side effect.
 *   - `createTaskDueNotification` is idempotent via `ON CONFLICT DO
 *     NOTHING` (it shares the cron's `dedupeKey`), but isolating it
 *     in its own transaction also keeps any genuine DB error off the
 *     task transaction entirely.
 * Fully fire-and-forget — any failure is logged and swallowed.
 */
async function emitTaskDueNotification(
    ctx: RequestContext,
    task: {
        id: string;
        tenantId: string;
        title: string;
        key: string | null;
        dueAt: Date | null;
        assigneeUserId: string | null;
    },
): Promise<void> {
    if (!task.assigneeUserId || !task.dueAt || !ctx.tenantSlug) return;
    // Hoist the narrowed values — the closure below would otherwise
    // see the wider nullable property types.
    const tenantSlug = ctx.tenantSlug;
    const assigneeUserId = task.assigneeUserId;
    const dueAt = task.dueAt;
    try {
        await runInTenantContext(ctx, (db) =>
            createTaskDueNotification(
                db,
                {
                    id: task.id,
                    tenantId: task.tenantId,
                    tenantSlug,
                    title: task.title,
                    key: task.key,
                    dueAt,
                    assigneeUserId,
                },
                new Date(),
                // Classify in the same zone as the daily cron so the
                // event-driven and steady-state paths agree on the
                // window + dedupeKey for a task due near local midnight.
                env.NOTIFICATIONS_TZ,
            ),
        );
    } catch (err) {
        logger.warn('failed to create task-due notification', {
            component: 'notifications',
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * PR-A 2026-05-27 — in-app `TASK_ASSIGNED` bell notification.
 *
 * Pre-PR-A only the email path fired (`enqueueTaskAssignedNotification`
 * → `NotificationOutbox`), so the assignee saw the alert in their
 * inbox but never on the notification bell. This sibling routes the
 * same trigger into the `Notification` table.
 *
 * Same fire-and-forget posture as `emitTaskDueNotification`:
 *   - Runs AFTER the task transaction commits.
 *   - Its own short `runInTenantContext` — a notification write
 *     must never roll back the task.
 *   - `createAssignmentNotification` is idempotent via the
 *     `(tenantId, TASK_ASSIGNED, taskId, userId, date)` dedupeKey
 *     so a rapid sequence of assign-toggles within one day
 *     collapses to a single bell entry.
 */
async function emitTaskAssignedNotification(
    ctx: RequestContext,
    task: {
        id: string;
        tenantId: string;
        title: string;
        key: string | null;
        assigneeUserId: string | null;
    },
): Promise<void> {
    if (!task.assigneeUserId || !ctx.tenantSlug) return;
    const tenantSlug = ctx.tenantSlug;
    const assigneeUserId = task.assigneeUserId;
    try {
        const outcome = await runInTenantContext(ctx, (db) =>
            createAssignmentNotification(db, 'TASK_ASSIGNED', {
                tenantId: task.tenantId,
                assigneeUserId,
                entityId: task.id,
                entityLabel: task.title,
                entityKey: task.key,
                tenantSlug,
            }),
        );
        // Fan the fresh assignment out to Web Push (no-op when push isn't
        // configured or the assignee hasn't subscribed). Awaited but
        // best-effort — done OUTSIDE the notification tx so the network send
        // never holds a transaction open. Skip duplicates (already pushed).
        if (outcome.status === 'created' && outcome.notification) {
            await sendWebPushToUser(ctx, assigneeUserId, {
                title: outcome.notification.title,
                body: outcome.notification.message,
                url: outcome.notification.linkUrl,
                tag: `task-${task.id}`,
            });
        }
    } catch (err) {
        logger.warn('failed to create task-assigned notification', {
            component: 'notifications',
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ─── Links ───

export async function listTaskLinks(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) => TaskLinkRepository.listByTask(db, ctx, taskId));
}

export async function addTaskLink(ctx: RequestContext, taskId: string, entityType: string, entityId: string, relation?: string) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const link = await TaskLinkRepository.link(db, ctx, taskId, entityType, entityId, relation);
        await logEvent(db, ctx, {
            action: 'TASK_LINKED',
            entityType: 'Task',
            entityId: taskId,
            details: `Linked to ${entityType} ${entityId}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Task' },
            metadata: { entityType, entityId, relation },
        });
        return link;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

export async function removeTaskLink(ctx: RequestContext, linkId: string) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const result = await TaskLinkRepository.unlink(db, ctx, linkId);
        if (!result) throw notFound('Task link not found');
        await logEvent(db, ctx, {
            action: 'TASK_UNLINKED',
            entityType: 'Task',
            entityId: linkId,
            details: 'Removed task link',
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Task' },
        });
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── Evidence ───
//
// Task evidence mirrors the practice Evidence tab. A task attaches
// Evidence entities directly via `Evidence.taskId` (no separate link
// table — unlike practices, which carry a PracticeEvidenceLink bridge).
// The shared <EvidenceSubTable> renders the `{ links, evidence }`
// payload identically; for tasks `links` is always empty.

/**
 * Task Evidence tab payload — same `{ links, evidence }` shape the
 * practice Evidence tab returns, so the shared sub-table can render it
 * unchanged.
 */
export async function getTaskEvidenceTab(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!task) throw notFound('Task not found');
        const evidence = await db.evidence.findMany({
            where: { taskId, tenantId: ctx.tenantId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        return { links: [], evidence };
    });
}

/**
 * Attach a URL as evidence on a task — mirrors the practice "+ Evidence"
 * URL path. Creates a LINK-type Evidence row pointing at the task. File
 * uploads go through `/evidence/uploads` (uploadEvidenceFile) with a
 * `taskId`, exactly like practices.
 */
export async function linkTaskEvidence(
    ctx: RequestContext,
    taskId: string,
    data: { url: string; note?: string | null },
) {
    assertCanWriteTasks(ctx);
    const url = data.url.trim();
    const note = data.note ? sanitizePlainText(data.note) : null;
    const result = await runInTenantContext(ctx, async (db) => {
        const task = await db.task.findFirst({
            where: { id: taskId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!task) throw notFound('Task not found');
        const evidence = await db.evidence.create({
            data: {
                tenantId: ctx.tenantId,
                taskId,
                type: 'LINK',
                title: note || url,
                content: url,
                status: 'DRAFT',
                ownerUserId: ctx.userId,
            },
        });
        await logEvent(db, ctx, {
            action: 'TASK_EVIDENCE_LINKED',
            entityType: 'Task',
            entityId: taskId,
            details: `Evidence linked: ${url}`,
            detailsJson: { category: 'relationship', operation: 'linked', sourceEntity: 'Task', sourceId: taskId, targetEntity: 'Evidence', targetId: evidence.id, relation: 'LINK' },
        });
        return evidence;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

/**
 * Detach evidence from a task — clears `Evidence.taskId` so the row
 * stays in the Evidence Library but no longer shows on this task's
 * Evidence tab (mirrors practice evidence unlink: the association is
 * removed, the evidence survives).
 */
export async function unlinkTaskEvidence(
    ctx: RequestContext,
    taskId: string,
    evidenceId: string,
) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, taskId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!evidence) throw notFound('Task evidence not found');
        await db.evidence.update({
            where: { id: evidenceId },
            data: { taskId: null },
        });
        await logEvent(db, ctx, {
            action: 'TASK_EVIDENCE_UNLINKED',
            entityType: 'Task',
            entityId: taskId,
            details: `Evidence unlinked: ${evidenceId}`,
            detailsJson: { category: 'relationship', operation: 'unlinked', sourceEntity: 'Task', sourceId: taskId, targetEntity: 'Evidence', targetId: evidenceId },
        });
        return { success: true };
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── Comments ───

export async function listTaskComments(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) => TaskCommentRepository.listByTask(db, ctx, taskId));
}

export async function addTaskComment(ctx: RequestContext, taskId: string, body: string) {
    assertCanCommentOnTasks(ctx);
    // Epic C.5 — comments today are plain text. Strip any HTML the
    // client tries to inject before persistence so a future renderer
    // change (Markdown, HTML preview) can never accidentally re-enable
    // a stored XSS vector.
    const safeBody = sanitizePlainText(body);
    const result = await runInTenantContext(ctx, async (db) => {
        const comment = await TaskCommentRepository.add(db, ctx, taskId, safeBody);
        await logEvent(db, ctx, {
            action: 'TASK_COMMENT_ADDED',
            entityType: 'Task',
            entityId: taskId,
            details: 'Comment added',
            detailsJson: { category: 'custom', event: 'task_comment_added' },
            metadata: { commentId: comment.id },
        });
        return comment;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

// ─── Watchers ───

export async function listTaskWatchers(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) => TaskWatcherRepository.listByTask(db, ctx, taskId));
}

export async function addTaskWatcher(ctx: RequestContext, taskId: string, userId: string) {
    assertCanWriteTasks(ctx);
    const result = await runInTenantContext(ctx, (db) => TaskWatcherRepository.add(db, ctx, taskId, userId));
    await bumpEntityCacheVersion(ctx, 'task');
    return result;
}

export async function removeTaskWatcher(ctx: RequestContext, taskId: string, userId: string) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const result = await TaskWatcherRepository.remove(db, ctx, taskId, userId);
        if (!result) throw notFound('Watcher not found');
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

// ─── Metrics ───

export async function getTaskMetrics(ctx: RequestContext) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) => WorkItemRepository.metrics(db, ctx));
}

// ─── Activity Feed ───

export async function getTaskActivity(ctx: RequestContext, taskId: string) {
    assertCanReadTasks(ctx);
    return runInTenantContext(ctx, (db) =>
        db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Task', entityId: taskId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true, email: true } } },
        })
    );
}

// ─── Bulk Actions ───

export async function bulkAssignTasks(ctx: RequestContext, taskIds: string[], assigneeUserId: string | null) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const result = await WorkItemRepository.bulkAssign(db, ctx, taskIds, assigneeUserId);
        for (const id of taskIds) {
            await logEvent(db, ctx, {
                action: 'TASK_ASSIGNED',
                entityType: 'Task',
                entityId: id,
                details: assigneeUserId ? `Bulk assigned to ${assigneeUserId}` : 'Bulk unassigned',
                detailsJson: { category: 'custom', event: 'task_assigned' },
                metadata: { assigneeUserId, bulk: true },
            });
        }
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

export async function bulkSetTaskStatus(ctx: RequestContext, taskIds: string[], status: string, resolution?: string) {
    assertCanWriteTasks(ctx);

    // Audit Coherence S8 (2026-05-24) — bulk path enforces the same
    // resolution + transition gates as the single-task path. Bulk
    // operations are an admin convenience, not an escape hatch.
    if (isTerminalStatus(status)) {
        const trimmed = (resolution ?? '').trim();
        if (!trimmed) {
            throw badRequest(
                `A resolution is required when moving a task to ${status}.`,
            );
        }
        resolution = trimmed;
    }

    const outcome = await runInTenantContext(ctx, async (db) => {
        // Pre-fetch the current state of every requested task so we
        // can (a) refuse the WHOLE batch if any row is on an illegal
        // transition (no partial writes), and (b) emit a per-row
        // audit entry with the REAL fromStatus instead of the prior
        // hardcoded null.
        const existingRows = await WorkItemRepository.listByIds(db, ctx, taskIds);
        const existingMap = new Map(existingRows.map((r) => [r.id, r.status]));

        // First pass — all-or-nothing transition validation.
        for (const id of taskIds) {
            const fromStatus = existingMap.get(id);
            if (!fromStatus) {
                throw notFound(`Task ${id} not found`);
            }
            const err = checkWorkItemTransition(fromStatus, status);
            if (err) {
                throw badRequest(
                    `Cannot bulk-transition task ${id}: ${formatTransitionError(err)}`,
                );
            }
        }

        const result = await WorkItemRepository.bulkSetStatus(db, ctx, taskIds, status, resolution);
        for (const id of taskIds) {
            const fromStatus = existingMap.get(id) ?? null;
            await logEvent(db, ctx, {
                action: 'TASK_STATUS_CHANGED',
                entityType: 'Task',
                entityId: id,
                details: `Bulk status changed to ${status}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Task',
                    fromStatus,
                    toStatus: status,
                },
                metadata: { status, resolution, bulk: true },
            });
        }
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

export async function bulkSetTaskDueDate(ctx: RequestContext, taskIds: string[], dueAt: string | null) {
    assertCanWriteTasks(ctx);
    const outcome = await runInTenantContext(ctx, async (db) => {
        const result = await WorkItemRepository.bulkSetDueDate(db, ctx, taskIds, dueAt);
        for (const id of taskIds) {
            await logEvent(db, ctx, {
                action: 'TASK_UPDATED',
                entityType: 'Task',
                entityId: id,
                details: `Bulk due date set to ${dueAt || 'none'}`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'updated', summary: 'TASK_UPDATED' },
                metadata: { dueAt, bulk: true },
            });
        }
        return result;
    });
    await bumpEntityCacheVersion(ctx, 'task');
    return outcome;
}

