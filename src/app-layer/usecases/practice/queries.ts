import { RequestContext } from '../../types';
import { PracticeRepository } from '../../repositories/PracticeRepository';
import { WorkItemRepository } from '../../repositories/WorkItemRepository';
import { assertCanReadPractices } from '../../policies/practice.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../../policies/common';
import { withDeleted } from '@/lib/soft-delete';
import { cachedListRead } from '@/lib/cache/list-cache';

// ─── Queries ───

export async function listPractices(
    ctx: RequestContext,
    filters?: {
        status?: string; applicability?: string; ownerUserId?: string; q?: string; category?: string;
    },
    options: { take?: number } = {},
) {
    assertCanReadPractices(ctx);
    return cachedListRead({
        ctx,
        entity: 'practice',
        operation: 'list',
        // `take` participates in the cache key so a bounded SSR
        // result can't poison the unbounded API GET cache (mirrors
        // the PR #146 Tasks pattern).
        params: options.take
            ? { ...(filters ?? {}), _take: options.take }
            : (filters ?? {}),
        loader: () =>
            runInTenantContext(ctx, async (db) => {
                const practices = await PracticeRepository.list(
                    db,
                    ctx,
                    filters,
                    options,
                );
                // Attach the unified linked-task counts (TaskLink CONTROL
                // link OR the practiceId FK) so the list-page Tasks column
                // matches the practice's Tasks tab — the legacy
                // `_count.practiceTasks` read 0/0 for unified tasks.
                const counts = await WorkItemRepository.countLinkedToPractices(
                    db,
                    ctx,
                    practices.map((c) => c.id),
                );
                return practices.map((c) => ({
                    ...c,
                    taskTotal: counts.get(c.id)?.total ?? 0,
                    taskDone: counts.get(c.id)?.done ?? 0,
                }));
            }),
    });
}

export async function listPracticesPaginated(ctx: RequestContext, params: {
    limit?: number; cursor?: string;
    filters?: { status?: string; applicability?: string; ownerUserId?: string; q?: string; category?: string };
}) {
    assertCanReadPractices(ctx);
    return cachedListRead({
        ctx,
        entity: 'practice',
        operation: 'listPaginated',
        params,
        loader: () =>
            runInTenantContext(ctx, (db) =>
                PracticeRepository.listPaginated(db, ctx, params),
            ),
    });
}

export async function getPractice(ctx: RequestContext, id: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practice = await PracticeRepository.getById(db, ctx, id);
        if (!practice) throw notFound('Practice not found');
        return practice;
    });
}

/**
 * Header-only practice read (#102 item 1 — tab-lazy refactor).
 *
 * Returns the practice scalars + user refs + a
 * `_count` of the four tabbed relations, without their arrays. The
 * detail page renders the Overview tab + header from this; the
 * Tasks / Evidence / Mappings tabs fetch their own data on demand.
 *
 * `donePracticeTasks` is the one derived extra: `_count.practiceTasks`
 * gives the total, but the Overview "Tasks Progress" widget also
 * needs the DONE count — a relation `_count` can't carry both a
 * total and a filtered count for the same relation, so it ships as
 * a separate field. The `[tenantId, practiceId, status]` index added
 * in #102 item 4 covers this count.
 */
export async function getPracticeHeader(ctx: RequestContext, id: string) {
    assertCanReadPractices(ctx);
    return runInTenantContext(ctx, async (db) => {
        const practice = await PracticeRepository.getHeaderById(db, ctx, id);
        if (!practice) throw notFound('Practice not found');
        // The Tasks tab badge + Overview "Tasks Progress" must reflect
        // the unified Task rows the LinkedTasksPanel actually renders
        // (TaskLink CONTROL link OR the direct practiceId FK), NOT the
        // legacy `PracticeTask` relation — which `_count.practiceTasks`
        // and the old `practiceTask.count` measured. Those diverged from
        // the table after the work-item unification (#806).
        const linkedTasks = await WorkItemRepository.countLinkedToPractice(
            db,
            ctx,
            id,
        );
        return {
            ...practice,
            // Override the legacy relation count so the badge matches
            // the table without churning the page's read path.
            _count: { ...practice._count, practiceTasks: linkedTasks.total },
            donePracticeTasks: linkedTasks.done,
        };
    });
}

// ─── Activity Trail ───

export async function getPracticeActivity(ctx: RequestContext, practiceId: string) {
    assertCanReadPractices(ctx);

    return runInTenantContext(ctx, async (db) => {
        const practice = await PracticeRepository.getById(db, ctx, practiceId);
        if (!practice) throw notFound('Practice not found');

        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId, entity: 'Practice', entityId: practiceId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { user: { select: { id: true, name: true } } },
        });
    });
}

// ─── Dashboard Metrics ───

export async function getPracticeDashboard(ctx: RequestContext) {
    assertCanReadPractices(ctx);

    return runInTenantContext(ctx, async (db) => {
        const now = new Date();
        const soonThreshold = new Date(now);
        soonThreshold.setDate(soonThreshold.getDate() + 30);

        // #102 item 3 — the dashboard used to `findMany` every practice
        // WITH its full `practiceTasks` array (plus an unused `_count`)
        // and reduce in JS — loading the whole practice × task graph
        // for the tenant to produce a handful of counts. It is now a
        // fan-out of indexed aggregate queries; each touches only the
        // columns it needs.
        const [
            statusGroups,
            applicabilityGroups,
            implementedCount,
            practicesDueSoon,
            overdueTasks,
            openTasksByPractice,
            practiceOwners,
        ] = await Promise.all([
            db.practice.groupBy({
                by: ['status'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            db.practice.groupBy({
                by: ['applicability'],
                where: { tenantId: ctx.tenantId },
                _count: { _all: true },
            }),
            db.practice.count({
                where: {
                    tenantId: ctx.tenantId,
                    applicability: 'APPLICABLE',
                    status: 'IMPLEMENTED',
                },
            }),
            db.practice.count({
                where: {
                    tenantId: ctx.tenantId,
                    applicability: 'APPLICABLE',
                    nextDueAt: { not: null, lte: soonThreshold },
                },
            }),
            db.practiceTask.count({
                where: {
                    tenantId: ctx.tenantId,
                    status: { not: 'DONE' },
                    dueAt: { not: null, lt: now },
                },
            }),
            // Open tasks per practice. Prisma can't group PracticeTask
            // by Practice.ownerUserId directly (cross-relation), so we
            // group by practiceId and fold into owners in JS over the
            // thin practice → owner projection below.
            db.practiceTask.groupBy({
                by: ['practiceId'],
                where: { tenantId: ctx.tenantId, status: { not: 'DONE' } },
                _count: { _all: true },
            }),
            db.practice.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    owner: { select: { id: true, name: true } },
                },
            }),
        ]);

        // Status distribution → Record<status, count>; total folds out.
        const statusDistribution: Record<string, number> = {};
        let totalPractices = 0;
        for (const g of statusGroups) {
            statusDistribution[g.status] = g._count._all;
            totalPractices += g._count._all;
        }

        // Applicability distribution.
        const applicabilityOf = (value: string) =>
            applicabilityGroups.find(g => g.applicability === value)?._count._all ?? 0;
        const applicableCount = applicabilityOf('APPLICABLE');
        const notApplicableCount = applicabilityOf('NOT_APPLICABLE');

        // Top owners — fold per-practice open-task counts into owners.
        const openByPractice = new Map<string, number>();
        for (const row of openTasksByPractice) {
            if (row.practiceId) openByPractice.set(row.practiceId, row._count._all);
        }
        const ownerTaskMap: Record<string, { name: string; openTasks: number }> = {};
        for (const c of practiceOwners) {
            if (!c.owner) continue;
            if (!ownerTaskMap[c.owner.id]) {
                ownerTaskMap[c.owner.id] = { name: c.owner.name || 'Unknown', openTasks: 0 };
            }
            ownerTaskMap[c.owner.id].openTasks += openByPractice.get(c.id) ?? 0;
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
            totalPractices,
            statusDistribution,
            applicabilityDistribution: { applicable: applicableCount, notApplicable: notApplicableCount },
            overdueTasks,
            practicesDueSoon,
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
        // full `practiceTasks` include) loaded the entire task table
        // for the tenant just to compute overdue counts; for tenants
        // with hundreds of practices × dozens of tasks each this was
        // a 5-50KB result set + an O(N×M) JS pass.
        //
        // The split lets each query use exactly the index it needs:
        //   • practicesForCodeChecks — only `id, code, name` projected,
        //     so the query never touches the wide row.
        //   • overdueTasks — a direct `.findMany` with the GAP-perf
        //     `(tenantId, status, dueAt)` composite index from the
        //     companion migration. Returns ONLY overdue rows; no
        //     in-memory filter needed.
        const now = new Date();

        const [practicesForCodeChecks, totalPractices, overdueTaskRows] = await Promise.all([
            // Project the minimum needed for the missingCode +
            // duplicateCodes checks. Skipping the relations and
            // wide columns keeps this fast even on tenants with
            // hundreds of practices.
            db.practice.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, code: true, name: true },
            }),
            db.practice.count({ where: { tenantId: ctx.tenantId } }),
            // Directly query the overdue tasks. With the
            // GAP-perf [tenantId, status, dueAt] composite index
            // this is an index range scan that returns only the
            // matching rows — no scan-and-filter on the full task
            // table.
            db.practiceTask.findMany({
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
                    practiceId: true,
                    practice: { select: { code: true } },
                },
                orderBy: { dueAt: 'asc' },
            }),
        ]);

        const missingCode = practicesForCodeChecks.filter((c) => !c.code);

        // Duplicate-code detection — single pass over the
        // narrow projection.
        const codeCounts: Record<string, string[]> = {};
        for (const c of practicesForCodeChecks) {
            if (c.code) {
                (codeCounts[c.code] ||= []).push(c.id);
            }
        }
        const duplicateCodes = Object.entries(codeCounts)
            .filter(([, ids]) => ids.length > 1)
            .map(([code, ids]) => ({ code, practiceIds: ids }));

        // Shape the overdue rows to match the existing DTO contract
        // — the response shape is unchanged.
        const overdueTasks = overdueTaskRows.map((t) => ({
            practiceId: t.practiceId,
            practiceCode: t.practice?.code ?? null,
            taskId: t.id,
            taskTitle: t.title,
            dueAt: t.dueAt,
            status: t.status,
        }));

        return {
            totalPractices,
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

export async function listPracticesWithDeleted(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.practice.findMany(withDeleted({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' as const } }))
    );
}
