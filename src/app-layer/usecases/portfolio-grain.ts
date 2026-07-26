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
 *   - Seasons:   `groupBy(['seasonId'])` on BOTH contracts and yield
 *                records, plus one bounded season-name lookup, folded
 *                into the org-level contracted-vs-produced table. This
 *                is the rollup `Contract.seasonId` has always described
 *                in the schema and never had.
 *   - Yield:     `aggregate` summing `grossTonnes`.
 *   - Cost:      `aggregate` summing `LogEntry.costAmount` +
 *                `aggregate` summing `StockTransaction.costAmount`.
 *   - Bins:      `findMany` (BIN/STORAGE, bounded `take`) then ONE
 *                `inventoryLot.groupBy(['locationId','unitId'])` summing
 *                `quantityOnHand` for the HARVESTED_PRODUCE lots in
 *                those bins. Grouped by UNIT as well as bin because a
 *                lot's quantity is in its own unit — kg/g/t are distinct
 *                units, so a raw sum reported a kg-denominated tenant at
 *                1000x its real tonnage. Converted via
 *                `@/lib/grain/bin-fill`.
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
import {
    CONTRACTED_COMMITMENT_STATUSES,
    CONTRACTED_SEASON_STATUSES,
} from '@/app-layer/domain/contract-status';
import { summariseContractBook } from '@/lib/grain/contract-value';
import { summariseStoredByBin } from '@/lib/grain/bin-fill';
import type { OrgTenantMeta } from '@/app-layer/repositories/PortfolioRepository';

// Bound for the per-tenant bin list. Mirrors the `PER_TENANT_LIMIT`
// used by the cross-tenant drill-downs in `./portfolio.ts` — a single
// tenant is not expected to have more grain stores than this, and the
// stored-quantity rollup is one bounded `groupBy` over those ids.
const PER_TENANT_LIMIT = 20;

// Bound for the per-tenant season-name lookup. A farm with more than
// this many marketing seasons in play is not a real shape; the bound
// only truncates NAMES (an unresolved id falls into the unassigned
// bucket), never a tonnage.
const PER_TENANT_SEASON_LIMIT = 50;

// Bound for the per-tenant priced-contract read that feeds the value
// rollup. Contract value is a per-row product, so it cannot be SUM'd in
// Prisma; this reads the tenant's live contracts (already a small set —
// the live book, not history) and accumulates with Decimal precision.
const PER_TENANT_CONTRACT_LIMIT = 1000;

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
    /**
     * PRODUCTION: Σ `grossTonnes` over yield records (deletedAt: null),
     * across every season the tenant has recorded.
     *
     * NOT comparable with, and NOT additive to, `binStoredTonnes` — see the
     * note on that field. Grain that was harvested and then sold off the
     * field is counted here and nowhere else.
     */
    totalYieldTonnes: number;
    /**
     * The part of `totalYieldTonnes` that is ALSO counted in
     * `binStoredTonnes` — production recorded by a journal HARVEST entry,
     * which minted a stock lot at the same time (YieldRecord.logEntryId is
     * set).
     *
     * This is the overlap figure. Without it the dashboard showed
     * production beside stock as unrelated peers, so a tenant recording
     * harvests in the journal AND on /grain/yield displayed the same
     * physical grain twice with nothing able to say so.
     */
    yieldAlsoInStoreTonnes: number;
    /** SUM of LogEntry.costAmount + StockTransaction.costAmount. */
    totalActivityCost: number;
    /** Σ (volume × price) over live contracts, in `currency`. The
     *  revenue side the dashboard previously lacked — cost was shown
     *  with nothing to weigh it against. Never blended across
     *  currencies: this is the tenant's DOMINANT currency only. */
    contractedValue: number;
    /** Dominant cost/price currency for this tenant, or null. */
    currency: string | null;
    /** Count of BIN/STORAGE locations. */
    binCount: number;
    /** SUM of `capacityTonnes` across the tenant's bins. */
    binCapacityTonnes: number;
    /**
     * STOCK ON HAND, NOW: Σ HARVESTED_PRODUCE `quantityOnHand` in those bins.
     *
     * A different measurement from `totalYieldTonnes`, not a subset and not
     * a remainder: it moves down as grain ships out and up when purchased
     * grain arrives, and it says nothing about how much was grown. The two
     * must never be summed; `yieldAlsoInStoreTonnes` states how much grain
     * appears in both.
     */
    binStoredTonnes: number;
}

export interface PortfolioGrainTotals {
    contractedSaleTonnes: number;
    contractedPurchaseTonnes: number;
    /** PRODUCTION across the group — see the per-tenant field docs. */
    totalYieldTonnes: number;
    /** Σ of the per-tenant overlap: production that is also in store. */
    yieldAlsoInStoreTonnes: number;
    totalActivityCost: number;
    /** Σ contracted value across tenants THAT SHARE `currency`. Tenants
     *  priced in another currency are excluded from this sum and
     *  counted in `mixedCurrency` — a blended money total would be
     *  meaningless. */
    contractedValue: number;
    /** True when the org's tenants do not all price in `currency`, so
     *  `contractedValue` covers only part of the book. The UI must say
     *  so rather than present a partial figure as complete. */
    mixedCurrency: boolean;
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

/**
 * One marketing season's contracted-vs-produced position, aggregated
 * across every child tenant.
 *
 * Seasons are per-tenant rows, so the same marketing year exists as a
 * different `Season.id` in each farm. Aggregation is therefore by season
 * NAME — that is what "the 2026 harvest" means at group level. Contracts
 * and yield records with no season land in a single `null`-named bucket
 * rather than being dropped or blended into a named one.
 */
export interface PortfolioGrainSeasonRow {
    /** Season name, or `null` for unassigned rows. */
    seasonName: string | null;
    /** Σ volumeTonnes over SALE contracts in the season-commitment set
     *  (ACTIVE + DELIVERED + SETTLED — see CONTRACTED_SEASON_STATUSES). */
    contractedSaleTonnes: number;
    /** Σ grossTonnes over yield records for the same season. */
    producedTonnes: number;
    /** contracted / produced × 100 — the share of the harvest already
     *  sold forward. `null` when nothing was produced (a percentage of
     *  zero is not 0%, it is undefined). Uncapped: >100 is the real and
     *  important signal that a farm sold more than it grew. */
    coveragePct: number | null;
    /** produced − contracted. Positive = unsold surplus; negative =
     *  short of the commitment and buying-in territory. */
    deltaTonnes: number;
    /** Child tenants contributing a figure to this season. */
    tenantCount: number;
}

export interface PortfolioGrainSummary {
    organizationId: string;
    organizationSlug: string;
    generatedAt: string;
    totals: PortfolioGrainTotals;
    perTenant: PortfolioGrainTenantRow[];
    /** Per-season contracted-vs-produced, newest season name first. */
    perSeason: PortfolioGrainSeasonRow[];
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

    // …and how much of it ALSO entered store. `logEntryId IS NOT NULL` means
    // the record was minted by a journal HARVEST entry, so the same physical
    // grain is represented twice on this dashboard: once as production, once
    // as stock. Reporting the overlap is what stops the two figures reading
    // as one additive total — see the field docs on PortfolioGrainTotals.
    const yieldFromJournalAgg = await db.yieldRecord.aggregate({
        where: { tenantId: tenant.id, deletedAt: null, logEntryId: { not: null } },
        _sum: { grossTonnes: true },
    });
    const yieldAlsoInStoreTonnes = dec(yieldFromJournalAgg._sum.grossTonnes);

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
            // ARCHIVED bins are retired: their capacity is not operating
            // capacity, so counting them deflated binUtilisationPct and
            // inflated binCount/binCapacityTonnes for the whole org. The
            // per-tenant bins PAGE still shows them (surfaced, not hidden) —
            // this is the metrics view, where "how full is the farm" must
            // only measure storage actually in use.
            status: 'ACTIVE',
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
        // across every bin (no N+1). Grouped by unit as well as bin because
        // a lot's quantity is in ITS OWN unit — `Item.defaultUnitId` is
        // user-chosen and kg/g/t are distinct units, so summing raw
        // quantities reported a kg-denominated tenant at 1000× its real
        // tonnage, straight into the cross-tenant executive summary.
        const storedGroups = await db.inventoryLot.groupBy({
            by: ['locationId', 'unitId'],
            where: {
                tenantId: tenant.id,
                deletedAt: null,
                locationId: { in: binIds },
                item: { is: { category: 'HARVESTED_PRODUCE' } },
            },
            _sum: { quantityOnHand: true },
            _count: { _all: true },
        });
        const units = await db.unit.findMany({
            where: { id: { in: [...new Set(storedGroups.map((g) => g.unitId))] } },
            select: { id: true, key: true, symbol: true },
        });
        const byBin = summariseStoredByBin(
            storedGroups.map((g) => ({
                locationId: g.locationId,
                unitId: g.unitId,
                quantity: dec(g._sum.quantityOnHand),
                lotCount: g._count._all,
            })),
            units,
        );
        // This is a TONNES metric, so stock in a unit with no tonnage
        // (COUNT/VOLUME) contributes nothing — it is surfaced per-bin on the
        // bins page (`BinDto.unconvertible`), which is where the detail
        // belongs; folding it in at face value is the bug being fixed.
        for (const totals of byBin.values()) binStoredTonnes += totals.storedTonnes;
    }

    // ── Contract value (the revenue side) ──
    //
    // The dashboard summed activity COST with no matching revenue
    // figure, so a farm's grain page showed only money going out. Value
    // is a per-row product (volume × price), which Prisma cannot SUM
    // server-side, so it is accumulated over a bounded page of the
    // tenant's live contracts using Decimal arithmetic.
    //
    // Grouped by currency and NEVER blended: a multi-currency org gets
    // one bucket per currency, and the tenant row reports only its own
    // dominant one.
    const pricedContracts = await db.contract.findMany({
        where: {
            tenantId: tenant.id,
            deletedAt: null,
            status: { in: [...CONTRACTED_COMMITMENT_STATUSES] },
        },
        select: {
            status: true,
            volumeTonnes: true,
            pricePerTonne: true,
            priceCurrency: true,
        },
        take: PER_TENANT_CONTRACT_LIMIT,
    });
    const book = summariseContractBook(pricedContracts);
    // `summariseContractBook` sorts by descending value, so the first
    // bucket is this tenant's dominant currency.
    const dominant = book.find((b) => b.currency != null) ?? book[0];
    const contractedValue = dominant ? Number(dominant.contractValue) : 0;
    pickCurrency(dominant?.currency ?? null);

    // Currency hint fallback — a tenant whose live contracts carry no
    // currency may still have one on an older row.
    if (currency == null) {
        const currencyRow = await db.contract.findFirst({
            where: { tenantId: tenant.id, deletedAt: null, priceCurrency: { not: null } },
            select: { priceCurrency: true },
            orderBy: { createdAt: 'asc' },
        });
        pickCurrency(currencyRow?.priceCurrency ?? null);
    }

    return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        contractedSaleTonnes: round3(contractedSaleTonnes),
        contractedPurchaseTonnes: round3(contractedPurchaseTonnes),
        totalYieldTonnes: round3(totalYieldTonnes),
        yieldAlsoInStoreTonnes: round3(yieldAlsoInStoreTonnes),
        totalActivityCost: round2(totalActivityCost),
        contractedValue: round2(contractedValue),
        currency,
        binCount,
        binCapacityTonnes: round2(binCapacityTonnes),
        binStoredTonnes: round3(binStoredTonnes),
    };
}

/** Per-season accumulator, keyed by season name (null → unassigned). */
type SeasonAccumulator = Map<
    string | null,
    { contracted: number; produced: number; tenants: Set<string> }
>;

/**
 * Add ONE tenant's per-season contracted + produced figures into the
 * org-level accumulator.
 *
 * Two bounded groupBys plus one bounded season-name lookup — no query
 * per season, and no cross-tenant read (this runs inside the caller's
 * RLS-bound tenant transaction like every other read here).
 *
 * The contract side uses `CONTRACTED_SEASON_STATUSES` (ACTIVE +
 * DELIVERED + SETTLED), which is WIDER than the live-book set used for
 * the headline tiles. A completed season's contracts are mostly SETTLED;
 * scoring it against the live book would report ~0% coverage for exactly
 * the seasons an operator reviews.
 */
async function accumulateTenantSeasons(
    db: PrismaTx,
    tenant: OrgTenantMeta,
    acc: SeasonAccumulator,
): Promise<void> {
    const [contractGroups, yieldGroups] = await Promise.all([
        db.contract.groupBy({
            by: ['seasonId'],
            where: {
                tenantId: tenant.id,
                deletedAt: null,
                type: 'SALE',
                status: { in: [...CONTRACTED_SEASON_STATUSES] },
            },
            _sum: { volumeTonnes: true },
        }),
        db.yieldRecord.groupBy({
            by: ['seasonId'],
            where: { tenantId: tenant.id, deletedAt: null },
            _sum: { grossTonnes: true },
        }),
    ]);

    if (contractGroups.length === 0 && yieldGroups.length === 0) return;

    // Resolve season ids → names in ONE bounded read (no N+1).
    const seasonIds = [
        ...new Set(
            [...contractGroups, ...yieldGroups]
                .map((g) => g.seasonId)
                .filter((id): id is string => id != null),
        ),
    ];
    const nameById = new Map<string, string>();
    if (seasonIds.length > 0) {
        const seasons = await db.season.findMany({
            where: { tenantId: tenant.id, id: { in: seasonIds } },
            select: { id: true, name: true },
            take: PER_TENANT_SEASON_LIMIT,
        });
        for (const s of seasons) nameById.set(s.id, s.name);
    }

    const bump = (
        seasonId: string | null,
        field: 'contracted' | 'produced',
        tonnes: number,
    ) => {
        if (tonnes === 0) return;
        const name = seasonId != null ? (nameById.get(seasonId) ?? null) : null;
        let row = acc.get(name);
        if (!row) {
            row = { contracted: 0, produced: 0, tenants: new Set() };
            acc.set(name, row);
        }
        row[field] += tonnes;
        row.tenants.add(tenant.id);
    };

    for (const g of contractGroups) {
        bump(g.seasonId, 'contracted', dec(g._sum.volumeTonnes));
    }
    for (const g of yieldGroups) {
        bump(g.seasonId, 'produced', dec(g._sum.grossTonnes));
    }
}

/** Fold the accumulator into the sorted DTO rows. */
function buildSeasonRows(acc: SeasonAccumulator): PortfolioGrainSeasonRow[] {
    return [...acc.entries()]
        .map(([seasonName, v]) => ({
            seasonName,
            contractedSaleTonnes: round3(v.contracted),
            producedTonnes: round3(v.produced),
            // Deliberately NOT clamped at 100: over-commitment is the
            // single most actionable thing this table can surface.
            coveragePct:
                v.produced > 0
                    ? Math.round((v.contracted / v.produced) * 1000) / 10
                    : null,
            deltaTonnes: round3(v.produced - v.contracted),
            tenantCount: v.tenants.size,
        }))
        .sort((a, b) => {
            // Unassigned bucket last; otherwise newest-looking name
            // first (season names are year-prefixed by convention, so a
            // descending string sort reads as newest-first).
            if (a.seasonName == null) return 1;
            if (b.seasonName == null) return -1;
            return b.seasonName.localeCompare(a.seasonName);
        });
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
    const seasonAcc: SeasonAccumulator = new Map();
    for (const tenant of tenants) {
        // Each per-tenant aggregate runs in its own RLS-bound
        // transaction. A tenant with no membership / no grain / GRAIN
        // off returns zeros — never throws. The season accumulation
        // shares the SAME transaction so it costs no extra connection.
        const row = await withTenantDb(tenant.id, async (db) => {
            const computed = await computeTenantGrainRow(db, tenant);
            await accumulateTenantSeasons(db, tenant, seasonAcc);
            return computed;
        });
        perTenant.push(row);
    }

    // Stable ordering — name asc (the tenant list already arrives
    // name-ordered from the repository, but assert it here so the table
    // is deterministic regardless of upstream changes).
    perTenant.sort((a, b) => a.tenantName.localeCompare(b.tenantName));

    let contractedSaleTonnes = 0;
    let contractedPurchaseTonnes = 0;
    let totalYieldTonnes = 0;
    let yieldAlsoInStoreTonnes = 0;
    let totalActivityCost = 0;
    let binCount = 0;
    let binCapacityTonnes = 0;
    let binStoredTonnes = 0;
    let currency: string | null = null;
    let tenantsWithGrain = 0;

    // Money is accumulated ONLY across tenants sharing the org's
    // reference currency (the first non-null one seen). A tenant priced
    // differently is excluded and flips `mixedCurrency`, so the UI can
    // say the figure is partial instead of presenting a blended number
    // as if it meant something.
    let contractedValue = 0;
    let mixedCurrency = false;

    for (const r of perTenant) {
        contractedSaleTonnes += r.contractedSaleTonnes;
        contractedPurchaseTonnes += r.contractedPurchaseTonnes;
        totalYieldTonnes += r.totalYieldTonnes;
        yieldAlsoInStoreTonnes += r.yieldAlsoInStoreTonnes;
        totalActivityCost += r.totalActivityCost;
        binCount += r.binCount;
        binCapacityTonnes += r.binCapacityTonnes;
        binStoredTonnes += r.binStoredTonnes;
        if (currency == null && r.currency != null) currency = r.currency;
        if (rowHasGrain(r)) tenantsWithGrain++;
    }

    for (const r of perTenant) {
        if (r.contractedValue === 0) continue;
        if (r.currency == null || r.currency === currency) {
            contractedValue += r.contractedValue;
        } else {
            mixedCurrency = true;
        }
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
            yieldAlsoInStoreTonnes: round3(yieldAlsoInStoreTonnes),
            totalActivityCost: round2(totalActivityCost),
            contractedValue: round2(contractedValue),
            mixedCurrency,
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
        perSeason: buildSeasonRows(seasonAcc),
    };
}
