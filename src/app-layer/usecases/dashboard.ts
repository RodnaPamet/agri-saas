/**
 * Dashboard Usecases
 *
 * Provides:
 *  - getDashboardData  — existing minimal stats (backward compat)
 *  - getExecutiveDashboard — full executive KPI payload (single call)
 *
 * @module app-layer/usecases/dashboard
 */
import { RequestContext } from '../types';
import {
    DashboardRepository,
    type ExecutiveDashboardPayload,
} from '../repositories/DashboardRepository';
import { assertCanRead } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';

/**
 * Original dashboard data — used by the current dashboard page.
 * Backward-compatible; do not modify the return shape.
 */
export async function getDashboardData(ctx: RequestContext) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [stats, recentActivity] = await Promise.all([
            DashboardRepository.getStats(db, ctx),
            DashboardRepository.getRecentActivity(db, ctx),
        ]);

        return {
            stats,
            recentActivity,
        };
    });
}

/**
 * Executive Dashboard — aggregated KPI payload.
 *
 * Returns all KPIs in a single structured response to minimize
 * round trips from the frontend. All sub-queries run in parallel
 * within a single transaction for consistency.
 *
 * Query budget:
 * - stats:           ~11 parallel count queries
 * - controlCoverage:  1 groupBy + 1 count
 * - controlsByStatus: 1 groupBy
 * - riskBySeverity:   4 parallel counts
 * - riskByStatus:     1 groupBy
 * - evidenceExpiry:   5 parallel counts
 * - policySummary:    1 groupBy + 1 count
 * - taskSummary:      1 groupBy + 1 count
 * - vendorSummary:    2 counts
 * Total: ~30 lightweight COUNT/GROUP BY on indexed columns
 * Expected latency: <100ms on a warm connection pool
 */
export async function getExecutiveDashboard(ctx: RequestContext): Promise<ExecutiveDashboardPayload> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [
            stats,
            controlCoverage,
            controlsByStatus,
            riskBySeverity,
            riskByStatus,
            evidenceExpiry,
            policySummary,
            taskSummary,
            vendorSummary,
            upcomingExpirations,
            treatmentPlans,
        ] = await Promise.all([
            DashboardRepository.getStats(db, ctx),
            DashboardRepository.getControlCoverage(db, ctx),
            DashboardRepository.getControlsByStatus(db, ctx),
            DashboardRepository.getRiskBySeverity(db, ctx),
            DashboardRepository.getRiskByStatus(db, ctx),
            DashboardRepository.getEvidenceExpiry(db, ctx),
            DashboardRepository.getPolicySummary(db, ctx),
            DashboardRepository.getTaskSummary(db, ctx),
            DashboardRepository.getVendorSummary(db, ctx),
            DashboardRepository.getUpcomingExpirations(db, ctx),
            DashboardRepository.getTreatmentPlanSummary(db, ctx),
        ]);

        return {
            stats,
            controlCoverage,
            controlsByStatus,
            riskBySeverity,
            riskByStatus,
            evidenceExpiry,
            policySummary,
            taskSummary,
            vendorSummary,
            upcomingExpirations,
            treatmentPlans,
            computedAt: new Date().toISOString(),
        };
    });
}
