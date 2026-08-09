/**
 * Compliance Trends — Retrieval Layer
 *
 * Provides trend queries for the executive dashboard:
 *  - 90-day KPI time series
 *  - Configurable date range
 *  - Tenant-scoped via RLS
 *
 * @module app-layer/usecases/compliance-trends
 */
import { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { ComplianceSnapshot } from '@prisma/client';

// ─── DTO ────────────────────────────────────────────────────────────

/**
 * A single trend data point — one day's snapshot.
 * Returned as a flat object suitable for charting libraries.
 */
export interface TrendDataPoint {
    /** ISO date string (YYYY-MM-DD) */
    date: string;

    // Controls
    controlCoveragePercent: number;
    controlsImplemented: number;
    controlsApplicable: number;

    // Risks

    // Evidence
    evidenceOverdue: number;
    evidenceDueSoon7d: number;
    evidenceCurrent: number;

    // Policies
    policiesTotal: number;
    policiesOverdueReview: number;

    // Tasks
    tasksOpen: number;
    tasksOverdue: number;

    // Assets
    assetsTotal: number;
    assetsActive: number;
    assetsHighCriticality: number;
    assetsRetired: number;

    // Findings
    findingsOpen: number;
}

/**
 * Complete trend payload.
 */
export interface TrendPayload {
    /** Ordered array of data points, oldest first */
    dataPoints: TrendDataPoint[];
    /** Number of days requested */
    daysRequested: number;
    /** Number of data points returned (may be < daysRequested if snapshots are missing) */
    daysAvailable: number;
    /** ISO 8601 range start */
    rangeStart: string;
    /** ISO 8601 range end */
    rangeEnd: string;
}

// ─── Conversion ─────────────────────────────────────────────────────

/**
 * Convert a Prisma ComplianceSnapshot row to a chart-friendly DTO.
 */
function toDataPoint(s: ComplianceSnapshot): TrendDataPoint {
    return {
        date: s.snapshotDate.toISOString().slice(0, 10),
        controlCoveragePercent: s.controlCoverageBps / 10,
        controlsImplemented: s.controlsImplemented,
        controlsApplicable: s.controlsApplicable,
        evidenceOverdue: s.evidenceOverdue,
        evidenceDueSoon7d: s.evidenceDueSoon7d,
        evidenceCurrent: s.evidenceCurrent,
        policiesTotal: s.policiesTotal,
        policiesOverdueReview: s.policiesOverdueReview,
        tasksOpen: s.tasksOpen,
        tasksOverdue: s.tasksOverdue,
        assetsTotal: s.assetsTotal,
        assetsActive: s.assetsActive,
        assetsHighCriticality: s.assetsHighCriticality,
        assetsRetired: s.assetsRetired,
        findingsOpen: s.findingsOpen,
    };
}

// ─── Usecase ────────────────────────────────────────────────────────

/**
 * Retrieve compliance trend data for the last N days.
 *
 * Uses the ComplianceSnapshot table — no live aggregation from
 * operational tables. Fast O(days) query on the composite index.
 *
 * @param ctx — tenant-scoped request context
 * @param days — number of days of history (default: 90, max: 365)
 * @returns ordered trend data points
 */
export async function getComplianceTrends(
    ctx: RequestContext,
    days: number = 90,
): Promise<TrendPayload> {
    assertCanRead(ctx);

    const effectiveDays = Math.min(Math.max(days, 1), 365);
    const rangeEnd = new Date();
    const rangeStart = new Date(rangeEnd.getTime() - effectiveDays * 86400000);

    // Zero out times for clean date comparison
    rangeStart.setUTCHours(0, 0, 0, 0);
    rangeEnd.setUTCHours(23, 59, 59, 999);

    return runInTenantContext(ctx, async (db) => {
        const snapshots = await db.complianceSnapshot.findMany({
            where: {
                tenantId: ctx.tenantId,
                snapshotDate: {
                    gte: rangeStart,
                    lte: rangeEnd,
                },
            },
            orderBy: { snapshotDate: 'asc' },
        });

        const dataPoints = snapshots.map(toDataPoint);

        return {
            dataPoints,
            daysRequested: effectiveDays,
            daysAvailable: dataPoints.length,
            rangeStart: rangeStart.toISOString(),
            rangeEnd: rangeEnd.toISOString(),
        };
    });
}
