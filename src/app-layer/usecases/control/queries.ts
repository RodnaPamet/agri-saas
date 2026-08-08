import { RequestContext } from '../../types';
import { ControlRepository } from '../../repositories/ControlRepository';
import { WorkItemRepository } from '../../repositories/WorkItemRepository';
import { assertCanReadControls } from '../../policies/control.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../../policies/common';
import { withDeleted } from '@/lib/soft-delete';
import { cachedListRead } from '@/lib/cache/list-cache';

// ─── Queries ───

export async function listControls(
    ctx: RequestContext,
    filters?: {
        status?: string; applicability?: string; ownerUserId?: string; q?: string; category?: string;
    },
    options: { take?: number } = {},
) {
    assertCanReadControls(ctx);
    return cachedListRead({
        ctx,
        entity: 'control',
        operation: 'list',
        // `take` participates in the cache key so a bounded SSR
        // result can't poison the unbounded API GET cache (mirrors
        // the PR #146 Tasks pattern).
        params: options.take
            ? { ...(filters ?? {}), _take: options.take }
            : (filters ?? {}),
        loader: () =>
            runInTenantContext(ctx, async (db) => {
                const controls = await ControlRepository.list(
                    db,
                    ctx,
                    filters,
                    options,
                );
                // Attach the unified linked-task counts (TaskLink CONTROL
                // link OR the controlId FK) so the list-page Tasks column
                // matches the control's Tasks tab — the legacy
                // `_count.controlTasks` read 0/0 for unified tasks.
                const counts = await WorkItemRepository.countLinkedToControls(
                    db,
                    ctx,
                    controls.map((c) => c.id),
                );
                return controls.map((c) => ({
                    ...c,
                    taskTotal: counts.get(c.id)?.total ?? 0,
                    taskDone: counts.get(c.id)?.done ?? 0,
                }));
            }),
    });
}

export async function listControlsPaginated(ctx: RequestContext, params: {
    limit?: number; cursor?: string;
    filters?: { status?: string; applicability?: string; ownerUserId?: string; q?: string; category?: string };
}) {
    assertCanReadControls(ctx);
    return cachedListRead({
        ctx,
        entity: 'control',
        operation: 'listPaginated',
        params,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                ControlRepository.listPaginated(db, ctx, params),
            ),
    });
}

export async function getControl(ctx: RequestContext, id: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getById(db, ctx, id);
        if (!control) throw notFound('Control not found');
        return control;
    });
}

/**
 * Header-only control read (#102 item 1 — tab-lazy refactor).
 *
 * Returns the control scalars + user refs + a
 * `_count` of the four tabbed relations, without their arrays. The
 * detail page renders the Overview tab + header from this; the
 * Tasks / Evidence / Mappings tabs fetch their own data on demand.
 *
 * `doneControlTasks` is the one derived extra: `_count.controlTasks`
 * gives the total, but the Overview "Tasks Progress" widget also
 * needs the DONE count — a relation `_count` can't carry both a
 * total and a filtered count for the same relation, so it ships as
 * a separate field. The `[tenantId, controlId, status]` index added
 * in #102 item 4 covers this count.
 */
export async function getControlHeader(ctx: RequestContext, id: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getHeaderById(db, ctx, id);
        if (!control) throw notFound('Control not found');
        // The Tasks tab badge + Overview "Tasks Progress" must reflect
        // the unified Task rows the LinkedTasksPanel actually renders
        // (TaskLink CONTROL link OR the direct controlId FK), NOT the
        // legacy `ControlTask` relation — which `_count.controlTasks`
        // and the old `controlTask.count` measured. Those diverged from
        // the table after the work-item unification (#806).
        const linkedTasks = await WorkItemRepository.countLinkedToControl(
            db,
            ctx,
            id,
        );
        return {
            ...control,
            // Override the legacy relation count so the badge matches
            // the table without churning the page's read path.
            _count: { ...control._count, controlTasks: linkedTasks.total },
            doneControlTasks: linkedTasks.done,
        };
    });
}

// ─── Activity Trail ───

export async function getControlActivity(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);

    return runInTenantContext(ctx, async (db) => {
        const control = await ControlRepository.getById(db, ctx, controlId);
        if (!control) throw notFound('Control not found');

        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Control', entityId: controlId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true } } },
        });
    });
}

// ─── Dashboard Metrics ───

export async function getControlDashboard(ctx: RequestContext) {
    assertCanReadControls(ctx);

    return runInTenantContext(ctx, async (db) => {
        const now = new Date();
        const soonThreshold = new Date(now);
        soonThreshold.setDate(soonThreshold.getDate() + 30);

        // #102 item 3 — the dashboard used to `findMany` every control
        // WITH its full `controlTasks` array (plus an unused `_count`)
        // and reduce in JS — loading the whole control × task graph
        // for the tenant to produce a handful of counts. It is now a
        // fan-out of indexed aggregate queries; each touches only the
        // columns it needs.
        const [
            statusGroups,
            applicabilityGroups,
            implementedCount,
            controlsDueSoon,
            overdueTasks,
            openTasksByControl,
            controlOwners,
        ] = await Promise.all([
            db.control.groupBy({
                by: ['status'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            db.control.groupBy({
                by: ['applicability'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            db.control.count({
                where: {
                    tenantId: ctx.tenantId,
                    applicability: 'APPLICABLE',
                    status: 'IMPLEMENTED',
                },
            }),
            db.control.count({
                where: {
                    tenantId: ctx.tenantId,
                    applicability: 'APPLICABLE',
                    nextDueAt: { not: null, lte: soonThreshold },
                },
            }),
            db.controlTask.count({
                where: {
                    tenantId: ctx.tenantId,
                    status: { not: 'DONE' },
                    dueAt: { not: null, lt: now },
                },
            }),
            // Open tasks per control. Prisma can't group ControlTask
            // by Control.ownerUserId directly (cross-relation), so we
            // group by controlId and fold into owners in JS over the
            // thin control → owner projection below.
            db.controlTask.groupBy({
                by: ['controlId'],
                where: { tenantId: ctx.tenantId, status: { not: 'DONE' } },
                _count: { _all: true },
            }),
            db.control.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    owner: { select: { id: true, name: true } },
                },
            }),
        ]);

        // Status distribution → Record<status, count>; total folds out.
        const statusDistribution: Record<string, number> = {};
        let totalControls = 0;
        for (const g of statusGroups) {
            statusDistribution[g.status] = g._count._all;
            totalControls += g._count._all;
        }

        // Applicability distribution.
        const applicabilityOf = (value: string) =>
            applicabilityGroups.find(g => g.applicability === value)?._count._all ?? 0;
        const applicableCount = applicabilityOf('APPLICABLE');
        const notApplicableCount = applicabilityOf('NOT_APPLICABLE');

        // Top owners — fold per-control open-task counts into owners.
        const openByControl = new Map<string, number>();
        for (const row of openTasksByControl) {
            if (row.controlId) openByControl.set(row.controlId, row._count._all);
        }
        const ownerTaskMap: Record<string, { name: string; openTasks: number }> = {};
        for (const c of controlOwners) {
            if (!c.owner) continue;
            if (!ownerTaskMap[c.owner.id]) {
                ownerTaskMap[c.owner.id] = { name: c.owner.name || 'Unknown', openTasks: 0 };
            }
            ownerTaskMap[c.owner.id].openTasks += openByControl.get(c.id) ?? 0;
        }
        const topOwners = Object.entries(ownerTaskMap)
            .sort(([, a], [, b]) => b.openTasks - a.openTasks)
            .slice(0, 5)
            .map(([id, { name, openTasks }]) => ({ id, name, openTasks }));

        // Implementation progress: % IMPLEMENTED among APPLICABLE.
        const implementationProgress = applicableCount > 0
            ? Math.round((implementedCount / applicableCount) * 100)
            : 0;

        return {
            totalControls,
            statusDistribution,
            applicabilityDistribution: { applicable: applicableCount, notApplicable: notApplicableCount },
            overdueTasks,
            controlsDueSoon,
            topOwners,
            implementationProgress,
            implementedCount,
            applicableCount,
        };
    });
}

// ─── Consistency Check (admin-only) ───

export async function runConsistencyCheck(ctx: RequestContext) {
    // Epic 1 — OWNER is a superset of ADMIN per CLAUDE.md RBAC.
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
        throw (await import('@/lib/errors/types')).forbidden('Only admins can run consistency checks');
    }

    return runInTenantContext(ctx, async (db) => {
        // Three independent checks run in parallel — they don't share
        // intermediate state. Pre-refactor (single `findMany` with
        // full `controlTasks` include) loaded the entire task table
        // for the tenant just to compute overdue counts; for tenants
        // with hundreds of controls × dozens of tasks each this was
        // a 5-50KB result set + an O(N×M) JS pass.
        //
        // The split lets each query use exactly the index it needs:
        //   • controlsForCodeChecks — only `id, code, name` projected,
        //     so the query never touches the wide row.
        //   • overdueTasks — a direct `.findMany` with the GAP-perf
        //     `(tenantId, status, dueAt)` composite index from the
        //     companion migration. Returns ONLY overdue rows; no
        //     in-memory filter needed.
        const now = new Date();

        const [controlsForCodeChecks, totalControls, overdueTaskRows] = await Promise.all([
            // Project the minimum needed for the missingCode +
            // duplicateCodes checks. Skipping the relations and
            // wide columns keeps this fast even on tenants with
            // hundreds of controls.
            db.control.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, code: true, name: true },
            }),
            db.control.count({ where: { tenantId: ctx.tenantId } }),
            // Directly query the overdue tasks. With the
            // GAP-perf [tenantId, status, dueAt] composite index
            // this is an index range scan that returns only the
            // matching rows — no scan-and-filter on the full task
            // table.
            db.controlTask.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    status: { in: ['OPEN', 'IN_PROGRESS'] },
                    dueAt: { lt: now, not: null },
                },
                select: {
                    id: true,
                    title: true,
                    status: true,
                    dueAt: true,
                    controlId: true,
                    control: { select: { code: true } },
                },
                orderBy: { dueAt: 'asc' },
            }),
        ]);

        const missingCode = controlsForCodeChecks.filter((c) => !c.code);

        // Duplicate-code detection — single pass over the
        // narrow projection.
        const codeCounts: Record<string, string[]> = {};
        for (const c of controlsForCodeChecks) {
            if (c.code) {
                (codeCounts[c.code] ||= []).push(c.id);
            }
        }
        const duplicateCodes = Object.entries(codeCounts)
            .filter(([, ids]) => ids.length > 1)
            .map(([code, ids]) => ({ code, controlIds: ids }));

        // Shape the overdue rows to match the existing DTO contract
        // — the response shape is unchanged.
        const overdueTasks = overdueTaskRows.map((t) => ({
            controlId: t.controlId,
            controlCode: t.control?.code ?? null,
            taskId: t.id,
            taskTitle: t.title,
            dueAt: t.dueAt,
            status: t.status,
        }));

        return {
            totalControls,
            issues: {
                missingCode: missingCode.map((c) => ({ id: c.id, name: c.name })),
                duplicateCodes,
                overdueTasks,
            },
            summary: {
                missingCodeCount: missingCode.length,
                duplicateCodeCount: duplicateCodes.length,
                overdueTaskCount: overdueTasks.length,
            },
        };
    });
}

export async function listControlsWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.control.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const } }))
    );
}
