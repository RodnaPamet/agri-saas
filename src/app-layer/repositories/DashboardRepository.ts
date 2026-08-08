import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';

// ─── Executive Dashboard DTO Types ─────────────────────────────────

/**
 * Headline KPI stats — simple counts for the stat-card grid.
 * Matches the dashboard page's current contract and extends it
 * with executive-grade aggregations.
 */
export interface DashboardStats {
    // ── Entity totals ──
    assets: number;
    risks: number;
    controls: number;
    evidence: number;
    openTasks: number;
    openFindings: number;

    // ── Alert indicators ──
    highRisks: number;
    pendingEvidence: number;
    overdueEvidence: number;

    // ── Clause readiness ──
    clausesReady: number;
    totalClauses: number;

    // ── Notifications ──
    unreadNotifications: number;
}

/**
 * Risk breakdown by severity tier.
 * Severity is derived from the `inherentScore` field (likelihood × impact, 1–25).
 */
export interface RiskBySeverity {
    /** Score 1–4 */
    low: number;
    /** Score 5–9 */
    medium: number;
    /** Score 10–14 */
    high: number;
    /** Score 15–25 */
    critical: number;
}

/**
 * Risk counts by status.
 */
export interface RiskByStatus {
    open: number;
    mitigating: number;
    accepted: number;
    closed: number;
}

/**
 * Control coverage metrics.
 *
 * "Coverage" = the percentage of applicable controls that have reached
 * IMPLEMENTED status. Controls marked NOT_APPLICABLE (via the
 * applicability field) are excluded from the denominator.
 */
export interface ControlCoverage {
    total: number;
    applicable: number;
    implemented: number;
    inProgress: number;
    notStarted: number;
    planned: number;
    needsReview: number;
    /** implemented / applicable × 100, rounded to 1 decimal */
    coveragePercent: number;
}

/**
 * Control status distribution — for pie/bar charts.
 */
export interface ControlByStatus {
    status: string;
    count: number;
}

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
 * Policy status summary.
 */
export interface PolicySummary {
    total: number;
    draft: number;
    inReview: number;
    approved: number;
    published: number;
    archived: number;
    /** Policies with nextReviewAt in the past */
    overdueReview: number;
}

/**
 * Task summary for executive view.
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
 * Vendor summary.
 */
export interface VendorSummary {
    total: number;
    /** Vendors with nextReviewAt in the past */
    overdueReview: number;
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

/**
 * Epic G-7 — risk treatment plan inventory + overdue counts for the
 * dashboard. Five COUNTs against the `(tenantId, status)` and
 * `(tenantId, targetDate)` indexes from prompt 1.
 */
export interface TreatmentPlanSummary {
    /** DRAFT or ACTIVE plans whose targetDate is still in the future. */
    activeOnTrack: number;
    /** Plans whose targetDate has elapsed but status isn't COMPLETED. */
    overdue: number;
    /** Approved plans with targetDate within the next 30 days. */
    dueWithin30: number;
    /** Subset of dueWithin30 — within next 7 days. */
    dueWithin7: number;
    /** COMPLETED plans (audit-trail visibility). */
    completed: number;
}

/**
 * Complete executive dashboard payload.
 * Returned as a single aggregated response to minimize round trips.
 */
export interface ExecutiveDashboardPayload {
    stats: DashboardStats;
    controlCoverage: ControlCoverage;
    controlsByStatus: ControlByStatus[];
    riskBySeverity: RiskBySeverity;
    riskByStatus: RiskByStatus;
    evidenceExpiry: EvidenceExpiry;
    policySummary: PolicySummary;
    taskSummary: TaskSummary;
    vendorSummary: VendorSummary;
    upcomingExpirations: EvidenceExpiryItem[];
    /** Epic G-7 — risk treatment plan health card. */
    treatmentPlans: TreatmentPlanSummary;
    /** ISO 8601 timestamp of when the payload was computed */
    computedAt: string;
}

// ─── Repository ────────────────────────────────────────────────────

export class DashboardRepository {
    /**
     * Headline stats — backward-compatible with the existing dashboard.
     *
     * Uses parallel Prisma.count() calls which each translate to a single
     * `SELECT COUNT(*)` with indexed WHERE clauses. N queries = 9 parallel
     * counts + 1 clauseProgress query + 1 notification count = 11 parallel
     * queries. All use existing indexes.
     */

    /**
     * Control coverage — the executive KPI.
     *
     * Coverage % = (IMPLEMENTED controls / applicable controls) × 100
     *
     * Uses groupBy aggregation to count all statuses in a single query.
     * Controls with applicability NOT_APPLICABLE are excluded.
     * Soft-deleted controls are excluded.
     *
     * Query: 1 groupBy (single DB round trip)
     */
    static async getControlCoverage(db: PrismaTx, ctx: RequestContext): Promise<ControlCoverage> {
        const tenantId = ctx.tenantId;

        // Group applicable, non-deleted controls by status
        const groups = await db.control.groupBy({
            by: ['status'],
            where: {
                OR: [{ tenantId }, { tenantId: null }],
                applicability: 'APPLICABLE',
                deletedAt: null,
            },
            _count: true,
        });

        const statusCounts: Record<string, number> = {};
        let applicable = 0;
        for (const g of groups) {
            statusCounts[g.status] = g._count;
            applicable += g._count;
        }

        const implemented = statusCounts['IMPLEMENTED'] ?? 0;
        const inProgress = (statusCounts['IN_PROGRESS'] ?? 0) + (statusCounts['IMPLEMENTING'] ?? 0);
        const notStarted = statusCounts['NOT_STARTED'] ?? 0;
        const planned = statusCounts['PLANNED'] ?? 0;
        const needsReview = statusCounts['NEEDS_REVIEW'] ?? 0;

        // Total including not-applicable (for reference)
        const total = await db.control.count({
            where: {
                OR: [{ tenantId }, { tenantId: null }],
                deletedAt: null,
            },
        });

        const coveragePercent = applicable > 0
            ? Math.round((implemented / applicable) * 1000) / 10
            : 0;

        return {
            total,
            applicable,
            implemented,
            inProgress,
            notStarted,
            planned,
            needsReview,
            coveragePercent,
        };
    }

    /**
     * Controls grouped by status — for visualization.
     *
     * Query: 1 groupBy
     */
    static async getControlsByStatus(db: PrismaTx, ctx: RequestContext): Promise<ControlByStatus[]> {
        const groups = await db.control.groupBy({
            by: ['status'],
            where: {
                OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
                deletedAt: null,
            },
            _count: true,
        });

        return groups.map((g) => ({
            status: g.status,
            count: g._count,
        }));
    }

    /**
     * Risk counts by severity tier.
     *
     * Severity tiers are derived from inherentScore (1–25):
     *   - Low: 1–4
     *   - Medium: 5–9
     *   - High: 10–14
     *   - Critical: 15–25
     *
     * Uses 4 parallel count queries with range filters on an indexed column.
     */

    /**
     * Risk counts by status.
     *
     * Query: 1 groupBy
     */

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
     * Policy status summary.
     *
     * Query: 1 groupBy + 1 count
     */
    static async getPolicySummary(db: PrismaTx, ctx: RequestContext): Promise<PolicySummary> {
        const tenantId = ctx.tenantId;

        const [groups, overdueReview] = await Promise.all([
            db.policy.groupBy({
                by: ['status'],
                where: { tenantId, deletedAt: null },
                _count: true,
            }),
            db.policy.count({
                where: { tenantId, deletedAt: null, nextReviewAt: { lt: new Date() } },
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
            draft: counts['DRAFT'] ?? 0,
            inReview: counts['IN_REVIEW'] ?? 0,
            approved: counts['APPROVED'] ?? 0,
            published: counts['PUBLISHED'] ?? 0,
            archived: counts['ARCHIVED'] ?? 0,
            overdueReview,
        };
    }

    /**
     * Task summary for executive view.
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
     * Vendor summary.
     *
     * Query: 1 count + 1 overdue count
     */
    static async getVendorSummary(db: PrismaTx, ctx: RequestContext): Promise<VendorSummary> {
        const tenantId = ctx.tenantId;

        const [total, overdueReview] = await Promise.all([
            db.vendor.count({ where: { tenantId, deletedAt: null } }),
            db.vendor.count({
                where: { tenantId, deletedAt: null, nextReviewAt: { lt: new Date() } },
            }),
        ]);

        return { total, overdueReview };
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

    /**
     * Epic G-7 — risk treatment plan inventory + overdue counts for
     * the dashboard card. Five parallel COUNTs against the
     * `(tenantId, status)` + `(tenantId, targetDate)` indexes.
     */
}
