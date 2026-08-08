/**
 * Compliance Snapshot Job — Daily KPI Trend Storage
 *
 * Generates one ComplianceSnapshot row per tenant per day.
 * Reuses the same aggregation queries from the executive dashboard
 * but writes the results to a denormalized time-series table.
 *
 * Idempotency:
 *   Uses Prisma `upsert` on the (tenantId, snapshotDate) unique index.
 *   Re-running for the same day overwrites previous values (latest wins).
 *
 * Architecture:
 *   ┌─────────────┐     ┌───────────────────┐     ┌────────────────────┐
 *   │  Scheduler   │────▶│  runSnapshotJob() │────▶│  ComplianceSnapshot │
 *   │  05:00 UTC   │     │  per-tenant loop  │     │  table (upsert)     │
 *   └─────────────┘     └───────────────────┘     └────────────────────┘
 *
 * @module app-layer/jobs/snapshot
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { DashboardRepository } from '../repositories/DashboardRepository';
import { withTenantDb } from '@/lib/db-context';
import type { RequestContext } from '../types';
import type { JobRunResult } from './types';
import { getPermissionsForRole } from '@/lib/permissions';

/**
 * Get UTC midnight for a given date — the canonical snapshot date key.
 */
export function toSnapshotDate(d: Date = new Date()): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Build a synthetic RequestContext for snapshot aggregation.
 * The snapshot job runs as a system process, not as a user request.
 * We use a pseudo-ADMIN context to enable full-read access to all
 * dashboard repository methods.
 */
function makeSystemCtx(tenantId: string): RequestContext {
    return {
        requestId: `snapshot-${tenantId}-${Date.now()}`,
        userId: 'system',
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Generate snapshots for all tenants (or a single tenant if specified).
 *
 * @param options.tenantId — if provided, snapshot only this tenant
 * @param options.date — snapshot date (default: today UTC)
 * @returns counts of tenants scanned, snapshotted, and skipped
 */
export async function runSnapshotJob(options?: {
    tenantId?: string;
    date?: Date;
}): Promise<{ result: JobRunResult; snapshotCount: number }> {
    return runJob('compliance-snapshot', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();
        const snapshotDate = toSnapshotDate(options?.date);

        // Get target tenants
        const tenants = options?.tenantId
            ? [{ id: options.tenantId }]
            : await prisma.tenant.findMany({ select: { id: true } });

        let snapshotted = 0;
        let errored = 0;

        for (const tenant of tenants) {
            try {
                await generateSnapshotForTenant(tenant.id, snapshotDate);
                snapshotted++;
            } catch (err) {
                errored++;
                // Log but don't abort — one failing tenant shouldn't block others
                // The runJob wrapper handles top-level observability
                logger.error('Snapshot failed for tenant', {
                    component: 'compliance-snapshot',
                    tenantId: tenant.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const result: JobRunResult = {
            jobName: 'compliance-snapshot',
            jobRunId: crypto.randomUUID(),
            success: errored === 0,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: tenants.length,
            itemsActioned: snapshotted,
            itemsSkipped: errored,
            details: { snapshotDate: snapshotDate.toISOString(), errored },
        };

        return { result, snapshotCount: snapshotted };
    });
}

/**
 * Generate a single snapshot for one tenant on a given date.
 *
 * Uses `upsert` for idempotency — re-running overwrites the previous
 * snapshot for the same (tenantId, snapshotDate) pair.
 *
 * All aggregation queries run within a single RLS-scoped transaction
 * for consistency.
 */
export async function generateSnapshotForTenant(
    tenantId: string,
    snapshotDate: Date,
): Promise<void> {
    const ctx = makeSystemCtx(tenantId);

    await withTenantDb(tenantId, async (db) => {
        // Run all aggregation queries in parallel within the transaction
        const [
            controlCoverage,
            evidenceExpiry,
            policySummary,
            taskSummary,
            vendorSummary,
            assetSummary,
            findingsOpen,
        ] = await Promise.all([
            DashboardRepository.getControlCoverage(db, ctx),
            DashboardRepository.getEvidenceExpiry(db, ctx),
            DashboardRepository.getPolicySummary(db, ctx),
            DashboardRepository.getTaskSummary(db, ctx),
            DashboardRepository.getVendorSummary(db, ctx),
            DashboardRepository.getAssetSummary(db, ctx),
            db.finding.count({ where: { tenantId, status: { not: 'CLOSED' } } }),
        ]);

        // Coverage BPS = coveragePercent × 10 (e.g. 75.3% → 753)
        const controlCoverageBps = Math.round(controlCoverage.coveragePercent * 10);

        const data = {
            // Controls
            controlsTotal: controlCoverage.total,
            controlsApplicable: controlCoverage.applicable,
            controlsImplemented: controlCoverage.implemented,
            controlsInProgress: controlCoverage.inProgress,
            controlsNotStarted: controlCoverage.notStarted,
            controlCoverageBps,

            // Risks
            // The GRC risk register was removed with the compliance uproot.
            // The snapshot columns stay (historical rows still carry real
            // values and the trend charts read them); new snapshots record
            // zero rather than a fabricated number.

            // Evidence
            evidenceTotal: evidenceExpiry.overdue + evidenceExpiry.dueSoon30d + evidenceExpiry.noReviewDate + evidenceExpiry.current,
            evidenceOverdue: evidenceExpiry.overdue,
            evidenceDueSoon7d: evidenceExpiry.dueSoon7d,
            evidenceDueSoon30d: evidenceExpiry.dueSoon30d,
            evidenceCurrent: evidenceExpiry.current,

            // Policies
            policiesTotal: policySummary.total,
            policiesPublished: policySummary.published,
            policiesOverdueReview: policySummary.overdueReview,

            // Tasks
            tasksTotal: taskSummary.total,
            tasksOpen: taskSummary.open,
            tasksOverdue: taskSummary.overdue,

            // Vendors
            vendorsTotal: vendorSummary.total,
            vendorsOverdueReview: vendorSummary.overdueReview,

            // Assets
            assetsTotal: assetSummary.total,
            assetsActive: assetSummary.active,
            assetsHighCriticality: assetSummary.highCriticality,
            assetsRetired: assetSummary.retired,

            // Findings
            findingsOpen,
        };

        // Upsert: idempotent — same (tenantId, snapshotDate) overwrites
        await db.complianceSnapshot.upsert({
            where: {
                tenantId_snapshotDate: { tenantId, snapshotDate },
            },
            create: {
                tenantId,
                snapshotDate,
                ...data,
            },
            update: data,
        });
    });
}
