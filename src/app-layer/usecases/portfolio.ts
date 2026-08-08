/**
 * Epic O-3 — portfolio aggregation usecases.
 *
 * Three pure functions that turn snapshot reads into the typed
 * DTOs the org dashboard renders:
 *
 *   - `getPortfolioSummary(ctx)`           org-wide totals + RAG bucket counts
 *   - `getPortfolioTenantHealth(ctx)`      per-tenant rows for the portfolio table
 *   - `getPortfolioTrends(ctx, days)`      org-wide time-series for charting
 *
 * All three are read-only, side-effect-free, and consume the
 * `PortfolioRepository` for data access. RLS posture: the repository
 * runs every query against the global Prisma client (postgres role)
 * because the rows it touches — `Tenant` (metadata only) and
 * `ComplianceSnapshot` (org-wide aggregates) — are read at the
 * org-management layer, not the per-tenant data plane. Drill-down
 * INTO any tenant goes through standard `runInTenantContext` with
 * the CISO's auto-provisioned AUDITOR membership; that's a separate
 * Epic O-3 follow-up.
 *
 * Authorization: callers must pass an `OrgContext` (i.e. they came
 * through `getOrgCtx` and were verified as an OrgMembership holder).
 * The usecases additionally check `canViewPortfolio` so an
 * un-permitted org role can't sneak in via direct usecase
 * invocation.
 */

import type { OrgContext } from '@/app-layer/types';
import { forbidden } from '@/lib/errors/types';
import {
    PortfolioRepository,
    type OrgTenantMeta,
    type SnapshotTrendRow,
} from '@/app-layer/repositories/PortfolioRepository';
import {
    type PortfolioSummary,
    type TenantHealthRow,
    type PortfolioTrend,
    type PortfolioTrendDataPoint,
    type NonPerformingControlRow,
    type CriticalRiskRow,
    type OverdueEvidenceRow,
    type PaginatedDrillDownInput,
    type PaginatedDrillDownResult,
    DEFAULT_DRILLDOWN_PAGE_LIMIT,
    MAX_DRILLDOWN_PAGE_LIMIT,
    computeRag,
} from '@/app-layer/schemas/portfolio';
import {
    getPortfolioData,
    type PortfolioBaseData,
} from '@/app-layer/usecases/portfolio-data';
import { withTenantDb } from '@/lib/db-context';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

// ── Internal helpers ──────────────────────────────────────────────────

function bpsToPercent(bps: number): number {
    return bps / 10;
}

/** Avoid divide-by-zero for the org-wide coverage. Returns 0 when the
 *  org has no applicable controls anywhere. */
function safeCoveragePercent(implemented: number, applicable: number): number {
    if (applicable <= 0) return 0;
    return Math.min(100, Math.max(0, (implemented / applicable) * 100));
}

function toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function trendRowToDataPoint(row: SnapshotTrendRow): PortfolioTrendDataPoint {
    return {
        date: toIsoDate(row.snapshotDate),
        controlCoveragePercent: safeCoveragePercent(
            row.controlsImplemented,
            row.controlsApplicable,
        ),
        controlsImplemented: row.controlsImplemented,
        controlsApplicable: row.controlsApplicable,
        evidenceOverdue: row.evidenceOverdue,
        evidenceDueSoon7d: row.evidenceDueSoon7d,
        evidenceCurrent: row.evidenceCurrent,
        policiesTotal: row.policiesTotal,
        policiesOverdueReview: row.policiesOverdueReview,
        tasksOpen: row.tasksOpen,
        tasksOverdue: row.tasksOverdue,
        findingsOpen: row.findingsOpen,
    };
}

function assertCanViewPortfolio(ctx: OrgContext): void {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden('Portfolio view requires an active org membership');
    }
}

// ═════════════════════════════════════════════════════════════════════
// Shared base-data loader + pure projections
// ═════════════════════════════════════════════════════════════════════
//
// `getPortfolioSummary` and `getPortfolioTenantHealth` both rely on
// the same two upstream reads:
//
//   1. PortfolioRepository.getOrgTenantIds(orgId)
//   2. PortfolioRepository.getLatestSnapshots(tenantIds)
//
// Epic E.3 — the cross-usecase deduplication moved to the canonical
// `getPortfolioData(orgId, options)` helper in
// `./portfolio-data.ts`. That helper memoises both reads PER
// REQUEST (keyed on the AsyncLocalStorage RequestContext via a
// WeakMap), so multiple usecases composed in the same request — e.g.
// the CSV export's summary + health + 3 drill-downs — all share a
// single tenants fetch and a single snapshots fetch. Outside a
// request scope the helper falls through to direct repo calls,
// preserving the unmemoised behaviour for background jobs / scripts.
//
// The standalone usecases below stay supported for the API route's
// per-view dispatch (`view=summary` / `view=health` / `view=trends`)
// where each request only needs one DTO. Both the per-view path and
// the orchestrator now share the same memoised upstream.

function projectPortfolioSummary(
    ctx: OrgContext,
    base: PortfolioBaseData,
): PortfolioSummary {
    const { tenants, snapshots, snapshotsByTenant } = base;

    let controlsApplicable = 0;
    let controlsImplemented = 0;
    let evidenceTotal = 0;
    let evidenceOverdue = 0;
    let evidenceDueSoon7d = 0;
    let policiesTotal = 0;
    let policiesOverdueReview = 0;
    let tasksOpen = 0;
    let tasksOverdue = 0;
    let findingsOpen = 0;

    let green = 0;
    let amber = 0;
    let red = 0;
    let pending = 0;

    for (const t of tenants) {
        const s = snapshotsByTenant.get(t.id);
        if (!s) {
            pending++;
            continue;
        }
        controlsApplicable += s.controlsApplicable;
        controlsImplemented += s.controlsImplemented;
        evidenceTotal += s.evidenceTotal;
        evidenceOverdue += s.evidenceOverdue;
        evidenceDueSoon7d += s.evidenceDueSoon7d;
        policiesTotal += s.policiesTotal;
        policiesOverdueReview += s.policiesOverdueReview;
        tasksOpen += s.tasksOpen;
        tasksOverdue += s.tasksOverdue;
        findingsOpen += s.findingsOpen;

        const rag = computeRag({
            coveragePercent: bpsToPercent(s.controlCoverageBps),
            overdueEvidence: s.evidenceOverdue,
        });
        if (rag === 'GREEN') green++;
        else if (rag === 'AMBER') amber++;
        else red++;
    }

    return {
        organizationId: ctx.organizationId,
        organizationSlug: ctx.orgSlug,
        generatedAt: new Date().toISOString(),
        tenants: {
            total: tenants.length,
            snapshotted: snapshots.length,
            pending,
        },
        controls: {
            applicable: controlsApplicable,
            implemented: controlsImplemented,
            coveragePercent: safeCoveragePercent(
                controlsImplemented,
                controlsApplicable,
            ),
        },
        evidence: {
            total: evidenceTotal,
            overdue: evidenceOverdue,
            dueSoon7d: evidenceDueSoon7d,
        },
        policies: {
            total: policiesTotal,
            overdueReview: policiesOverdueReview,
        },
        tasks: {
            open: tasksOpen,
            overdue: tasksOverdue,
        },
        findings: {
            open: findingsOpen,
        },
        rag: { green, amber, red, pending },
    };
}

function projectPortfolioTenantHealth(base: PortfolioBaseData): TenantHealthRow[] {
    const { tenants, snapshotsByTenant } = base;
    return tenants.map((t): TenantHealthRow => {
        const s = snapshotsByTenant.get(t.id);
        if (!s) {
            return {
                tenantId: t.id,
                slug: t.slug,
                name: t.name,
                drillDownUrl: `/t/${t.slug}/dashboard`,
                hasSnapshot: false,
                snapshotDate: null,
                coveragePercent: null,
                overdueEvidence: null,
                rag: null,
            };
        }
        const coveragePercent = bpsToPercent(s.controlCoverageBps);
        return {
            tenantId: t.id,
            slug: t.slug,
            name: t.name,
            drillDownUrl: `/t/${t.slug}/dashboard`,
            hasSnapshot: true,
            snapshotDate: toIsoDate(s.snapshotDate),
            coveragePercent,
            overdueEvidence: s.evidenceOverdue,
            rag: computeRag({
                coveragePercent,
                overdueEvidence: s.evidenceOverdue,
            }),
        };
    });
}

function clampTrendDays(days: number): number {
    return Math.min(Math.max(days, 1), 365);
}

function projectPortfolioTrends(
    organizationId: string,
    effectiveDays: number,
    rows: SnapshotTrendRow[],
): PortfolioTrend {
    const rangeEnd = new Date();
    rangeEnd.setUTCHours(23, 59, 59, 999);
    const rangeStart = new Date(
        rangeEnd.getTime() - effectiveDays * 86400 * 1000,
    );
    rangeStart.setUTCHours(0, 0, 0, 0);

    const dataPoints = rows.map(trendRowToDataPoint);
    const tenantsAggregated =
        rows.length > 0 ? Math.max(...rows.map((r) => r.tenantsContributing)) : 0;

    return {
        organizationId,
        daysRequested: effectiveDays,
        daysAvailable: dataPoints.length,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        tenantsAggregated,
        dataPoints,
    };
}

// ── getPortfolioSummary ───────────────────────────────────────────────

export async function getPortfolioSummary(
    ctx: OrgContext,
): Promise<PortfolioSummary> {
    assertCanViewPortfolio(ctx);
    const base = await getPortfolioData(ctx.organizationId);
    return projectPortfolioSummary(ctx, base);
}

// ── getPortfolioTenantHealth ──────────────────────────────────────────

export async function getPortfolioTenantHealth(
    ctx: OrgContext,
): Promise<TenantHealthRow[]> {
    assertCanViewPortfolio(ctx);
    const base = await getPortfolioData(ctx.organizationId);
    return projectPortfolioTenantHealth(base);
}

// ── getPortfolioTrends ────────────────────────────────────────────────

// ── Cross-tenant drill-downs (RLS-enforced) ──────────────────────────
//
// CRITICAL SECURITY INVARIANT: these usecases iterate the org's
// tenants and run each per-tenant query INSIDE `withTenantDb(tid)`.
// That helper:
//   1. Enters a Prisma transaction
//   2. SET LOCAL ROLE app_user                  ← drops privilege
//   3. SELECT set_config('app.tenant_id', $1)    ← binds tenant ctx
//
// Inside the callback, every read against tenant-scoped tables runs
// under FORCE ROW LEVEL SECURITY. The CISO is granted read access
// only because the Epic O-2 auto-provisioning service created an
// AUDITOR `TenantMembership` for them in each child tenant. Without
// that membership, the per-tenant query returns ZERO rows — the
// portfolio drill-down never crosses tenant boundaries via a
// privilege bypass; it just walks N legitimate per-tenant queries.
//
// Reasoning about why this is correct:
//   - We do NOT call `runInGlobalContext` for per-row business data.
//   - We do NOT issue a single cross-tenant query against the
//     business tables — every query targets exactly one tenantId.
//   - If the CISO is removed as ORG_ADMIN, the deprovision usecase
//     deletes their AUDITOR rows, and the same drill-down loop
//     starts returning zero rows per tenant (empty results, no
//     errors) — the security envelope shrinks automatically.
//
// Performance posture:
//   100 tenants × ~5ms indexed query per tenant ≈ ~500ms total
//   sequential. Acceptable for a dashboard load. For 200+ tenants
//   the architecture doc proposes chunked Promise.all(10) or a
//   materialised cross-tenant view; both are out of scope here.
//
// Per-tenant `take` is 20 — bounds the worst-case row count to
// 100 × 20 = 2000 candidates. The final result list is capped at 50
// after global sort (so the UI stays snappy and the worst-case
// payload is a few KB).

const PER_TENANT_LIMIT = 20;
const PORTFOLIO_DRILLDOWN_LIMIT = 50;

/**
 * Generic per-tenant fan-out helper. Runs `query` once per tenant
 * inside its own RLS-enforced transaction, then flattens + applies
 * `sortAndLimit` to the merged result.
 *
 * Each per-tenant call is awaited sequentially. Sequential is the
 * safe default — `withTenantDb` opens a transaction per call, and a
 * burst of 100 parallel transactions could exhaust the connection
 * pool. The work is small enough (~5ms each) that the total stays
 * inside dashboard-load budgets.
 */
async function fanOutPerTenant<TRow>(
    tenants: OrgTenantMeta[],
    query: (db: import('@/lib/db-context').PrismaTx, tenant: OrgTenantMeta) => Promise<TRow[]>,
    sortAndLimit: (rows: TRow[]) => TRow[],
): Promise<TRow[]> {
    if (tenants.length === 0) return [];
    const merged: TRow[] = [];
    for (const t of tenants) {
        const rows = await withTenantDb(t.id, (db) => query(db, t));
        merged.push(...rows);
    }
    return sortAndLimit(merged);
}

// ── Auditor fan-out integrity check ───────────────────────────────────
//
// Cross-tenant drill-down relies on the org-admin's auto-provisioned
// AUDITOR `TenantMembership` in every child tenant of the org — the
// `withTenantDb(tenantId, ...)` callback runs as `app_user` and the
// per-tenant query gets through RLS BECAUSE the user has SOME
// membership in that tenant. Without a membership row the per-tenant
// query returns zero rows and the drill-down silently shows "no
// issues found", which is dangerously misleading when the real
// problem is that auto-provisioning got out of sync (manual delete,
// failed deploy, rare race during tenant creation, etc.).
//
// `checkAuditorFanOutIntegrity` runs ONCE before iteration. It:
//
//   1. Queries the user's `TenantMembership` rows scoped to the
//      org's tenants (single indexed read).
//   2. Diffs against the org tenant list. Tenants the user has NO
//      membership in are flagged as drift.
//   3. Emits a structured `portfolio.auditor_fanout_drift` warning
//      if any drift is found, naming the affected tenant ids so
//      ops can correlate with the auto-provisioning service logs.
//   4. Returns the filtered subset of accessible tenants so the
//      iteration only touches tenants where the user has SOME
//      membership row — preserving the existing RLS contract while
//      avoiding "phantom empty" results from inaccessible tenants.
//
// The check accepts ANY membership role (not strictly AUDITOR). The
// auto-provisioning service writes AUDITOR rows tagged with
// `provisionedByOrgId`, but a CISO who's also been MANUALLY granted
// OWNER in one tenant has access via that manual row — drill-down
// works there too, and we shouldn't spuriously warn. Drift is
// strictly "this user has zero rows for tenant X", not "this user
// doesn't have an AUDITOR row".
//
// Performance: one `findMany` against the indexed
// `TenantMembership(tenantId, userId)` column. ~1ms regardless of org
// size; cheap insurance against silent drill-down corruption.

interface AuditorFanOutIntegrityResult {
    /** Tenants where the current user has SOME TenantMembership.
     *  Drill-down iterates only these. */
    accessibleTenants: OrgTenantMeta[];
    /** Tenant ids in the org where the user has NO TenantMembership.
     *  Empty when fan-out is healthy. */
    missingTenantIds: string[];
}

async function checkAuditorFanOutIntegrity(
    ctx: OrgContext,
    tenants: OrgTenantMeta[],
): Promise<AuditorFanOutIntegrityResult> {
    if (tenants.length === 0) {
        return { accessibleTenants: [], missingTenantIds: [] };
    }

    const tenantIds = tenants.map((t) => t.id);
    const memberships = await prisma.tenantMembership.findMany({
        where: {
            userId: ctx.userId,
            tenantId: { in: tenantIds },
        },
        select: { tenantId: true },
    });
    const accessibleSet = new Set(memberships.map((m) => m.tenantId));

    const missingTenantIds = tenantIds.filter((id) => !accessibleSet.has(id));
    const accessibleTenants = tenants.filter((t) => accessibleSet.has(t.id));

    if (missingTenantIds.length > 0) {
        logger.warn('portfolio.auditor_fanout_drift', {
            component: 'portfolio',
            organizationId: ctx.organizationId,
            orgSlug: ctx.orgSlug,
            userId: ctx.userId,
            requestId: ctx.requestId,
            totalTenants: tenants.length,
            accessibleTenants: accessibleTenants.length,
            missingTenantIds,
            // Operator hint — the most likely root cause when this
            // fires for an ORG_ADMIN whose drill-down should be
            // complete by design.
            hint:
                'Auto-provisioned AUDITOR memberships are missing for this user in the listed tenants. Re-run provisionOrgAdminToTenants(orgId, userId) or inspect tenantMembership for manual deletions.',
        });
    }

    return { accessibleTenants, missingTenantIds };
}

// Status priority for the non-performing controls sort. Higher number
// = more urgent. Locks the visual ordering: NEEDS_REVIEW first
// (something acted-on but not finished), then NOT_STARTED (forgotten),
// then in-flight states.
const CONTROL_STATUS_PRIORITY: Record<string, number> = {
    NEEDS_REVIEW: 5,
    NOT_STARTED: 4,
    PLANNED: 3,
    IN_PROGRESS: 2,
    IMPLEMENTING: 1,
};

export async function getNonPerformingControls(
    ctx: OrgContext,
): Promise<NonPerformingControlRow[]> {
    assertCanViewPortfolio(ctx);
    // Drill-down only needs the tenant list — opt out of the
    // snapshots fetch. The tenants read still memoises in-request,
    // so a CSV export's 5 portfolio usecases share a single fetch.
    const { tenants } = await getPortfolioData(ctx.organizationId, {
        includeSnapshots: false,
    });
    const integrity = await checkAuditorFanOutIntegrity(ctx, tenants);

    return fanOutPerTenant<NonPerformingControlRow>(
        integrity.accessibleTenants,
        async (db, tenant) => {
            const rows = await db.control.findMany({
                where: {
                    tenantId: tenant.id,
                    status: { notIn: ['IMPLEMENTED', 'NOT_APPLICABLE'] },
                    applicability: 'APPLICABLE',
                    deletedAt: null,
                },
                select: {
                    id: true,
                    name: true,
                    code: true,
                    status: true,
                    updatedAt: true,
                },
                orderBy: { updatedAt: 'desc' },
                take: PER_TENANT_LIMIT,
            });
            return rows.map((c): NonPerformingControlRow => ({
                controlId: c.id,
                tenantId: tenant.id,
                tenantSlug: tenant.slug,
                tenantName: tenant.name,
                name: c.name,
                code: c.code ?? null,
                // The Prisma enum is a TS string union by codegen; the DTO
                // narrows to the non-performing subset via Zod at the API
                // boundary. The runtime invariant matches because the
                // findMany WHERE clause excludes the two terminal states.
                status: c.status as NonPerformingControlRow['status'],
                updatedAt: c.updatedAt.toISOString(),
                drillDownUrl: `/t/${tenant.slug}/controls/${c.id}`,
            }));
        },
        (rows) =>
            rows
                .sort((a, b) => {
                    const pa = CONTROL_STATUS_PRIORITY[a.status] ?? 0;
                    const pb = CONTROL_STATUS_PRIORITY[b.status] ?? 0;
                    if (pa !== pb) return pb - pa;
                    return b.updatedAt.localeCompare(a.updatedAt);
                })
                .slice(0, PORTFOLIO_DRILLDOWN_LIMIT),
    );
}


export async function getOverdueEvidenceAcrossOrg(
    ctx: OrgContext,
): Promise<OverdueEvidenceRow[]> {
    assertCanViewPortfolio(ctx);
    const { tenants } = await getPortfolioData(ctx.organizationId, {
        includeSnapshots: false,
    });
    const integrity = await checkAuditorFanOutIntegrity(ctx, tenants);
    const now = new Date();
    const dayMs = 86400 * 1000;

    return fanOutPerTenant<OverdueEvidenceRow>(
        integrity.accessibleTenants,
        async (db, tenant) => {
            const rows = await db.evidence.findMany({
                where: {
                    tenantId: tenant.id,
                    nextReviewDate: { lt: now },
                    status: { not: 'APPROVED' },
                    deletedAt: null,
                },
                select: {
                    id: true,
                    title: true,
                    nextReviewDate: true,
                    status: true,
                },
                // Oldest overdue first — most urgent at the top of the
                // per-tenant slice. The merged sort below applies the
                // same ordering globally.
                orderBy: { nextReviewDate: 'asc' },
                take: PER_TENANT_LIMIT,
            });
            return rows
                // findMany WHERE has nextReviewDate < now, but Prisma
                // narrows the field to `Date | null`. Filter the type.
                .filter(
                    (e): e is typeof e & { nextReviewDate: Date } =>
                        e.nextReviewDate !== null,
                )
                .map((e): OverdueEvidenceRow => {
                    const ms = now.getTime() - e.nextReviewDate.getTime();
                    return {
                        evidenceId: e.id,
                        tenantId: tenant.id,
                        tenantSlug: tenant.slug,
                        tenantName: tenant.name,
                        title: e.title,
                        nextReviewDate: e.nextReviewDate.toISOString().slice(0, 10),
                        daysOverdue: Math.max(1, Math.floor(ms / dayMs)),
                        status: e.status as OverdueEvidenceRow['status'],
                        drillDownUrl: `/t/${tenant.slug}/evidence/${e.id}`,
                    };
                });
        },
        (rows) =>
            rows
                .sort((a, b) => b.daysOverdue - a.daysOverdue)
                .slice(0, PORTFOLIO_DRILLDOWN_LIMIT),
    );
}

export async function getPortfolioTrends(
    ctx: OrgContext,
    days: number = 90,
): Promise<PortfolioTrend> {
    assertCanViewPortfolio(ctx);
    const effectiveDays = clampTrendDays(days);
    // Trends only needs the tenantIds; skip the snapshots fetch.
    // In-request memoisation still hits when the trends usecase runs
    // alongside summary/health (e.g. inside getPortfolioOverview).
    const { tenants } = await getPortfolioData(ctx.organizationId, {
        includeSnapshots: false,
    });
    const tenantIds = tenants.map((t) => t.id);
    const rows = await PortfolioRepository.getSnapshotTrends(tenantIds, effectiveDays);
    return projectPortfolioTrends(ctx.organizationId, effectiveDays, rows);
}

// ── getPortfolioOverview ──────────────────────────────────────────────

export interface PortfolioOverview {
    summary: PortfolioSummary;
    tenantHealth: TenantHealthRow[];
    trends: PortfolioTrend;
}

export interface GetPortfolioOverviewOptions {
    /** Trend window in days. Clamped to [1, 365]. Default 90. */
    trendDays?: number;
}

/**
 * Single-fetch orchestrator for the org overview page.
 *
 * Loads the base data (tenant list + latest snapshots) ONCE and runs
 * the trend query in parallel against the same tenant list, then
 * projects all three DTOs. Replaces the previous `Promise.all([
 * getPortfolioSummary, getPortfolioTenantHealth, getPortfolioTrends ])`
 * pattern which fired three independent `getOrgTenantIds` and two
 * independent `getLatestSnapshots` queries.
 *
 * Net DB calls: 3 (tenants × 1, latestSnapshots × 1, trends × 1)
 * regardless of how many downstream DTOs reuse the same base.
 *
 * The standalone `getPortfolioSummary`, `getPortfolioTenantHealth`,
 * and `getPortfolioTrends` continue to support per-view API
 * dispatch (`view=summary` / `view=health` / `view=trends`) where
 * each request only needs one DTO and the shared-fetch saving
 * doesn't apply.
 */
export async function getPortfolioOverview(
    ctx: OrgContext,
    options: GetPortfolioOverviewOptions = {},
): Promise<PortfolioOverview> {
    assertCanViewPortfolio(ctx);
    const effectiveDays = clampTrendDays(options.trendDays ?? 90);

    // Orchestrator is its own one-shot path: the overview page is
    // the only caller, and it composes summary + health + trends in
    // a single render. We fetch tenants once, then run snapshots +
    // trends concurrently — one tenants call, one snapshots call,
    // one trends call. (The shared `getPortfolioData` helper exists
    // for cross-usecase deduplication paths like the CSV export
    // route which composes 5 separate usecases; here we already
    // have the shape we want.)
    const tenants = await PortfolioRepository.getOrgTenantIds(ctx.organizationId);
    const tenantIds = tenants.map((t) => t.id);

    const [snapshots, trendRows] = await Promise.all([
        PortfolioRepository.getLatestSnapshots(tenantIds),
        PortfolioRepository.getSnapshotTrends(tenantIds, effectiveDays),
    ]);

    const base: PortfolioBaseData = {
        tenants,
        snapshots,
        snapshotsByTenant: new Map(snapshots.map((s) => [s.tenantId, s])),
    };

    return {
        summary: projectPortfolioSummary(ctx, base),
        tenantHealth: projectPortfolioTenantHealth(base),
        trends: projectPortfolioTrends(ctx.organizationId, effectiveDays, trendRows),
    };
}

// ═════════════════════════════════════════════════════════════════════
// Paginated drill-down (cursor-based)
// ═════════════════════════════════════════════════════════════════════
//
// The dashboard summary (`getNonPerformingControls`,
// `getCriticalRisksAcrossOrg`, `getOverdueEvidenceAcrossOrg`) caps at
// `PORTFOLIO_DRILLDOWN_LIMIT` (50) and is the right shape for a
// summary card. The dedicated drill-down pages need to browse beyond
// that — this section adds `list*` counterparts that take a cursor +
// limit and return rows with a `nextCursor` for the next page.
//
// Sort order is identical to the dashboard sort, so page 1 of the
// paginated view matches the dashboard preview's first 50 rows.
//
// Per-tenant query strategy:
//   - Each tenant runs its own `withTenantDb` transaction (RLS).
//   - The cursor predicate is applied at the per-tenant `where` so
//     each tenant only returns rows that come AFTER the cursor in
//     the global merged sort. No row from any tenant is re-emitted.
//   - Per-tenant `take = limit + 1` over-fetches to cover merge.
//   - Merge in memory, sort with the global comparator, take limit + 1
//     overall, encode `nextCursor` from the limit-th row when present.
//
// The cursor is opaque base64-JSON. Shape is per-entity:
//   Controls : { p: number, d: string, i: string }   priority + updatedAt + id
//   Risks    : { s: number, d: string, i: string }   inherentScore + updatedAt + id
//   Evidence : { d: string, i: string }              nextReviewDate + id
//
// `id` is the entity row id (cuid). It's per-tenant unique under
// Prisma cuid; cuid collisions across tenants are vanishingly
// unlikely at the platform's target scale (no observed instance in
// 50M+ rows).

const PER_TENANT_PAGINATED_LIMIT_FACTOR = 2;
const PER_TENANT_PAGINATED_FLOOR = 25;

function clampPageLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_DRILLDOWN_PAGE_LIMIT;
    return Math.max(1, Math.min(MAX_DRILLDOWN_PAGE_LIMIT, Math.floor(limit)));
}

function perTenantTake(limit: number): number {
    // Each tenant fetches enough rows to (a) fill the merge for the
    // worst case where one tenant dominates and (b) stay bounded so
    // a 200-tenant org doesn't OOM. `limit * 2` covers most cases;
    // floor 25 ensures small-limit pages still over-fetch enough to
    // detect the next-page marker.
    return Math.max(PER_TENANT_PAGINATED_FLOOR, limit * PER_TENANT_PAGINATED_LIMIT_FACTOR) + 1;
}

function encodeJson<T>(payload: T): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeJson<T>(cursor: string | undefined): T | null {
    if (!cursor) return null;
    try {
        const json = Buffer.from(cursor, 'base64url').toString('utf-8');
        const parsed = JSON.parse(json);
        return parsed as T;
    } catch {
        return null;
    }
}

// ── Controls ─────────────────────────────────────────────────────────

interface ControlsCursor {
    /** Status priority (1-5). See CONTROL_STATUS_PRIORITY. */
    p: number;
    /** ISO timestamp of the last emitted row's updatedAt. */
    d: string;
    /** Last emitted row id. */
    i: string;
}

const STATUSES_AT_PRIORITY: Record<number, NonPerformingControlRow['status'][]> = {
    5: ['NEEDS_REVIEW'],
    4: ['NOT_STARTED'],
    3: ['PLANNED'],
    2: ['IN_PROGRESS'],
    1: ['IMPLEMENTING'],
};

function statusesAtOrBelow(priority: number): NonPerformingControlRow['status'][] {
    const out: NonPerformingControlRow['status'][] = [];
    for (let p = priority; p >= 1; p--) {
        out.push(...STATUSES_AT_PRIORITY[p]);
    }
    return out;
}

function statusesBelow(priority: number): NonPerformingControlRow['status'][] {
    return statusesAtOrBelow(priority - 1);
}

export async function listNonPerformingControls(
    ctx: OrgContext,
    input: PaginatedDrillDownInput = {},
): Promise<PaginatedDrillDownResult<NonPerformingControlRow>> {
    assertCanViewPortfolio(ctx);
    const limit = clampPageLimit(input.limit);
    const cursor = decodeJson<ControlsCursor>(input.cursor);
    const { tenants } = await getPortfolioData(ctx.organizationId, {
        includeSnapshots: false,
    });

    // Per-tenant where clause — applies the cursor compound predicate
    // when a cursor is supplied. The compound mirrors the global sort
    // order so no row from any tenant is re-emitted on subsequent
    // pages.
    const cursorWhere = cursor
        ? {
              OR: [
                  // Strictly lower priority — any status below cursor.p.
                  ...(statusesBelow(cursor.p).length > 0
                      ? [{ status: { in: statusesBelow(cursor.p) } }]
                      : []),
                  // Same priority bucket, older updatedAt.
                  {
                      AND: [
                          { status: { in: STATUSES_AT_PRIORITY[cursor.p] ?? [] } },
                          { updatedAt: { lt: new Date(cursor.d) } },
                      ],
                  },
                  // Same priority + same updatedAt — id tiebreaker.
                  {
                      AND: [
                          { status: { in: STATUSES_AT_PRIORITY[cursor.p] ?? [] } },
                          { updatedAt: new Date(cursor.d) },
                          { id: { gt: cursor.i } },
                      ],
                  },
              ],
          }
        : undefined;

    const merged = await fanOutPerTenant<NonPerformingControlRow>(
        tenants,
        async (db, tenant) => {
            const rows = await db.control.findMany({
                where: {
                    tenantId: tenant.id,
                    status: { notIn: ['IMPLEMENTED', 'NOT_APPLICABLE'] },
                    applicability: 'APPLICABLE',
                    deletedAt: null,
                    ...(cursorWhere ?? {}),
                },
                select: {
                    id: true,
                    name: true,
                    code: true,
                    status: true,
                    updatedAt: true,
                },
                orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                take: perTenantTake(limit),
            });
            return rows.map((c): NonPerformingControlRow => ({
                controlId: c.id,
                tenantId: tenant.id,
                tenantSlug: tenant.slug,
                tenantName: tenant.name,
                name: c.name,
                code: c.code ?? null,
                status: c.status as NonPerformingControlRow['status'],
                updatedAt: c.updatedAt.toISOString(),
                drillDownUrl: `/t/${tenant.slug}/controls/${c.id}`,
            }));
        },
        // Identity sortAndLimit — we apply the page-limit cut below.
        // Reusing fanOutPerTenant for the RLS plumbing only.
        (rows) => rows,
    );

    // Global merged sort: priority DESC, updatedAt DESC, id ASC.
    merged.sort((a, b) => {
        const pa = CONTROL_STATUS_PRIORITY[a.status] ?? 0;
        const pb = CONTROL_STATUS_PRIORITY[b.status] ?? 0;
        if (pa !== pb) return pb - pa;
        const cmp = b.updatedAt.localeCompare(a.updatedAt);
        if (cmp !== 0) return cmp;
        return a.controlId.localeCompare(b.controlId);
    });

    const trimmed = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
        hasMore && last
            ? encodeJson<ControlsCursor>({
                  p: CONTROL_STATUS_PRIORITY[last.status] ?? 0,
                  d: last.updatedAt,
                  i: last.controlId,
              })
            : null;

    return { rows: trimmed, nextCursor };
}

// ── Risks ────────────────────────────────────────────────────────────

interface RisksCursor {
    s: number;
    d: string;
    i: string;
}

// ── Evidence ─────────────────────────────────────────────────────────

interface EvidenceCursor {
    /** Full ISO timestamp (with milliseconds) for the last emitted
     *  row's nextReviewDate. The DTO carries a date-only string for
     *  display, but the cursor needs full precision so a `gt` against
     *  UTC-midnight doesn't re-emit same-day rows whose stored
     *  timestamp has a non-zero time-of-day. */
    d: string;
    i: string;
}

interface OverdueEvidenceRowInternal extends OverdueEvidenceRow {
    /** Original full timestamp, retained internally so the cursor
     *  encoder has full precision. Stripped from the DTO returned
     *  to the caller. */
    _fullNextReviewDate: string;
}

export async function listOverdueEvidenceAcrossOrg(
    ctx: OrgContext,
    input: PaginatedDrillDownInput = {},
): Promise<PaginatedDrillDownResult<OverdueEvidenceRow>> {
    assertCanViewPortfolio(ctx);
    const limit = clampPageLimit(input.limit);
    const cursor = decodeJson<EvidenceCursor>(input.cursor);
    const { tenants } = await getPortfolioData(ctx.organizationId, {
        includeSnapshots: false,
    });
    const now = new Date();
    const dayMs = 86400 * 1000;

    // Sort: nextReviewDate ASC (== daysOverdue DESC). After-cursor
    // predicate is `nextReviewDate > cursorDate OR (== AND id > cursorId)`.
    // Cursor encodes the FULL ISO timestamp of the last emitted row so
    // tied dates with non-zero time-of-day don't re-emit.
    const cursorWhere = cursor
        ? {
              OR: [
                  { nextReviewDate: { gt: new Date(cursor.d) } },
                  {
                      AND: [
                          { nextReviewDate: new Date(cursor.d) },
                          { id: { gt: cursor.i } },
                      ],
                  },
              ],
          }
        : undefined;

    const merged = await fanOutPerTenant<OverdueEvidenceRowInternal>(
        tenants,
        async (db, tenant) => {
            const rows = await db.evidence.findMany({
                where: {
                    tenantId: tenant.id,
                    nextReviewDate: { lt: now },
                    status: { not: 'APPROVED' },
                    deletedAt: null,
                    ...(cursorWhere ?? {}),
                },
                select: {
                    id: true,
                    title: true,
                    nextReviewDate: true,
                    status: true,
                },
                orderBy: [{ nextReviewDate: 'asc' }, { id: 'asc' }],
                take: perTenantTake(limit),
            });
            return rows
                .filter(
                    (e): e is typeof e & { nextReviewDate: Date } =>
                        e.nextReviewDate !== null,
                )
                .map((e): OverdueEvidenceRowInternal => {
                    const ms = now.getTime() - e.nextReviewDate.getTime();
                    return {
                        evidenceId: e.id,
                        tenantId: tenant.id,
                        tenantSlug: tenant.slug,
                        tenantName: tenant.name,
                        title: e.title,
                        nextReviewDate: e.nextReviewDate.toISOString().slice(0, 10),
                        daysOverdue: Math.max(1, Math.floor(ms / dayMs)),
                        status: e.status as OverdueEvidenceRow['status'],
                        drillDownUrl: `/t/${tenant.slug}/evidence/${e.id}`,
                        _fullNextReviewDate: e.nextReviewDate.toISOString(),
                    };
                });
        },
        (rows) => rows,
    );

    merged.sort((a, b) => {
        // Sort on the FULL timestamp so ties are resolved at
        // millisecond precision, matching the cursor predicate.
        const cmp = a._fullNextReviewDate.localeCompare(b._fullNextReviewDate);
        if (cmp !== 0) return cmp;
        return a.evidenceId.localeCompare(b.evidenceId);
    });

    const trimmed = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
        hasMore && last
            ? encodeJson<EvidenceCursor>({
                  d: last._fullNextReviewDate,
                  i: last.evidenceId,
              })
            : null;

    // Strip the internal precision field before handing rows back
    // to the DTO consumer.
    const publicRows: OverdueEvidenceRow[] = trimmed.map((r) => {
        const { _fullNextReviewDate: _, ...pub } = r;
        return pub;
    });

    return { rows: publicRows, nextCursor };
}
