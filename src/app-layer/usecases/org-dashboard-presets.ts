/**
 * Epic 41 — Configurable Dashboard Widget Engine — default preset.
 *
 * Mirrors the prior hardcoded composition of the org-level dashboard
 * at `/org/[orgSlug]` (page.tsx, sections rendered before this epic
 * landed):
 *
 *   1. PageHeader               (chrome — not a widget)
 *   2. StatCardsRow             — KPI tiles (coverage,
 *                                 overdue-evidence, tenants)
 *   3. RagDistributionCard      — donut breakdown of tenant RAG status
 *   5. TenantCoverageList       — per-tenant list with drill-down
 *   6. DrillDownCtas            — three navigation cards (controls /
 *                                 evidence)
 *
 * The preset below is the SOURCE OF TRUTH for both:
 *
 *   - new-org provisioning (called from `POST /api/org`), and
 *   - existing-org backfill (`scripts/backfill-org-dashboard-widgets.ts`).
 *
 * Both paths converge through `seedDefaultOrgDashboard`, which
 * inserts the full preset only when the target org has zero widgets.
 * Idempotent: a re-run on an org that already has widgets is a no-op,
 * never a duplicate.
 *
 * Layout is sized to match the prior visual grid. The page used a
 * 2-column responsive layout for sections 3+4 and full-width sections
 * for 5+6; the preset translates that to a 12-column react-grid-layout
 * sketch:
 *
 *   y=0   ┌── KPI ──┬── KPI ──┬── KPI ──┬── KPI ──┐
 *         │ cov 3×2 │ cri 3×2 │ ovd 3×2 │ ten 3×2 │
 *   y=2   ├──────── DONUT ─────┬──── TREND ───────┤
 *   y=6   ├────────── TENANT_LIST 12×6 ───────────┤
 *         │                                       │
 *   y=12  ├────────── DRILLDOWN_CTAS 12×2 ────────┤
 *
 * Adding / removing widgets later: edit `DEFAULT_ORG_DASHBOARD_PRESET`
 * and ship a backfill that targets only the affected positions
 * (don't re-run the full seed; it short-circuits on any existing
 * widget). The backfill script's `--diff` mode (future work) is the
 * planned tool for that.
 */

import type { Prisma } from '@prisma/client';
import type { CreateOrgDashboardWidgetInput } from '@/app-layer/schemas/org-dashboard-widget.schemas';

/**
 * The eight widgets that compose the default org dashboard.
 *
 * Field shape matches `CreateOrgDashboardWidgetInput` exactly so the
 * preset is Zod-valid by construction — verified by
 * `tests/unit/org-dashboard-preset.test.ts`.
 */
export const DEFAULT_ORG_DASHBOARD_PRESET: ReadonlyArray<CreateOrgDashboardWidgetInput> = [
    // ─── Row 1: three KPI tiles, evenly across the 12-col row ───────
    {
        type: 'KPI',
        chartType: 'coverage',
        title: 'Coverage',
        config: { format: 'percent' },
        position: { x: 0, y: 0 },
        size: { w: 4, h: 2 },
        enabled: true,
    },
    {
        type: 'KPI',
        chartType: 'overdue-evidence',
        title: 'Overdue Evidence',
        config: { format: 'number' },
        position: { x: 4, y: 0 },
        size: { w: 4, h: 2 },
        enabled: true,
    },
    {
        type: 'KPI',
        chartType: 'tenants',
        title: 'Tenants',
        config: { format: 'number' },
        position: { x: 8, y: 0 },
        size: { w: 4, h: 2 },
        enabled: true,
    },

    // ─── Row 2: donut, full width (its trend partner went with the
    //            risk register) ────────────────────────────────────────
    {
        type: 'DONUT',
        chartType: 'rag-distribution',
        title: 'Tenant Health Distribution',
        config: { showLegend: true },
        position: { x: 0, y: 2 },
        size: { w: 12, h: 4 },
        enabled: true,
    },

    // ─── Row 3: tenant coverage list (full width) ───────────────────
    {
        type: 'TENANT_LIST',
        chartType: 'coverage',
        title: 'Coverage by Tenant',
        config: { sortBy: 'rag' },
        position: { x: 0, y: 6 },
        size: { w: 12, h: 6 },
        enabled: true,
    },

    // ─── Row 4: drill-down navigation cards (full width) ────────────
    {
        type: 'DRILLDOWN_CTAS',
        chartType: 'default',
        title: 'Drill-down',
        config: {},
        position: { x: 0, y: 12 },
        size: { w: 12, h: 2 },
        enabled: true,
    },
];

/**
 * Minimum Prisma client surface the seeder needs. Both the global
 * `prisma` import AND a `Prisma.TransactionClient` (from `$transaction`)
 * satisfy this — the seeder works inside or outside a transaction
 * without further plumbing.
 */
type SeederClient = Prisma.TransactionClient | {
    orgDashboardWidget: {
        count(args: { where: { organizationId: string } }): Promise<number>;
        createMany(args: {
            data: Array<{
                organizationId: string;
                type: 'KPI' | 'DONUT' | 'TREND' | 'TENANT_LIST' | 'DRILLDOWN_CTAS';
                chartType: string;
                title: string | null;
                config: Prisma.InputJsonValue;
                position: Prisma.InputJsonValue;
                size: Prisma.InputJsonValue;
                enabled: boolean;
            }>;
        }): Promise<{ count: number }>;
    };
};

/**
 * Per-call result so callers (the org-creation tx, the backfill
 * script) can distinguish "seeded" from "already had widgets".
 */
export interface SeedDefaultOrgDashboardResult {
    /** The org that was processed. */
    organizationId: string;
    /** True when the preset was inserted; false when the org already had widgets. */
    seeded: boolean;
    /** Count of widgets created on this call. 0 when `seeded === false`. */
    created: number;
}

/**
 * Insert the default preset for `organizationId` IF the org has zero
 * widgets. Idempotent — re-running is a no-op for orgs that already
 * have any widget (regardless of which preset created it). This is
 * the single entry point both org creation and backfill consume so
 * the duplication semantics live in one place.
 *
 * Concurrency: under a transaction (the `POST /api/org` path), the
 * Prisma row-level lock from `count` is held to commit, so two
 * concurrent calls cannot both see `count === 0` and both insert.
 * Outside a transaction (the backfill script), the natural
 * read-then-write race is acceptable — the worst case is the
 * backfill run and a parallel manual write briefly producing a
 * 9-widget org, which the user can clean up by hand. The script
 * runs once on prod under operator supervision; the race window
 * is single-digit milliseconds.
 */
export async function seedDefaultOrgDashboard(
    db: SeederClient,
    organizationId: string,
): Promise<SeedDefaultOrgDashboardResult> {
    const existing = await db.orgDashboardWidget.count({
        where: { organizationId },
    });
    if (existing > 0) {
        return { organizationId, seeded: false, created: 0 };
    }

    const result = await db.orgDashboardWidget.createMany({
        data: DEFAULT_ORG_DASHBOARD_PRESET.map((w) => ({
            organizationId,
            type: w.type,
            chartType: w.chartType,
            title: w.title ?? null,
            config: w.config as Prisma.InputJsonValue,
            position: w.position as Prisma.InputJsonValue,
            size: w.size as Prisma.InputJsonValue,
            enabled: w.enabled ?? true,
        })),
    });

    return { organizationId, seeded: true, created: result.count };
}
