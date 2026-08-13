/**
 * Metric Trends — Retrieval Layer
 *
 * Provides trend queries over the daily snapshot rollup:
 *  - 90-day KPI time series
 *  - Configurable date range
 *  - Tenant-scoped via RLS
 *
 * The surviving consumer is the `/assets` KPI sparkline strip (30 days of
 * asset history). GRC teardown phase 2 (plan §8f) trimmed the DTO to the
 * columns that are still computed — evidence, tasks and assets. The
 * practice / policy / vendor / finding columns still EXIST on the table and
 * still hold real historical values; they are dropped in the phase-3
 * migration, and nothing reads them in the meantime.
 *
 * @module app-layer/usecases/metric-trends
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

    // Evidence
    evidenceOverdue: number;
    evidenceDueSoon7d: number;
    evidenceCurrent: number;

    // Tasks
    tasksOpen: number;
    tasksOverdue: number;

    // Assets
    assetsTotal: number;
    assetsActive: number;
    assetsHighCriticality: number;
    assetsRetired: number;
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
        evidenceOverdue: s.evidenceOverdue,
        evidenceDueSoon7d: s.evidenceDueSoon7d,
        evidenceCurrent: s.evidenceCurrent,
        tasksOpen: s.tasksOpen,
        tasksOverdue: s.tasksOverdue,
        assetsTotal: s.assetsTotal,
        assetsActive: s.assetsActive,
        assetsHighCriticality: s.assetsHighCriticality,
        assetsRetired: s.assetsRetired,
    };
}

// ─── Usecase ────────────────────────────────────────────────────────

/**
 * Retrieve metric trend data for the last N days.
 *
 * Uses the ComplianceSnapshot table — no live aggregation from
 * operational tables. Fast O(days) query on the composite index.
 *
 * @param ctx — tenant-scoped request context
 * @param days — number of days of history (default: 90, max: 365)
 * @returns ordered trend data points
 */
export async function getMetricTrends(
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
