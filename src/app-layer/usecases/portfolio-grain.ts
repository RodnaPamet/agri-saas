/**
 * Enterprise-grain — org portfolio grain aggregation.
 *
 * Aggregates the GRAIN-module figures (contracted volume, harvested
 * yield, activity cost, bin storage) across every child tenant of a
 * hub-and-spoke organization into a single portfolio summary the CISO /
 * group-operator dashboard renders.
 *
 * ## Cross-tenant RLS posture (load-bearing)
 *
 * This usecase NEVER issues a single cross-tenant query against the
 * business tables. It walks the org's child tenants and runs each
 * per-tenant aggregate INSIDE `withTenantDb(tenant.id, (db) => …)`,
 * exactly mirroring the `fanOutPerTenant` seam in `./portfolio.ts`.
 * `withTenantDb`:
 *   1. opens a Prisma transaction,
 *   2. `SET LOCAL ROLE app_user`                 ← drops privilege,
 *   3. binds `app.tenant_id` to the tenant       ← RLS context.
 *
 * Inside the callback every read runs under FORCE ROW LEVEL SECURITY;
 * the org-admin gets through because the Epic O-2 auto-provisioning
 * service created an AUDITOR `TenantMembership` for them in each child
 * tenant. A tenant the user has no membership in returns zero rows —
 * the boundary shrinks automatically, it is never bypassed.
 *
 * ## Aggregation strategy
 *
 * Per tenant we run a handful of BOUNDED, single-row queries:
 *   - Contracts: `groupBy(['type'])` summing `volumeTonnes` → SALE vs
 *     PURCHASE contracted tonnes, restricted to the LIVE commitment
 *     statuses (`CONTRACTED_COMMITMENT_STATUSES` — ACTIVE + DELIVERED).
 *     DRAFT / CANCELLED / SETTLED are excluded: see that constant for
 *     why "contracted" means the live book, not a lifetime total.
 *   - Yield:     `aggregate` summing `grossTonnes`.
 *   - Cost:      `aggregate` summing `LogEntry.costAmount` +
 *                `aggregate` summing `StockTransaction.costAmount`.
 *   - Bins:      `findMany` (BIN/STORAGE, bounded `take`) then ONE
 *                `inventoryLot.groupBy(['locationId'])` summing
 *                `quantityOnHand` for the HARVESTED_PRODUCE lots in
 *                those bins.
 *
 * Every SUM targets a PLAINTEXT numeric column (`volumeTonnes`,
 * `grossTonnes`, `costAmount`, `quantityOnHand`, `capacityTonnes`) —
 * none of these are in the Epic B encryption manifest, so DB-side
 * aggregation is correct. Every read filters `deletedAt: null`.
 *
 * Resilience: a child tenant with the GRAIN module OFF, no grain data,
 * or no membership simply contributes zeros — it never throws.
 */

import type { OrgContext } from '@/app-layer/types';
import { forbidden } from '@/lib/errors/types';
import { getPortfolioData } from '@/app-layer/usecases/portfolio-data';
import { withTenantDb, type PrismaTx } from '@/lib/db-context';
import { CONTRACTED_COMMITMENT_STATUSES } from '@/app-layer/domain/contract-status';
import type { OrgTenantMeta } from '@/app-layer/repositories/PortfolioRepository';

// Bound for the per-tenant bin list. Mirrors the `PER_TENANT_LIMIT`
// used by the cross-tenant drill-downs in `./portfolio.ts` — a single
// tenant is not expected to have more grain stores than this, and the
// stored-quantity rollup is one bounded `groupBy` over those ids.
const PER_TENANT_LIMIT = 20;

const BIN_KINDS = ['BIN', 'STORAGE'] as const;

/** Prisma `Decimal | number | null` → number (0 for nullish). Mirrors
 *  `cost-rollup.ts::dec`. Only ever applied to plaintext numeric
 *  columns, so the conversion is lossless within Decimal precision. */
function dec(v: unknown): number {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    // Prisma.Decimal (or any object with a numeric toString()).
    const n = Number((v as { toString(): string }).toString());
    return Number.isFinite(n) ? n : 0;
}

/** Round to 3 dp (tonnes) / 2 dp (currency) for stable display. */
function round3(n: number): number {
    return Math.round(n * 1e3) / 1e3;
}
function round2(n: number): number {
    return Math.round(n * 1e2) / 1e2;
}

export interface PortfolioGrainTenantRow {
    tenantId: string;
    tenantName: string;
    /** SUM of `volumeTonnes` over live (ACTIVE + DELIVERED) SALE
     *  contracts. Excludes DRAFT / CANCELLED / SETTLED. */
    contractedSaleTonnes: number;
    /** SUM of `volumeTonnes` over live (ACTIVE + DELIVERED) PURCHASE
     *  contracts. Excludes DRAFT / CANCELLED / SETTLED. */
    contractedPurchaseTonnes: number;
    /** SUM of `grossTonnes` over yield records (deletedAt: null). */
    totalYieldTonnes: number;
    /** SUM of LogEntry.costAmount + StockTransaction.costAmount. */
    totalActivityCost: number;
    /** First non-null cost/price currency seen for this tenant, or null. */
    currency: string | null;
    /** Count of BIN/STORAGE locations. */
    binCount: number;
    /** SUM of `capacityTonnes` across the tenant's bins. */
    binCapacityTonnes: number;
    /** SUM of HARVESTED_PRODUCE `quantityOnHand` stored in those bins. */
    binStoredTonnes: number;
}

export interface PortfolioGrainTotals {
    contractedSaleTonnes: number;
    contractedPurchaseTonnes: number;
    totalYieldTonnes: number;
    totalActivityCost: number;
    /** First non-null tenant currency seen, or null (multi-currency orgs
     *  display this as a hint; magnitudes still sum). */
    currency: string | null;
    binCount: number;
    binCapacityTonnes: number;
    binStoredTonnes: number;
    /** binStoredTonnes / binCapacityTonnes × 100, clamped [0,100]; null
     *  when no capacity is configured anywhere. */
    binUtilisationPct: number | null;
    /** Child tenants that contributed at least one grain figure. */
    tenantsWithGrain: number;
    /** Total child tenants scanned. */
    tenantsTotal: number;
}

export interface PortfolioGrainSummary {
    organizationId: string;
    organizationSlug: string;
    generatedAt: string;
    totals: PortfolioGrainTotals;
    perTenant: PortfolioGrainTenantRow[];
}

function assertCanViewPortfolio(ctx: OrgContext): void {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden('Portfolio view requires an active org membership');
    }
}

/**
 * Compute the grain figures for ONE tenant. Runs entirely inside `db`
 * (the caller's RLS-bound tenant transaction). Pure aggregate reads —
 * no per-row business data crosses the boundary.
 */
async function computeTenantGrainRow(
    db: PrismaTx,
    tenant: OrgTenantMeta,
): Promise<PortfolioGrainTenantRow> {
    let currency: string | null = null;
    const pickCurrency = (next: string | null | undefined) => {
        if (currency == null && next != null) currency = next;
    };

    // ── Contracts: SALE vs PURCHASE contracted tonnes ──
    //
    // Only LIVE commitments count (ACTIVE + DELIVERED). Without the
    // status filter this summed DRAFT (unsigned), CANCELLED (void) and
    // SETTLED (closed out) too, so the group operator's headline
    // commitment could only ever grow — see
    // CONTRACTED_COMMITMENT_STATUSES for the full rationale.
    const contractGroups = await db.contract.groupBy({
        by: ['type'],
        where: {
            tenantId: tenant.id,
            deletedAt: null,
            status: { in: [...CONTRACTED_COMMITMENT_STATUSES] },
        },
        _sum: { volumeTonnes: true },
    });
    let contractedSaleTonnes = 0;
    let contractedPurchaseTonnes = 0;
    for (const g of contractGroups) {
        const tonnes = dec(g._sum.volumeTonnes);
        if (g.type === 'SALE') contractedSaleTonnes += tonnes;
        else if (g.type === 'PURCHASE') contractedPurchaseTonnes += tonnes;
    }

    // ── Yield: total harvested tonnes ──
    const yieldAgg = await db.yieldRecord.aggregate({
        where: { tenantId: tenant.id, deletedAt: null },
        _sum: { grossTonnes: true },
    });
    const totalYieldTonnes = dec(yieldAgg._sum.grossTonnes);

    // ── Cost: LogEntry.costAmount + StockTransaction.costAmount ──
    // Tenant-level totals only (no per-planting join needed here).
    const logCostAgg = await db.logEntry.aggregate({
        where: { tenantId: tenant.id, deletedAt: null },
        _sum: { costAmount: true },
    });
    const stockCostAgg = await db.stockTransaction.aggregate({
        where: { tenantId: tenant.id },
        _sum: { costAmount: true },
    });
    const totalActivityCost =
        dec(logCostAgg._sum.costAmount) + dec(stockCostAgg._sum.costAmount);

    // ── Bins: capacity + stored produce ──
    const bins = await db.location.findMany({
        where: {
            tenantId: tenant.id,
            deletedAt: null,
            kind: { in: [...BIN_KINDS] },
        },
        select: { id: true, capacityTonnes: true },
        take: PER_TENANT_LIMIT,
    });
    const binCount = bins.length;
    let binCapacityTonnes = 0;
    for (const b of bins) binCapacityTonnes += dec(b.capacityTonnes);

    let binStoredTonnes = 0;
    if (bins.length > 0) {
        const binIds = bins.map((b) => b.id);
        // ONE bounded groupBy for the stored HARVESTED_PRODUCE quantity
        // across every bin (no N+1).
        const storedGroups = await db.inventoryLot.groupBy({
            by: ['locationId'],
            where: {
                tenantId: tenant.id,
                deletedAt: null,
                locationId: { in: binIds },
                item: { is: { category: 'HARVESTED_PRODUCE' } },
            },
            _sum: { quantityOnHand: true },
        });
        for (const g of storedGroups) binStoredTonnes += dec(g._sum.quantityOnHand);
    }

    // Currency hint — read once cheaply from the first contract that
    // carries a price currency. Bounded single-row read; falls back to
    // null when the tenant has no priced contract.
    const currencyRow = await db.contract.findFirst({
        where: { tenantId: tenant.id, deletedAt: null, priceCurrency: { not: null } },
        select: { priceCurrency: true },
        orderBy: { createdAt: 'asc' },
    });
    pickCurrency(currencyRow?.priceCurrency ?? null);

    return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        contractedSaleTonnes: round3(contractedSaleTonnes),
        contractedPurchaseTonnes: round3(contractedPurchaseTonnes),
        totalYieldTonnes: round3(totalYieldTonnes),
        totalActivityCost: round2(totalActivityCost),
        currency,
        binCount,
        binCapacityTonnes: round2(binCapacityTonnes),
        binStoredTonnes: round3(binStoredTonnes),
    };
}

/** True when a tenant row carries any non-zero grain figure. */
function rowHasGrain(r: PortfolioGrainTenantRow): boolean {
    return (
        r.contractedSaleTonnes > 0 ||
        r.contractedPurchaseTonnes > 0 ||
        r.totalYieldTonnes > 0 ||
        r.totalActivityCost > 0 ||
        r.binCount > 0
    );
}

/**
 * Org-wide grain portfolio summary: one aggregated row per child
 * tenant plus org-level totals.
 *
 * Sequential per-tenant fan-out (same rationale as `./portfolio.ts`:
 * `withTenantDb` opens a transaction per call, so a burst of parallel
 * transactions could exhaust the pool; the per-tenant work is a few
 * bounded aggregates, well inside dashboard-load budgets).
 */
export async function getPortfolioGrainSummary(
    ctx: OrgContext,
): Promise<PortfolioGrainSummary> {
    assertCanViewPortfolio(ctx);

    // Grain aggregation only needs the tenant list — opt out of the
    // snapshots fetch. The tenant read still memoises in-request.
    const { tenants } = await getPortfolioData(ctx.organizationId, {
        includeSnapshots: false,
    });

    const perTenant: PortfolioGrainTenantRow[] = [];
    for (const tenant of tenants) {
        // Each per-tenant aggregate runs in its own RLS-bound
        // transaction. A tenant with no membership / no grain / GRAIN
        // off returns zeros — never throws.
        const row = await withTenantDb(tenant.id, (db) =>
            computeTenantGrainRow(db, tenant),
        );
        perTenant.push(row);
    }

    // Stable ordering — name asc (the tenant list already arrives
    // name-ordered from the repository, but assert it here so the table
    // is deterministic regardless of upstream changes).
    perTenant.sort((a, b) => a.tenantName.localeCompare(b.tenantName));

    let contractedSaleTonnes = 0;
    let contractedPurchaseTonnes = 0;
    let totalYieldTonnes = 0;
    let totalActivityCost = 0;
    let binCount = 0;
    let binCapacityTonnes = 0;
    let binStoredTonnes = 0;
    let currency: string | null = null;
    let tenantsWithGrain = 0;

    for (const r of perTenant) {
        contractedSaleTonnes += r.contractedSaleTonnes;
        contractedPurchaseTonnes += r.contractedPurchaseTonnes;
        totalYieldTonnes += r.totalYieldTonnes;
        totalActivityCost += r.totalActivityCost;
        binCount += r.binCount;
        binCapacityTonnes += r.binCapacityTonnes;
        binStoredTonnes += r.binStoredTonnes;
        if (currency == null && r.currency != null) currency = r.currency;
        if (rowHasGrain(r)) tenantsWithGrain++;
    }

    const binUtilisationPct =
        binCapacityTonnes > 0
            ? Math.min(100, Math.max(0, (binStoredTonnes / binCapacityTonnes) * 100))
            : null;

    return {
        organizationId: ctx.organizationId,
        organizationSlug: ctx.orgSlug,
        generatedAt: new Date().toISOString(),
        totals: {
            contractedSaleTonnes: round3(contractedSaleTonnes),
            contractedPurchaseTonnes: round3(contractedPurchaseTonnes),
            totalYieldTonnes: round3(totalYieldTonnes),
            totalActivityCost: round2(totalActivityCost),
            currency,
            binCount,
            binCapacityTonnes: round2(binCapacityTonnes),
            binStoredTonnes: round3(binStoredTonnes),
            binUtilisationPct:
                binUtilisationPct == null ? null : Math.round(binUtilisationPct * 10) / 10,
            tenantsWithGrain,
            tenantsTotal: perTenant.length,
        },
        perTenant,
    };
}
