import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';

// ─── Dashboard DTO Types ───────────────────────────────────────────

/**
 * Evidence expiry summary.
 * Computed relative to current server time.
 */
export interface EvidenceExpiry {
    /** nextReviewDate is past AND status ≠ APPROVED */
    overdue: number;
    /** nextReviewDate within 7 days */
    dueSoon7d: number;
    /** nextReviewDate within 30 days */
    dueSoon30d: number;
    /** No nextReviewDate set */
    noReviewDate: number;
    /** Status = APPROVED and not overdue */
    current: number;
}

/**
 * Task summary — backs the daily snapshot's task roll-up.
 */
export interface TaskSummary {
    total: number;
    open: number;
    inProgress: number;
    blocked: number;
    resolved: number;
    /** Tasks where dueAt is past and status is not terminal */
    overdue: number;
}

/**
 * Asset summary — the counts that back the Assets-page KPI cards.
 * Mirrors the KPI tiles: Total / Active / High criticality / Retired.
 */
export interface AssetSummary {
    /** Non-deleted assets. */
    total: number;
    /** status = ACTIVE. */
    active: number;
    /** criticality = HIGH. */
    highCriticality: number;
    /** status = RETIRED. */
    retired: number;
}

/**
 * Upcoming evidence expiry item — for the expiry calendar widget.
 */
export interface EvidenceExpiryItem {
    id: string;
    title: string;
    /** ISO date string */
    nextReviewDate: string;
    status: string;
    /** Days until expiry (negative = overdue) */
    daysUntil: number;
}

// ─── Repository ────────────────────────────────────────────────────

/**
 * Aggregation reads behind the daily `ComplianceSnapshot` job.
 *
 * GRC teardown phase 3: the practice / policy / vendor / risk /
 * treatment-plan roll-ups are gone with their models. What is left
 * aggregates Evidence, Task, Asset and AuditLog — all surviving
 * agri-side models.
 *
 * Only `getEvidenceExpiry` / `getTaskSummary` / `getAssetSummary` have a
 * caller today — `jobs/snapshot.ts`. `getUpcomingExpirations` and
 * `getRecentActivity` still read surviving models, but the executive
 * dashboard page that consumed them went with the teardown, so they are
 * repository API with no live surface behind them.
 */
export class DashboardRepository {
    /**
     * Evidence expiry/freshness summary.
     *
     * Computes:
     * - overdue: nextReviewDate < now AND status ≠ APPROVED
     * - dueSoon7d: nextReviewDate within 7 days
     * - dueSoon30d: nextReviewDate within 30 days (includes dueSoon7d)
     * - noReviewDate: nextReviewDate is null
     * - current: APPROVED and not overdue
     *
     * Uses 5 parallel count queries on indexed columns.
     */
    static async getEvidenceExpiry(db: PrismaTx, ctx: RequestContext): Promise<EvidenceExpiry> {
        const tenantId = ctx.tenantId;
        const now = new Date();
        const in7d = new Date(now.getTime() + 7 * 86400000);
        const in30d = new Date(now.getTime() + 30 * 86400000);
        const base = { tenantId, deletedAt: null, isArchived: false };

        const [overdue, dueSoon7d, dueSoon30d, noReviewDate, current] = await Promise.all([
            // Overdue: review date is past and not approved
            db.evidence.count({
                where: { ...base, nextReviewDate: { lt: now }, status: { not: 'APPROVED' } },
            }),
            // Due within 7 days (not yet past)
            db.evidence.count({
                where: { ...base, nextReviewDate: { gte: now, lte: in7d } },
            }),
            // Due within 30 days (not yet past)
            db.evidence.count({
                where: { ...base, nextReviewDate: { gte: now, lte: in30d } },
            }),
            // No review date set
            db.evidence.count({
                where: { ...base, nextReviewDate: null },
            }),
            // Current: approved and review date not passed (or no review date)
            db.evidence.count({
                where: {
                    ...base,
                    status: 'APPROVED',
                    OR: [
                        { nextReviewDate: null },
                        { nextReviewDate: { gte: now } },
                    ],
                },
            }),
        ]);

        return { overdue, dueSoon7d, dueSoon30d, noReviewDate, current };
    }

    /**
     * Task summary — total / by-status / overdue.
     *
     * Query: 1 groupBy + 1 overdue count
     */
    static async getTaskSummary(db: PrismaTx, ctx: RequestContext): Promise<TaskSummary> {
        const tenantId = ctx.tenantId;

        const [groups, overdue] = await Promise.all([
            db.task.groupBy({
                by: ['status'],
                where: { tenantId, deletedAt: null },
                _count: true,
            }),
            db.task.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    dueAt: { lt: new Date() },
                    status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
                },
            }),
        ]);

        const counts: Record<string, number> = {};
        let total = 0;
        for (const g of groups) {
            counts[g.status] = g._count;
            total += g._count;
        }

        return {
            total,
            open: (counts['OPEN'] ?? 0) + (counts['TRIAGED'] ?? 0),
            inProgress: counts['IN_PROGRESS'] ?? 0,
            blocked: counts['BLOCKED'] ?? 0,
            // Sum all terminal statuses using the shared constant
            resolved: TERMINAL_WORK_ITEM_STATUSES.reduce(
                (sum, s) => sum + (counts[s] ?? 0), 0
            ),
            overdue,
        };
    }

    /**
     * Asset KPI counts for the daily snapshot + the Assets-page cards.
     * All counts exclude soft-deleted rows (`deletedAt: null`), so the
     * snapshot series mirrors what the live Assets table shows.
     */
    static async getAssetSummary(db: PrismaTx, ctx: RequestContext): Promise<AssetSummary> {
        const tenantId = ctx.tenantId;

        const [total, active, highCriticality, retired] = await Promise.all([
            db.asset.count({ where: { tenantId, deletedAt: null } }),
            db.asset.count({ where: { tenantId, deletedAt: null, status: 'ACTIVE' } }),
            db.asset.count({ where: { tenantId, deletedAt: null, criticality: 'HIGH' } }),
            db.asset.count({ where: { tenantId, deletedAt: null, status: 'RETIRED' } }),
        ]);

        return { total, active, highCriticality, retired };
    }

    /**
     * Recent audit log activity.
     *
     * Query: 1 findMany with take limit
     */
    static async getRecentActivity(db: PrismaTx, ctx: RequestContext) {
        return db.auditLog.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { user: { select: { name: true } } },
        });
    }

    /**
     * Upcoming evidence expirations — next 30 days + overdue.
     *
     * Query: 1 findMany with date filter, ordered by nextReviewDate
     * Returns at most 20 items (executive summary, not full list).
     */
    static async getUpcomingExpirations(db: PrismaTx, ctx: RequestContext): Promise<EvidenceExpiryItem[]> {
        const now = new Date();
        const in30d = new Date(now.getTime() + 30 * 86400000);

        const items = await db.evidence.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                isArchived: false,
                nextReviewDate: { lte: in30d },
                status: { not: 'APPROVED' },
            },
            orderBy: { nextReviewDate: 'asc' },
            take: 20,
            select: {
                id: true,
                title: true,
                nextReviewDate: true,
                status: true,
            },
        });

        return items
            .filter(e => e.nextReviewDate !== null)
            .map(e => {
                const reviewDate = e.nextReviewDate!;
                const diffMs = reviewDate.getTime() - now.getTime();
                const daysUntil = Math.ceil(diffMs / 86400000);
                return {
                    id: e.id,
                    title: e.title,
                    nextReviewDate: reviewDate.toISOString().slice(0, 10),
                    status: e.status,
                    daysUntil,
                };
            });
    }
}
