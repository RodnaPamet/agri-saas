import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma, WorkItemStatus, WorkItemType, WorkItemSeverity, WorkItemPriority, WorkItemSource, TaskLinkEntityType, TaskLinkRelation } from '@prisma/client';
import { buildCursorWhere, CURSOR_ORDER_BY, computePageInfo, clampLimit } from '@/lib/pagination';
import type { PaginatedResponse } from '@/lib/dto/pagination';
import {
    TERMINAL_WORK_ITEM_STATUSES,
    COMPLETED_WORK_ITEM_STATUSES,
    isTerminalStatus,
    isCompletedStatus,
} from '../domain/work-item-status';

// ─── Filters ───

export interface TaskFilters {
    status?: string;
    type?: string;
    severity?: string;
    priority?: string;
    assigneeUserId?: string;
    controlId?: string;
    due?: 'overdue' | 'next7d';
    q?: string;
    linkedEntityType?: string;
    linkedEntityId?: string;
}

export interface TaskListParams {
    limit?: number;
    cursor?: string;
    filters?: TaskFilters;
}

// PR-9 — tight SELECT shape for the Tasks list page. Mirrors the
// per-entity trims that PR-3 landed on the other seven list-page
// repos. The previous `include: { assignee, createdBy, _count }`
// returned all Task scalars (incl. encrypted-at-rest `description`
// and `metadataJson`) plus three `_count` correlated subqueries the
// list view never reads (the TasksClient never references
// `_count.{links,comments,watchers}`). Detail (getById) keeps the
// wider shape on purpose.
const taskListSelect = {
    id: true,
    key: true,
    title: true,
    type: true,
    severity: true,
    status: true,
    dueAt: true,
    createdAt: true,
    updatedAt: true,
    assigneeUserId: true,
    assignee: { select: { id: true, name: true, email: true } },
} as const;

// ─── Task Repository ───

export class WorkItemRepository {
    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: TaskFilters = {},
        options: { take?: number } = {},
    ) {
        const where = WorkItemRepository._buildWhere(ctx, filters);
        return db.task.findMany({
            where,
            orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
            select: taskListSelect,
            ...(options.take ? { take: options.take } : {}),
        });
    }

    /**
     * Raw timestamp rows backing the dashboard "tasks — created vs
     * completed" trend. Returns just `{ createdAt, completedAt }` for every
     * farm task (FARM_TASK + FIELD_OPERATION) CREATED or COMPLETED since
     * `since`; the usecase buckets them into daily counts. Tenant-scoped
     * (RLS + explicit `tenantId`). `completedAt` is only set on RESOLVED /
     * CLOSED (never CANCELED — see `COMPLETED_WORK_ITEM_STATUSES` and the
     * `setStatus` write below, which is what makes this true), so a
     * non-null `completedAt` is exactly "completed work" and this query
     * needs no status predicate of its own. Bounded by a hard `take` — a
     * single farm's N-day task volume sits far below it; the cap only
     * guards the dashboard read against a pathological tenant.
     */
    static async farmTaskTrendRows(db: PrismaTx, ctx: RequestContext, since: Date) {
        return db.task.findMany({
            where: {
                tenantId: ctx.tenantId,
                type: { in: [WorkItemType.FARM_TASK, WorkItemType.FIELD_OPERATION] },
                OR: [{ createdAt: { gte: since } }, { completedAt: { gte: since } }],
            },
            select: { createdAt: true, completedAt: true },
            take: 5000,
        });
    }

    /**
     * Total + completed count of the unified tasks linked to a control,
     * using the SAME where-shape the LinkedTasksPanel list renders
     * (TaskLink with entityType=CONTROL OR the direct `Task.controlId`
     * FK). Backs the control header's Tasks-tab badge + Overview
     * progress so they reflect the table — not the legacy `ControlTask`
     * relation count, which diverged after the work-item unification.
     *
     * "Completed" is `COMPLETED_WORK_ITEM_STATUSES` — RESOLVED or CLOSED.
     * A CANCELED task is terminal but not completed work, so it doesn't
     * count toward progress.
     */
    static async countLinkedToControl(
        db: PrismaTx,
        ctx: RequestContext,
        controlId: string,
    ): Promise<{ total: number; done: number }> {
        const where = WorkItemRepository._buildWhere(ctx, {
            linkedEntityType: 'CONTROL',
            linkedEntityId: controlId,
        });
        const [total, done] = await Promise.all([
            db.task.count({ where }),
            db.task.count({
                where: {
                    AND: [
                        where,
                        { status: { in: [...COMPLETED_WORK_ITEM_STATUSES] as WorkItemStatus[] } },
                    ],
                },
            }),
        ]);
        return { total, done };
    }

    /**
     * Batched version of `countLinkedToControl` for the controls LIST.
     * Returns a `controlId → { total, done }` map using the SAME
     * linkage rule (TaskLink with entityType=CONTROL OR the direct
     * `Task.controlId` FK), deduped by task id so a task linked BOTH
     * ways counts once. Two indexed queries — NOT an N+1 over controls
     * — so the list-page Tasks column reflects the real linked-task
     * count instead of the legacy `ControlTask` relation (which read
     * 0/0 for unified tasks).
     */
    static async countLinkedToControls(
        db: PrismaTx,
        ctx: RequestContext,
        controlIds: string[],
    ): Promise<Map<string, { total: number; done: number }>> {
        const result = new Map<string, { total: number; done: number }>();
        if (controlIds.length === 0) return result;

        // controlId → (taskId → status). The inner map dedupes a task
        // that is linked to the same control via both paths.
        const perControl = new Map<string, Map<string, string>>();
        const add = (controlId: string, taskId: string, status: string) => {
            let m = perControl.get(controlId);
            if (!m) {
                m = new Map();
                perControl.set(controlId, m);
            }
            m.set(taskId, status);
        };

        // Direct FK. Bounded by controlIds; counting needs every match.
        const direct = await db.task.findMany({ // guardrail-allow: unbounded -- aggregate count, bounded by the controlIds set
            where: { tenantId: ctx.tenantId, controlId: { in: controlIds } },
            select: { id: true, controlId: true, status: true },
        });
        for (const t of direct) {
            if (t.controlId) add(t.controlId, t.id, t.status);
        }

        // Generic TaskLink path (the control-tab create flow links via
        // TaskLink, not the FK). Indexed by [tenantId, entityType, entityId].
        const links = await db.taskLink.findMany({ // guardrail-allow: unbounded -- aggregate count, bounded by the controlIds set
            where: {
                tenantId: ctx.tenantId,
                entityType: 'CONTROL' as TaskLinkEntityType,
                entityId: { in: controlIds },
            },
            select: {
                entityId: true,
                taskId: true,
                task: { select: { status: true } },
            },
        });
        for (const l of links) {
            add(l.entityId, l.taskId, l.task.status);
        }

        for (const [controlId, taskMap] of perControl) {
            let done = 0;
            for (const status of taskMap.values()) {
                if (isCompletedStatus(status)) done++;
            }
            result.set(controlId, { total: taskMap.size, done });
        }
        return result;
    }

    /**
     * B7 (2026-06-07) — generic batched linked-task counter for entities
     * that link tasks ONLY via TaskLink (no direct FK) — Asset, Risk, … .
     * Returns an `entityId → { total, done }` map. ONE indexed query over
     * [tenantId, entityType, entityId]; NOT an N+1 over the entity list.
     * (Controls carry an extra direct-`Task.controlId` FK path, so they keep
     * their own `countLinkedToControls`.) `done` = RESOLVED|CLOSED, matching
     * the controls column.
     */
    static async countLinkedToEntities(
        db: PrismaTx,
        ctx: RequestContext,
        entityType: TaskLinkEntityType,
        entityIds: string[],
    ): Promise<Map<string, { total: number; done: number }>> {
        const result = new Map<string, { total: number; done: number }>();
        if (entityIds.length === 0) return result;

        // entityId → (taskId → status), dedup by task id.
        const perEntity = new Map<string, Map<string, string>>();
        const links = await db.taskLink.findMany({ // guardrail-allow: unbounded -- aggregate count, bounded by the entityIds set
            where: {
                tenantId: ctx.tenantId,
                entityType,
                entityId: { in: entityIds },
            },
            select: {
                entityId: true,
                taskId: true,
                task: { select: { status: true } },
            },
        });
        for (const l of links) {
            let m = perEntity.get(l.entityId);
            if (!m) {
                m = new Map();
                perEntity.set(l.entityId, m);
            }
            m.set(l.taskId, l.task.status);
        }
        for (const [entityId, taskMap] of perEntity) {
            let done = 0;
            for (const status of taskMap.values()) {
                if (isCompletedStatus(status)) done++;
            }
            result.set(entityId, { total: taskMap.size, done });
        }
        return result;
    }

    static async listPaginated(db: PrismaTx, ctx: RequestContext, params: TaskListParams): Promise<PaginatedResponse<unknown>> {
        const limit = clampLimit(params.limit);
        const where = WorkItemRepository._buildWhere(ctx, params.filters);

        const cursorWhere = buildCursorWhere(params.cursor);
        if (cursorWhere) {
            if (where.AND) {
                (where.AND as Prisma.TaskWhereInput[]).push(cursorWhere as Prisma.TaskWhereInput);
            } else {
                where.AND = [cursorWhere as Prisma.TaskWhereInput];
            }
        }

        const items = await db.task.findMany({
            where,
            orderBy: CURSOR_ORDER_BY,
            take: limit + 1,
            select: taskListSelect,
        });

        const { trimmedItems, nextCursor, hasNextPage } = computePageInfo(items, limit);
        return { items: trimmedItems, pageInfo: { nextCursor, hasNextPage } };
    }

    private static _buildWhere(ctx: RequestContext, filters: TaskFilters = {}): Prisma.TaskWhereInput {
        const where: Prisma.TaskWhereInput = { tenantId: ctx.tenantId };
        const and: Prisma.TaskWhereInput[] = [];

        if (filters.status) where.status = filters.status as WorkItemStatus;
        if (filters.type) where.type = filters.type as WorkItemType;
        if (filters.severity) where.severity = filters.severity as WorkItemSeverity;
        if (filters.priority) where.priority = filters.priority as WorkItemPriority;
        if (filters.assigneeUserId) where.assigneeUserId = filters.assigneeUserId;
        if (filters.controlId) where.controlId = filters.controlId;
        if (filters.due === 'overdue') {
            where.dueAt = { lt: new Date() };
            if (!filters.status) where.status = { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] };
        } else if (filters.due === 'next7d') {
            const now = new Date();
            const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            where.dueAt = { gte: now, lte: in7 };
            if (!filters.status) where.status = { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] };
        }
        if (filters.q) {
            and.push({
                OR: [
                    { title: { contains: filters.q, mode: 'insensitive' } },
                    { key: { contains: filters.q, mode: 'insensitive' } },
                ],
            });
        }
        if (filters.linkedEntityType && filters.linkedEntityId) {
            const viaLink: Prisma.TaskWhereInput = {
                links: {
                    some: {
                        entityType: filters.linkedEntityType as TaskLinkEntityType,
                        entityId: filters.linkedEntityId,
                    },
                },
            };
            if (filters.linkedEntityType === 'CONTROL') {
                // A task is linked to a control via EITHER the generic
                // TaskLink OR the direct `Task.controlId` FK. The latter
                // is what pack install and the task-create form set, and
                // it's what the task's OWN view shows as its linked
                // control — so the control's Tasks tab must mirror it.
                // Without this, pack-installed tasks (controlId set, no
                // TaskLink row) never appear in the control's Tasks tab.
                and.push({
                    OR: [viaLink, { controlId: filters.linkedEntityId }],
                });
            } else {
                and.push(viaLink);
            }
        }

        if (and.length) where.AND = and;
        return where;
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.task.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                reviewer: { select: { id: true, name: true, email: true } },
                control: { select: { id: true, code: true, name: true } },
                links: { orderBy: { createdAt: 'desc' } },
                comments: {
                    orderBy: { createdAt: 'asc' },
                    include: { createdBy: { select: { id: true, name: true, email: true } } },
                },
                watchers: {
                    include: { user: { select: { id: true, name: true, email: true } } },
                },
                _count: { select: { links: true, comments: true, watchers: true, evidence: true } },
            },
        });
    }

    static async create(db: PrismaTx, ctx: RequestContext, data: {
        title: string;
        type?: string;
        description?: string | null;
        severity?: string;
        priority?: string;
        source?: string;
        dueAt?: string | null;
        assigneeUserId?: string | null;
        reviewerUserId?: string | null;
        controlId?: string | null;
        // Offline exactly-once handle (outbox-item id). Dedupe key for a
        // replayed FIELD_OPERATION create — see the Task.clientMutationId note.
        clientMutationId?: string | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caller-supplied JSON blob from Zod parse, typed as any at the usecase boundary
        metadataJson?: any;
    }) {
        // #102 item 2 — mint the `TSK-N` key from an atomic
        // per-tenant counter. The upsert compiles to a native
        // `INSERT … ON CONFLICT DO UPDATE`, so the increment is
        // race-free even under concurrent imports — unlike the
        // prior `db.task.count()` derivation, which raced the
        // unique `[tenantId, key]` index and scaled linearly with
        // tenant size.
        const seq = await db.taskKeySequence.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, lastValue: 1 },
            update: { lastValue: { increment: 1 } },
        });
        const key = `TSK-${seq.lastValue}`;

        return db.task.create({
            data: {
                tenantId: ctx.tenantId,
                key,
                title: data.title,
                description: data.description || null,
                type: (data.type as WorkItemType) ?? WorkItemType.TASK,
                severity: (data.severity as WorkItemSeverity) ?? WorkItemSeverity.MEDIUM,
                priority: (data.priority as WorkItemPriority) ?? WorkItemPriority.P2,
                source: (data.source as WorkItemSource) ?? WorkItemSource.MANUAL,
                dueAt: data.dueAt ? new Date(data.dueAt) : null,
                assigneeUserId: data.assigneeUserId || null,
                reviewerUserId: data.reviewerUserId || null,
                controlId: data.controlId || null,
                clientMutationId: data.clientMutationId || null,
                createdByUserId: ctx.userId,
                metadataJson: data.metadataJson != null ? data.metadataJson : Prisma.JsonNull,
            },
            include: {
                assignee: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });
    }

    static async update(db: PrismaTx, ctx: RequestContext, id: string, data: {
        title?: string;
        description?: string | null;
        type?: string;
        severity?: string;
        priority?: string;
        dueAt?: string | null;
        controlId?: string | null;
        reviewerUserId?: string | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caller-supplied JSON blob from Zod parse, typed as any at the usecase boundary
        metadataJson?: any;
    }) {
        const existing = await db.task.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        const updateData: Prisma.TaskUncheckedUpdateInput = {
            ...(data.title !== undefined && { title: data.title }),
            ...(data.description !== undefined && { description: data.description }),
            ...(data.type !== undefined && { type: data.type as WorkItemType }),
            ...(data.severity !== undefined && { severity: data.severity as WorkItemSeverity }),
            ...(data.priority !== undefined && { priority: data.priority as WorkItemPriority }),
            ...(data.dueAt !== undefined && { dueAt: data.dueAt ? new Date(data.dueAt) : null }),
            ...(data.controlId !== undefined && { controlId: data.controlId }),
            ...(data.reviewerUserId !== undefined && { reviewerUserId: data.reviewerUserId }),
            ...(data.metadataJson !== undefined && { metadataJson: data.metadataJson != null ? data.metadataJson : Prisma.JsonNull }),
        };
        return db.task.update({ where: { id }, data: updateData });
    }

    static async setStatus(db: PrismaTx, ctx: RequestContext, id: string, status: string, resolution?: string | null) {
        const existing = await db.task.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        // `completedAt` tracks COMPLETED work, `resolution` tracks any
        // TERMINAL write — the two predicates are deliberately different.
        // A CANCELED item is terminal (it still owes the auditor a "why"),
        // but cancelling a job does not complete it, so it gets a
        // resolution and no completion timestamp.
        const updateData: Prisma.TaskUncheckedUpdateInput = {
            status: status as WorkItemStatus,
            completedAt: isCompletedStatus(status) ? new Date() : null,
        };
        if (isTerminalStatus(status) && resolution !== undefined) {
            updateData.resolution = resolution;
        }

        return db.task.update({ where: { id }, data: updateData });
    }

    static async assign(db: PrismaTx, ctx: RequestContext, id: string, assigneeUserId: string | null) {
        const existing = await db.task.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!existing) return null;

        return db.task.update({
            where: { id },
            data: { assigneeUserId },
            include: { assignee: { select: { id: true, name: true, email: true } } },
        });
    }

    // ─── Metrics ───

    static async metrics(db: PrismaTx, ctx: RequestContext) {
        const tenantId = ctx.tenantId;
        const now = new Date();
        const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const in30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const ago30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const openFilter = { notIn: [...TERMINAL_WORK_ITEM_STATUSES] as WorkItemStatus[] };

        const [byStatus, bySeverity, byType, overdueCount, due7dCount, due30dCount, total, recentCreated, recentResolved] = await Promise.all([
            db.task.groupBy({ by: ['status'], where: { tenantId }, _count: true }),
            db.task.groupBy({ by: ['severity'], where: { tenantId }, _count: true }),
            db.task.groupBy({ by: ['type'], where: { tenantId }, _count: true }),
            db.task.count({ where: { tenantId, dueAt: { lt: now }, status: openFilter } }),
            db.task.count({ where: { tenantId, dueAt: { gte: now, lte: in7d }, status: openFilter } }),
            db.task.count({ where: { tenantId, dueAt: { gte: now, lte: in30d }, status: openFilter } }),
            db.task.count({ where: { tenantId } }),
            db.task.count({ where: { tenantId, createdAt: { gte: ago30d } } }),
            // `resolved30d`. Reads the timestamp rather than the status so a
            // task resolved in-window and closed later still counts once, on
            // the day it was finished. Correct ONLY because `setStatus` /
            // `bulkSetStatus` stamp `completedAt` on COMPLETED statuses and
            // clear it otherwise — a CANCELED task has no timestamp and so
            // never lands in this count.
            db.task.count({ where: { tenantId, completedAt: { gte: ago30d } } }),
        ]);

        // Top controls with most open tasks (via controlId)
        const topControlsRaw = await db.task.groupBy({
            by: ['controlId'],
            where: { tenantId, controlId: { not: null }, status: openFilter },
            _count: true,
            orderBy: { _count: { controlId: 'desc' } },
            take: 5,
        });
        const controlIds = topControlsRaw.map(r => r.controlId).filter(Boolean) as string[];
        const controls = controlIds.length > 0
            ? await db.control.findMany({ where: { id: { in: controlIds } }, select: { id: true, code: true, name: true } })
            : [];
        const controlMap = new Map(controls.map(c => [c.id, c]));
        const topControls = topControlsRaw.map(r => ({
            controlId: r.controlId!,
            code: controlMap.get(r.controlId!)?.code || '',
            name: controlMap.get(r.controlId!)?.name || '',
            openTaskCount: r._count,
        }));

        // Top linked entities (ASSET / RISK) with most open tasks.
        // Pushdown: groupBy + take 5 instead of loading every TaskLink
        // and aggregating in JS. The (`tenantId`, `entityType`,
        // `entityId`) composite index already on TaskLink covers this.
        const topLinkedRaw = await db.taskLink.groupBy({
            by: ['entityType', 'entityId'],
            where: {
                tenantId,
                entityType: { in: [TaskLinkEntityType.ASSET] },
                task: { status: openFilter },
            },
            _count: true,
            orderBy: { _count: { entityId: 'desc' } },
            take: 5,
        });
        const topLinkedEntities = topLinkedRaw.map((r) => ({
            entityType: r.entityType as string,
            entityId: r.entityId,
            count: r._count,
        }));

        return {
            total,
            byStatus: Object.fromEntries(byStatus.map(r => [r.status, r._count])),
            bySeverity: Object.fromEntries(bySeverity.map(r => [r.severity, r._count])),
            byType: Object.fromEntries(byType.map(r => [r.type, r._count])),
            overdue: overdueCount,
            dueIn7d: due7dCount,
            dueIn30d: due30dCount,
            trend: { created30d: recentCreated, resolved30d: recentResolved },
            topControls,
            topLinkedEntities,
        };
    }

    // ─── Bulk ───

    /**
     * Audit Coherence S8 (2026-05-24) — fetch the current
     * status of a known set of task ids in ONE query so the bulk
     * status-change path can validate every transition before any
     * row is written. Empty input returns []; ids missing from the
     * result imply "not in tenant / soft-deleted" — the caller
     * surfaces a notFound rather than silently skipping.
     */
    static async listByIds(db: PrismaTx, ctx: RequestContext, taskIds: string[]) {
        if (taskIds.length === 0) return [];
        // Bounded by request payload size (taskIds.length); the bulk
        // endpoint enforces a max batch size upstream, so this is
        // structurally bounded without a `take:` literal.
        return db.task.findMany({ // guardrail-allow: unbounded
            where: {
                id: { in: taskIds },
                tenantId: ctx.tenantId,
                deletedAt: null,
            },
            select: { id: true, status: true },
        });
    }

    static async bulkAssign(db: PrismaTx, ctx: RequestContext, taskIds: string[], assigneeUserId: string | null) {
        return db.task.updateMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            data: { assigneeUserId },
        });
    }

    /**
     * Bulk sibling of `setStatus`, and deliberately byte-for-byte the same
     * `completedAt` / `resolution` rule — a task must not end up with a
     * different timestamp depending on whether it was closed one-at-a-time
     * or from the list page's checkbox column.
     *
     * Clearing `completedAt` on a non-completed target used to look unsafe
     * here ("updateMany writes one payload to every row, so it would wipe
     * the real timestamp off a row that is already terminal"). It isn't:
     * both callers (`bulkSetTaskStatus`, issue `bulkSetStatus`) run the S8
     * all-or-nothing transition gate FIRST, and CLOSED / CANCELED have no
     * outgoing transitions at all. The only terminal row that can legally
     * reach a non-completed target is RESOLVED → IN_PROGRESS — a genuine
     * re-open, where clearing the stamp is exactly right. Leaving it would
     * reproduce the single-row bug the sibling `setStatus` test names:
     * a visibly-open task that keeps counting as completed work.
     */
    static async bulkSetStatus(db: PrismaTx, ctx: RequestContext, taskIds: string[], status: string, resolution?: string | null) {
        const updateData: Prisma.TaskUncheckedUpdateManyInput = {
            status: status as WorkItemStatus,
            completedAt: isCompletedStatus(status) ? new Date() : null,
        };
        if (isTerminalStatus(status) && resolution !== undefined) {
            updateData.resolution = resolution;
        }
        return db.task.updateMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            data: updateData,
        });
    }

    static async bulkSetDueDate(db: PrismaTx, ctx: RequestContext, taskIds: string[], dueAt: string | null) {
        return db.task.updateMany({
            where: { id: { in: taskIds }, tenantId: ctx.tenantId },
            data: { dueAt: dueAt ? new Date(dueAt) : null },
        });
    }
}

// ─── TaskLink Repository ───

export class TaskLinkRepository {
    static async listByTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        return db.taskLink.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async link(db: PrismaTx, ctx: RequestContext, taskId: string, entityType: string, entityId: string, relation?: string) {
        return db.taskLink.create({
            data: {
                tenantId: ctx.tenantId,
                taskId,
                entityType: entityType as TaskLinkEntityType,
                entityId,
                relation: (relation as TaskLinkRelation) ?? TaskLinkRelation.RELATES_TO,
            },
        });
    }

    static async unlink(db: PrismaTx, ctx: RequestContext, linkId: string) {
        const link = await db.taskLink.findFirst({ where: { id: linkId, tenantId: ctx.tenantId } });
        if (!link) return null;
        await db.taskLink.delete({ where: { id: linkId } });
        return true;
    }
}

// ─── TaskComment Repository ───

export class TaskCommentRepository {
    static async listByTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        return db.taskComment.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            orderBy: { createdAt: 'asc' },
            include: { createdBy: { select: { id: true, name: true, email: true } } },
        });
    }

    static async add(db: PrismaTx, ctx: RequestContext, taskId: string, body: string) {
        return db.taskComment.create({
            data: {
                tenantId: ctx.tenantId,
                taskId,
                body,
                createdByUserId: ctx.userId,
            },
            include: { createdBy: { select: { id: true, name: true, email: true } } },
        });
    }
}

// ─── TaskWatcher Repository ───

export class TaskWatcherRepository {
    static async listByTask(db: PrismaTx, ctx: RequestContext, taskId: string) {
        return db.taskWatcher.findMany({
            where: { taskId, tenantId: ctx.tenantId },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
    }

    static async add(db: PrismaTx, ctx: RequestContext, taskId: string, userId: string) {
        return db.taskWatcher.create({
            data: { tenantId: ctx.tenantId, taskId, userId },
            include: { user: { select: { id: true, name: true, email: true } } },
        });
    }

    static async remove(db: PrismaTx, ctx: RequestContext, taskId: string, userId: string) {
        const watcher = await db.taskWatcher.findFirst({ where: { taskId, userId, tenantId: ctx.tenantId } });
        if (!watcher) return null;
        await db.taskWatcher.delete({ where: { id: watcher.id } });
        return true;
    }
}
