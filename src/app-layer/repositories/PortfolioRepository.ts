/**
 * Epic O-3 — portfolio data access.
 *
 * Three read-only methods that drive every portfolio aggregation
 * usecase. All three use `runInGlobalContext` (i.e. the global
 * Prisma client, postgres role) — these queries cross tenant
 * boundaries by design and the rows being read are aggregate
 * snapshots + tenant metadata, NOT per-tenant business data.
 *
 * Drill-down into actual tenant tables (controls, evidence)
 * MUST go through the standard `runInTenantContext` path with the
 * CISO's auto-provisioned AUDITOR membership. That's a separate
 * Epic O-3 step (cross-tenant lists). This repository covers only
 * the snapshot-driven summary view.
 *
 * Why static methods on a class: matches `DashboardRepository` for
 * codebase consistency. The class is purely a namespace; no state.
 */
import type { ComplianceSnapshot } from '@prisma/client';

import { runInGlobalContext } from '@/lib/db-context';

// ── Types ────────────────────────────────────────────────────────────

export interface OrgTenantMeta {
    id: string;
    slug: string;
    name: string;
}

/**
 * Aggregated trend row — one per snapshotDate, summed across the
 * supplied tenant set. Coverage is computed downstream from the
 * implemented/applicable sums (so the org-wide percentage stays
 * weighted by control counts, not by tenant count).
 */
export interface SnapshotTrendRow {
    snapshotDate: Date;
    controlsApplicable: number;
    controlsImplemented: number;
    evidenceOverdue: number;
    evidenceDueSoon7d: number;
    evidenceCurrent: number;
    policiesTotal: number;
    policiesOverdueReview: number;
    tasksOpen: number;
    tasksOverdue: number;
    findingsOpen: number;
    /** How many tenants contributed to this row's sums. */
    tenantsContributing: number;
}

// ── Repository ───────────────────────────────────────────────────────

export class PortfolioRepository {
    /**
     * Resolve the tenants linked to an organization. Returns slug +
     * name alongside the id so callers don't need a second round-trip
     * to render rows.
     *
     * Returns rows ordered by name (case-insensitive) for stable UI.
     */
    static async getOrgTenantIds(orgId: string): Promise<OrgTenantMeta[]> {
        return runInGlobalContext(async (db) => {
            const tenants = await db.tenant.findMany({
                // Hide soft-deleted (org-removed) tenants from the
                // portfolio + the org tenants table.
                where: { organizationId: orgId, deletedAt: null },
                select: { id: true, slug: true, name: true },
                orderBy: { name: 'asc' },
            });
            return tenants;
        });
    }

    /**
     * Latest `ComplianceSnapshot` per tenant from the supplied set.
     *
     * Strategy: scope the read to the last 14 days (a tenant's snapshot
     * job runs daily, so 14 days is comfortable headroom for a
     * temporarily-paused job) and pick the most recent row per
     * `tenantId` in JS. Bounded read size: O(tenants × 14) rows max.
     *
     * Tenants with no snapshot in the window are omitted from the
     * result — callers detect "snapshot pending" by diffing the
     * returned tenantIds against the input list.
     */
    static async getLatestSnapshots(
        tenantIds: string[],
    ): Promise<ComplianceSnapshot[]> {
        if (tenantIds.length === 0) return [];

        const fourteenDaysAgo = new Date(Date.now() - 14 * 86400 * 1000);
        fourteenDaysAgo.setUTCHours(0, 0, 0, 0);

        return runInGlobalContext(async (db) => {
            const rows = await db.complianceSnapshot.findMany({
                where: {
                    tenantId: { in: tenantIds },
                    snapshotDate: { gte: fourteenDaysAgo },
                },
                orderBy: [{ tenantId: 'asc' }, { snapshotDate: 'desc' }],
            });

            // Pick first-seen-per-tenant. Because we sorted by
            // (tenantId asc, snapshotDate desc), the first row per
            // tenantId is the latest in the window.
            const latestByTenant = new Map<string, ComplianceSnapshot>();
            for (const row of rows) {
                if (!latestByTenant.has(row.tenantId)) {
                    latestByTenant.set(row.tenantId, row);
                }
            }
            return Array.from(latestByTenant.values());
        });
    }

    /**
     * Org-wide trend rows: snapshots in the supplied tenant set
     * grouped by `snapshotDate` and summed.
     *
     * Coverage % is NOT included in the row — callers compute it
     * downstream from `controlsImplemented / controlsApplicable` so
     * the math is centralised in the usecase layer (and so a future
     * change to "weighted by tenant" vs "weighted by controls" is a
     * one-place edit).
     *
     * `days` is clamped to [1, 365] to match the per-tenant
     * `getComplianceTrends` contract.
     */
    static async getSnapshotTrends(
        tenantIds: string[],
        days: number,
    ): Promise<SnapshotTrendRow[]> {
        if (tenantIds.length === 0) return [];

        const effectiveDays = Math.min(Math.max(days, 1), 365);
        const rangeEnd = new Date();
        rangeEnd.setUTCHours(23, 59, 59, 999);
        const rangeStart = new Date(
            rangeEnd.getTime() - effectiveDays * 86400 * 1000,
        );
        rangeStart.setUTCHours(0, 0, 0, 0);

        return runInGlobalContext(async (db) => {
            const grouped = await db.complianceSnapshot.groupBy({
                by: ['snapshotDate'],
                where: {
                    tenantId: { in: tenantIds },
                    snapshotDate: { gte: rangeStart, lte: rangeEnd },
                },
                _sum: {
                    controlsApplicable: true,
                    controlsImplemented: true,
                    evidenceOverdue: true,
                    evidenceDueSoon7d: true,
                    evidenceCurrent: true,
                    policiesTotal: true,
                    policiesOverdueReview: true,
                    tasksOpen: true,
                    tasksOverdue: true,
                    findingsOpen: true,
                },
                _count: {
                    tenantId: true,
                },
                orderBy: { snapshotDate: 'asc' },
            });

            return grouped.map((g) => ({
                snapshotDate: g.snapshotDate,
                controlsApplicable: g._sum.controlsApplicable ?? 0,
                controlsImplemented: g._sum.controlsImplemented ?? 0,
                evidenceOverdue: g._sum.evidenceOverdue ?? 0,
                evidenceDueSoon7d: g._sum.evidenceDueSoon7d ?? 0,
                evidenceCurrent: g._sum.evidenceCurrent ?? 0,
                policiesTotal: g._sum.policiesTotal ?? 0,
                policiesOverdueReview: g._sum.policiesOverdueReview ?? 0,
                tasksOpen: g._sum.tasksOpen ?? 0,
                tasksOverdue: g._sum.tasksOverdue ?? 0,
                findingsOpen: g._sum.findingsOpen ?? 0,
                tenantsContributing: g._count.tenantId,
            }));
        });
    }
}
