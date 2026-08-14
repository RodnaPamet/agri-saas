import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import { getCostRollupByPlanting } from './cost-rollup';
import { getMarketReferences } from './trends';
import type { NetWorthRefusalCode } from '@/lib/grain/uncertainty';
import { foldFarmTotals, type FarmNetWorthTotal } from '@/lib/grain/farm-total';
import { computePerArea, type PerAreaFigures } from '@/lib/grain/per-area';
import { computeBreakEven, type BreakEvenFigures } from '@/lib/grain/break-even';
import {
    buildExclusionLabels,
    type ExclusionEntry,
} from '@/lib/grain/exclusion-labels';
import {
    CANONICAL_COMMODITIES,
    isCanonicalCommodity,
    normalizeCommodity,
    type CanonicalCommodity,
} from '@/lib/market/commodity-vocabulary';
import { summarizePlannedYield, type PlannedYieldInputRow } from '@/lib/planning/planned-yield';
import { resolveRentBasis, type RentBasisLease } from '@/lib/grain/rent-basis';
import { UNKNOWN_RENT_CURRENCY } from '@/lib/grain/cost-metrics';
import { canConvert, convert } from '@/lib/units/unit-conversion';

/**
 * Grain net worth — COST_METRICS.GRAIN_NET_WORTH (src/lib/grain/cost-metrics.ts).
 *
 * The fourth cost definition this product reports, and the first to include
 * OVERHEADS: land rent (`ParcelLease`, via `resolveRentBasis`) and payroll
 * (`CostEntry` rows in the PAYROLL category) alongside the attributed
 * field/stock cost reused
 * verbatim from `getCostRollupByPlanting`. Its cost figure will NOT match
 * `COST_METRICS.ATTRIBUTED_CROP_COST` for the same season whenever rent or
 * payroll is present — see cost-metrics.ts's "fourth metric" section for why
 * that is intentional, not a bug.
 *
 * Per commodity, this reports:
 *
 *   1. STANDING CROP (expected) — `plannedYieldKgPerHa × Σ areaHa` over the
 *      plantings growing that commodity, valued at the current market price.
 *      Reuses `summarizePlannedYield`, called once PER commodity group so a
 *      planting with no estimate is excluded (not zeroed) from its own
 *      commodity's total — never silently dropped.
 *   2. GRAIN ON HAND (actual) — `InventoryLot.quantityOnHand` for
 *      HARVESTED_PRODUCE lots, converted to tonnes via the lot's OWN unit
 *      (`@/lib/units/unit-conversion`), never assumed to already be tonnes.
 *      A lot whose unit cannot be resolved to a WEIGHT unit is excluded and
 *      named, not coerced.
 *   3. COSTS — three sources, kept as separate figures rather than folded
 *      into one silently-blended number:
 *        - `attributedCropCost` is `getCostRollupByPlanting`'s OWN output,
 *          summed per commodity. This is a REUSE, not a re-implementation —
 *          see cost-rollup.ts's movement-type policy docblock for why only
 *          CONSUMPTION counts. Its currency/mixed flags are passed through
 *          AS-IS: this module does not claim a currency strictness that
 *          cost-rollup's own "first non-null currency, magnitudes still
 *          sum" composition does not have.
 *        - `rentCostMoneyAmount` / `rentCostProduceKg` — a lease's rent,
 *          resolved to an annual per-hectare figure by `resolveRentBasis`
 *          and attributed `ParcelLease.parcelId → Parcel → Planting`, split
 *          pro-rata by area across the parcel's plantings when more than
 *          one shares it. `ParcelLease` carries NO currency column (see
 *          rent-basis.ts), so money rent's currency is genuinely unknown —
 *          it is reported separately and never assumed to match the cost
 *          currency (see the currency section below).
 *        - `payrollCost` — `CostEntry` rows in the PAYROLL category.
 *          Directly-linked
 *          (`plantingId`/`seasonId`) rows attribute straight to that
 *          planting/season; unattributed rows allocate pro-rata by AREA
 *          SHARE across the plantings in scope, and `payrollAllocated` is
 *          set on the commodity row so a reader can tell an allocation from
 *          a measurement.
 *   4. PRICE — `getMarketReferences` (src/app-layer/usecases/trends.ts),
 *      the SAME commodity-vocabulary bridge `contract.ts` already uses.
 *      This module does not re-derive the commodity→price join.
 *   5. CURRENCY — no FX rate is ever invented. `attributedCropCost` passes
 *      through cost-rollup's own blend (its `currencyMixed` flag is
 *      surfaced, not hidden). `payrollCost` DOES track its own currencies
 *      precisely, because this module reads the raw PAYROLL-category
 *      `CostEntry` rows itself. Money rent's currency is unknown by construction (no column
 *      on `ParcelLease`) and is folded into `cashCostCurrencies` under the
 *      literal sentinel `'UNKNOWN'` rather than assumed to match anything —
 *      that keeps it visible in `cashCostCurrencyMixed` without inventing a
 *      label. `netWorth` is computed ONLY when the cash-cost currencies are
 *      a single, known currency that equals the market price's currency;
 *      otherwise it is `null` with `netWorthUnavailableReason` stating why.
 *   6. PAYROLL ALLOCATION — see (3) above.
 *   7. EXCLUSIONS — every named exclusion in `GrainNetWorthExclusions` is a
 *      COUNT, never a silent zero: plantings with no yield estimate,
 *      plantings whose crop has no canonical commodity, lots whose unit
 *      didn't resolve to a mass, commodities with no price, leases whose
 *      rent unit didn't resolve, leases with nothing to attribute their
 *      rent to, produce-denominated rent that could not be valued (no price
 *      for its commodity — produce rent IS valued via the price series when
 *      one exists, per the brief: "you hold prices, so you are the right
 *      layer to value it"), and payroll rows with nothing to allocate
 *      against.
 *   8. QUERY SHAPE — every read here is a single BOUNDED `findMany`/batched
 *      `id: { in: [...] }` lookup; nothing reads inside a loop (see the
 *      inline comments at each call site).
 *
 * `getCostRollupByPlanting` and `getMarketReferences` are called as SIBLING
 * usecases (their own I/O), not nested inside this module's own
 * `runInTenantContext` — nesting two `$transaction` calls would hold two
 * pool connections for one logical read. This mirrors how `contract.ts`
 * composes `getMarketReferences` and how `portfolio-grain.ts` composes
 * `getPortfolioData`: usecases compose other usecases' RESULTS, not their
 * transactions.
 */

// ─── Bounds (read one past the cap, slice, report `truncated`) ──────────
const PLANTING_TAKE = 2000;
const LOT_TAKE = 2000;
const LEASE_TAKE = 2000;
const PAYROLL_TAKE = 2000;
const UNIT_TAKE = 200;

/** `InventoryLot.unitId` target — `Location.capacityTonnes` / grain figures are tonnes. */
const TONNES_UNIT_KEY = 't';
const KG_PER_TONNE = 1000;

// Sentinel for money rent's currency (`UNKNOWN_RENT_CURRENCY`) is imported at
// the top of this file from `@/lib/grain/cost-metrics`, where its docblock
// lives. It moved out of here when the calculator page needed to recognise
// it: the value travels to a client component inside `cashCostCurrencies`,
// and a page that cannot name the sentinel cannot avoid printing
// `Costs in UNKNOWN` at a farmer.

/** Prisma `Decimal | number | null | undefined` → plain number (0 for nullish). */
function dec(v: unknown): number {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    const n = Number((v as { toString(): string }).toString());
    return Number.isFinite(n) ? n : 0;
}

/** Same nullish-preserving coercion as `dec`, but keeps `null` as `null`. */
function decOrNull(v: unknown): number | null {
    if (v == null) return null;
    return dec(v);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

/** Sort commodities in the product's canonical catalogue order. */
function byCanonicalOrder(a: CanonicalCommodity, b: CanonicalCommodity): number {
    return CANONICAL_COMMODITIES.indexOf(a) - CANONICAL_COMMODITIES.indexOf(b);
}

// ─── Exclusions ───────────────────────────────────────────────────────

/**
 * The RAW shape the compute functions collect — ids, plus the one or two
 * extra facts each class carries. Internal: the published contract is
 * {@link GrainNetWorthExclusions}, whose entries carry a human LABEL.
 *
 * Kept separate rather than labelling in place because the compute
 * functions run before the label sources are assembled, and threading
 * lookup maps through five of them to save one pass would be a worse
 * trade than the pass.
 */
interface RawExclusions {
    /** Plantings with a known commodity but no `plannedYieldKgPerHa` or no
     *  `areaM2` — excluded, not zeroed, from standing crop. */
    plantingsMissingYieldEstimate: string[];
    /** Plantings (touched by standing crop, cost, rent, or payroll
     *  attribution) whose crop names no canonical commodity. */
    plantingsUnknownCommodity: string[];
    /** HARVESTED_PRODUCE lots whose unit did not resolve to a WEIGHT unit
     *  convertible to tonnes. */
    lotsUnresolvedUnit: Array<{ lotId: string; unitKey: string | null }>;
    /** HARVESTED_PRODUCE lots whose item name names no canonical commodity. */
    lotsUnknownCommodity: string[];
    /** Commodities this calculation touched with NO current market price —
     *  nothing here could be valued in money. */
    commoditiesWithNoPrice: string[];
    /** Leases whose rent could not be resolved to a per-hectare figure —
     *  `resolveRentBasis`'s own refusal reason. */
    leasesUnresolvedRent: Array<{ leaseId: string; reason: string }>;
    /** Leases whose parcel has no in-scope planting with a known commodity
     *  to attribute the resolved rent to. */
    leasesUnattributed: string[];
    /** Leases paying produce rent (кг/дка) whose commodity has no market
     *  price — the mass could not be valued, so it is excluded from cost
     *  rather than blended with money. */
    leasesProduceRentUnpriced: string[];
    /** Payroll rows with no in-scope planting (direct link or pro-rata
     *  target) to attribute to any commodity. */
    payrollUnattributable: string[];
}

function emptyExclusions(): RawExclusions {
    return {
        plantingsMissingYieldEstimate: [],
        plantingsUnknownCommodity: [],
        lotsUnresolvedUnit: [],
        lotsUnknownCommodity: [],
        commoditiesWithNoPrice: [],
        leasesUnresolvedRent: [],
        leasesUnattributed: [],
        leasesProduceRentUnpriced: [],
        payrollUnattributable: [],
    };
}

// ─── Result shape ─────────────────────────────────────────────────────

export interface CommodityNetWorthRow {
    commodity: CanonicalCommodity;

    /** Latest market reference, per tonne — from `getMarketReferences`. */
    pricePerTonne: number | null;
    priceCurrency: string | null;
    priceObservedAt: string | null;
    priceSource: string | null;

    // ── 1. Standing crop (expected) ──
    standingCropAreaHa: number;
    standingCropExpectedKg: number;
    standingCropPlantingIds: string[];
    /** `standingCropExpectedKg / 1000 × pricePerTonne`; null with no price. */
    standingCropValue: number | null;
    /** Per-decare figures over the terms that share this area — see
     *  `@/lib/grain/per-area`. Deliberately NOT net worth per dca. */
    perArea: PerAreaFigures;
    /** The price this crop must fetch to clear its cost, against the price
     *  it currently fetches — see `@/lib/grain/break-even`. */
    breakEven: BreakEvenFigures;

    // ── 2. Grain on hand (actual) ──
    grainOnHandTonnes: number;
    grainOnHandLotIds: string[];
    /** `grainOnHandTonnes × pricePerTonne`; null with no price. */
    grainOnHandValue: number | null;

    // ── 3. Costs ──
    /** Reused verbatim from `getCostRollupByPlanting`, summed per commodity. */
    attributedCropCost: number;
    attributedCropCostCurrencies: string[];
    /** True when the underlying rollup rows themselves mixed currencies —
     *  passed through, not re-derived. */
    attributedCropCostCurrencyMixed: boolean;

    /** Money-denominated (лв/дка) rent attributed to this commodity's
     *  plantings. Currency is UNKNOWN — see `UNKNOWN_RENT_CURRENCY`. */
    rentCostMoneyAmount: number;
    /** Produce-denominated (кг/дка) rent attributed to this commodity's
     *  plantings, in kilograms — a MASS, never added to money directly. */
    rentCostProduceKg: number;
    /** `rentCostProduceKg / 1000 × pricePerTonne`; null when kg > 0 but no
     *  price exists (see `leasesProduceRentUnpriced`); 0 when there is no
     *  produce rent to value. */
    rentCostProduceValue: number | null;

    payrollCost: number;
    payrollCostCurrencies: string[];
    payrollCostCurrencyMixed: boolean;
    /** True when ANY part of `payrollCost` came from pro-rata allocation
     *  rather than a direct plantingId/seasonId link. */
    payrollAllocated: boolean;

    /** `attributedCropCost + rentCostMoneyAmount + payrollCost` — a
     *  magnitude sum, same "sum regardless of mix, flag the mix" contract
     *  cost-rollup itself uses. NEVER assume this shares a currency with
     *  `pricePerTonne` — check `cashCostCurrencies`. */
    cashCostTotal: number;
    /** Every currency contributing to `cashCostTotal`. May contain the
     *  literal `'UNKNOWN'` sentinel for money rent (see module docblock). */
    cashCostCurrencies: string[];
    cashCostCurrencyMixed: boolean;

    /** `standingCropValue + grainOnHandValue - rentCostProduceValue`, all
     *  in `priceCurrency`. Null when `pricePerTonne` is null. */
    /**
     * CONSUMPTION movements attributed to this commodity that could not be
     * valued, split by cause: the lot carried no `unitCostAmount`, or the
     * lot's unit disagreed with the product's default unit.
     *
     * These do NOT change any figure below — the stock moved and the
     * planting is counted, only the money is missing. They are the reason
     * `attributedCropCost` (and therefore `cashCostTotal`) is a FLOOR
     * rather than a total, and why `netWorth` reads high when they are
     * non-zero. A surface showing the cost must show these beside it.
     */
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;

    netAssetPosition: number | null;
    /** `netAssetPosition - cashCostTotal`, computed ONLY when the cash
     *  costs are a single known currency equal to `priceCurrency` — no FX
     *  is ever invented. Null otherwise; see `netWorthUnavailableReason`. */
    netWorth: number | null;
    /**
     * The English sentence, authored here. It is the FALLBACK, not dead
     * weight: a client that does not recognise `netWorthUnavailableCode`
     * — an older bundle against a newer server — must still be able to
     * explain itself, because "a refusal is always explained" is the
     * property the calculator is built around. An untranslated
     * explanation beats a bare em-dash.
     */
    netWorthUnavailableReason: string | null;
    /** Machine-readable reason, for the client to translate. */
    netWorthUnavailableCode: NetWorthRefusalCode | null;
    /** Interpolation values for the translated reason, if it takes any. */
    netWorthUnavailableParams: Record<string, string> | null;
}

/**
 * One currency's worth of cash out. `categories` names which kinds of
 * spend contributed, so a reader can tell a fuel-heavy month from a rent
 * one without opening the register.
 */
export interface GrainCashOutLine {
    currency: string;
    amount: number;
    categories: string[];
}

/**
 * The FARM-level answer, which is what the calculator page claims to give.
 *
 * One total per currency, because this product blends none: cost-rollup
 * refuses to, prices carry their own, and there is no FX table. A refused
 * commodity is excluded from the arithmetic and named — its assets without
 * its cost would overstate the farm, and dropping it silently would report
 * a smaller number with nothing saying it is not the whole farm.
 */
export interface GrainFarmNetWorth {
    /** Biggest net first, so the farm's main currency leads. */
    totals: FarmNetWorthTotal[];
    /**
     * Refused commodities with no price currency either — the "no market
     * price" case, which belongs to no currency bucket. Reported here so
     * the omission is still visible.
     */
    refusedWithoutCurrency: string[];
}

/**
 * Excluded records, each with a label a person can recognise.
 *
 * Every class is the SAME shape now. It used to be three — a bare string,
 * `{lotId, unitKey}`, `{leaseId, reason}` — which forced the renderer to
 * branch on structure to work out what it was holding, and produced a
 * monospace list of cuids either way.
 */
export interface GrainNetWorthExclusions {
    plantingsMissingYieldEstimate: ExclusionEntry[];
    plantingsUnknownCommodity: ExclusionEntry[];
    lotsUnresolvedUnit: ExclusionEntry[];
    lotsUnknownCommodity: ExclusionEntry[];
    /** The `id` is the commodity SLUG — the client translates it. */
    commoditiesWithNoPrice: ExclusionEntry[];
    leasesUnresolvedRent: ExclusionEntry[];
    leasesUnattributed: ExclusionEntry[];
    leasesProduceRentUnpriced: ExclusionEntry[];
    payrollUnattributable: ExclusionEntry[];
}

export interface GrainNetWorthResult {
    generatedAt: string;
    seasonId: string | null;
    rows: CommodityNetWorthRow[];
    /** The farm answer. See {@link GrainFarmNetWorth}. */
    farm: GrainFarmNetWorth;
    exclusions: GrainNetWorthExclusions;
    /**
     * Farm-wide DISTINCT counts of unvalued consumptions, passed through
     * from the cost rollup.
     *
     * NOT the sum of the per-row counts, and the two may legitimately
     * disagree: one transaction attributed to two plantings of different
     * commodities is 1 here and 1 on each row. Summing rows would
     * multiply it by the commodities it touched.
     */
    unvalued: { noUnitCost: number; unitMismatch: number };
    /**
     * What LEFT THE BANK, per currency — `COST_METRICS.GRAIN_CASH_OUT`.
     *
     * Deliberately NOT added into `cashCostTotal` on any row: crop cost is
     * consumption-based and rent cost is a lease-terms accrual, so a
     * purchase or a rent payment folded in would bill the same money
     * twice. A consumer must render it as its own figure.
     */
    cashOut: GrainCashOutLine[];
    /** True when any batched read hit its cap — the figures below cover
     *  only part of the farm. */
    truncated: boolean;
}

// ─── Internal working shapes ──────────────────────────────────────────

interface PlantingInfo {
    id: string;
    commodity: CanonicalCommodity | null;
    areaM2: number | null;
    areaHa: number;
    parcelId: string | null;
    seasonId: string | null;
    plannedYieldKgPerHa: number | null;
}

interface CommodityAcc {
    standingCropExpectedKg: number;
    standingCropAreaHa: number;
    standingCropPlantingIds: string[];
    /**
     * Plantings of THIS commodity dropped for a missing yield estimate.
     *
     * Needed because `cashCostTotal` still carries their cost while
     * `standingCropAreaHa` and `standingCropValue` do not — so a per-dca
     * margin over them covers more land on the cost side than the revenue
     * side. The count is what lets that figure say it is incomplete.
     */
    standingCropExcludedCount: number;
    grainOnHandTonnes: number;
    grainOnHandLotIds: string[];
    attributedCropCost: number;
    attributedCropCostCurrencies: Set<string>;
    attributedCropCostCurrencyMixed: boolean;
    rentCostMoneyAmount: number;
    rentCostProduceKg: number;
    produceRentLeaseIds: Set<string>;
    payrollCost: number;
    payrollCostCurrencies: Set<string>;
    payrollAllocated: boolean;
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;
}

function newAcc(): CommodityAcc {
    return {
        standingCropExpectedKg: 0,
        standingCropAreaHa: 0,
        standingCropPlantingIds: [],
        standingCropExcludedCount: 0,
        grainOnHandTonnes: 0,
        grainOnHandLotIds: [],
        attributedCropCost: 0,
        attributedCropCostCurrencies: new Set(),
        attributedCropCostCurrencyMixed: false,
        rentCostMoneyAmount: 0,
        rentCostProduceKg: 0,
        produceRentLeaseIds: new Set(),
        payrollCost: 0,
        payrollCostCurrencies: new Set(),
        payrollAllocated: false,
        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,
    };
}

function ensureAcc(map: Map<CanonicalCommodity, CommodityAcc>, commodity: CanonicalCommodity): CommodityAcc {
    let acc = map.get(commodity);
    if (!acc) {
        acc = newAcc();
        map.set(commodity, acc);
    }
    return acc;
}

/**
 * Area-share weights for a set of targets — pro-rata by `areaHa`, falling
 * back to an EVEN split when the total area is zero/unknown (mirrors
 * cost-rollup's own even-split fallback for exactly the same reason: a
 * predictable default beats one that silently favours whichever row
 * happens to carry an area).
 */
function computeAreaWeights(targets: readonly { id: string; areaHa: number }[]): Map<string, number> {
    const weights = new Map<string, number>();
    if (targets.length === 0) return weights;
    const totalArea = targets.reduce((sum, t) => sum + (t.areaHa > 0 ? t.areaHa : 0), 0);
    if (totalArea > 0) {
        for (const t of targets) weights.set(t.id, (t.areaHa > 0 ? t.areaHa : 0) / totalArea);
    } else {
        const even = 1 / targets.length;
        for (const t of targets) weights.set(t.id, even);
    }
    return weights;
}

/** Batched-read row shapes (subset of the Prisma select). */
interface PlantingRow {
    id: string;
    areaM2: unknown;
    plannedYieldKgPerHa: unknown;
    parcelId: string | null;
    cropPlan: { seasonId: string | null; cropType: { commodityCanonical: string | null } | null } | null;
}
interface LotRow {
    id: string;
    quantityOnHand: unknown;
    unitId: string;
    item: { name: string } | null;
}
interface UnitRow {
    id: string;
    key: string;
}
interface LeaseRow {
    id: string;
    parcelId: string;
    rentAmount: unknown;
    rentUnit: string | null;
    rentUnitRaw: string | null;
    parcel: { areaHa: unknown } | null;
}
interface CostEntryRow {
    category: string;
    id: string;
    amount: unknown;
    currency: string;
    plantingId: string | null;
    seasonId: string | null;
}

/** Resolve a `CropType.commodityCanonical` string to a validated slug, or null. */
function resolveCanonical(raw: string | null | undefined): CanonicalCommodity | null {
    return raw != null && isCanonicalCommodity(raw) ? raw : null;
}

function buildPlantingInfo(rows: readonly PlantingRow[]): Map<string, PlantingInfo> {
    const map = new Map<string, PlantingInfo>();
    for (const p of rows) {
        const areaM2 = decOrNull(p.areaM2);
        map.set(p.id, {
            id: p.id,
            commodity: resolveCanonical(p.cropPlan?.cropType?.commodityCanonical),
            areaM2,
            areaHa: areaM2 != null ? areaM2 / 10_000 : 0,
            parcelId: p.parcelId,
            seasonId: p.cropPlan?.seasonId ?? null,
            plannedYieldKgPerHa: decOrNull(p.plannedYieldKgPerHa),
        });
    }
    return map;
}

/**
 * 1. STANDING CROP — grouped by commodity, `summarizePlannedYield` called
 * once PER GROUP so an excluded planting is attributed to the right
 * commodity's exclusion list rather than a single tenant-wide bucket.
 */
function computeStandingCrop(
    plantings: readonly PlantingInfo[],
    acc: Map<CanonicalCommodity, CommodityAcc>,
    exclusions: RawExclusions,
): void {
    const byCommodity = new Map<CanonicalCommodity, PlantingInfo[]>();
    for (const p of plantings) {
        if (p.commodity == null) {
            exclusions.plantingsUnknownCommodity.push(p.id);
            continue;
        }
        let group = byCommodity.get(p.commodity);
        if (!group) {
            group = [];
            byCommodity.set(p.commodity, group);
        }
        group.push(p);
    }

    for (const [commodity, group] of byCommodity) {
        const inputRows: PlannedYieldInputRow[] = group.map((p) => ({
            id: p.id,
            areaM2: p.areaM2,
            plannedYieldKgPerHa: p.plannedYieldKgPerHa,
        }));
        const summary = summarizePlannedYield(inputRows);
        exclusions.plantingsMissingYieldEstimate.push(...summary.excludedPlantingIds);

        const included = new Set(summary.includedPlantingIds);
        const areaHa = group
            .filter((p) => included.has(p.id))
            .reduce((sum, p) => sum + p.areaHa, 0);

        const a = ensureAcc(acc, commodity);
        a.standingCropExpectedKg = summary.totalPlannedYieldKg;
        a.standingCropAreaHa = round3(areaHa);
        a.standingCropPlantingIds = summary.includedPlantingIds;
        a.standingCropExcludedCount = summary.excludedPlantingIds.length;
    }
}

/**
 * 2. GRAIN ON HAND — HARVESTED_PRODUCE lots converted to tonnes via their
 * OWN unit. A lot in a non-WEIGHT (or unresolvable) unit is excluded and
 * named rather than assumed to already be tonnes (the exact bug class the
 * brief calls out for `quantityOnHand`).
 */
function computeGrainOnHand(
    lots: readonly LotRow[],
    unitById: Map<string, UnitRow>,
    acc: Map<CanonicalCommodity, CommodityAcc>,
    exclusions: RawExclusions,
): void {
    for (const lot of lots) {
        const unit = unitById.get(lot.unitId);
        if (!unit || !canConvert(unit.key, TONNES_UNIT_KEY)) {
            exclusions.lotsUnresolvedUnit.push({ lotId: lot.id, unitKey: unit?.key ?? null });
            continue;
        }
        const commodity = normalizeCommodity(lot.item?.name);
        if (commodity == null) {
            exclusions.lotsUnknownCommodity.push(lot.id);
            continue;
        }
        const tonnes = convert(dec(lot.quantityOnHand), unit.key, TONNES_UNIT_KEY);
        const a = ensureAcc(acc, commodity);
        a.grainOnHandTonnes += tonnes;
        a.grainOnHandLotIds.push(lot.id);
    }
}

/**
 * 3a. ATTRIBUTED CROP COST — `getCostRollupByPlanting`'s own rows, summed
 * per commodity. Reused verbatim; never re-derives `costAmount`.
 */
function computeAttributedCost(
    rollupRows: readonly {
        plantingId: string;
        totalCost: number;
        currencies: string[];
        currencyMixed: boolean;
        unvaluedNoUnitCost: number;
        unvaluedUnitMismatch: number;
    }[],
    plantingInfo: Map<string, PlantingInfo>,
    acc: Map<CanonicalCommodity, CommodityAcc>,
    exclusions: RawExclusions,
): void {
    for (const row of rollupRows) {
        const info = plantingInfo.get(row.plantingId);
        const commodity = info?.commodity ?? null;
        if (commodity == null) {
            exclusions.plantingsUnknownCommodity.push(row.plantingId);
            continue;
        }
        const a = ensureAcc(acc, commodity);
        a.attributedCropCost = round2(a.attributedCropCost + row.totalCost);
        for (const c of row.currencies) a.attributedCropCostCurrencies.add(c);
        a.attributedCropCostCurrencyMixed = a.attributedCropCostCurrencyMixed || row.currencyMixed;
        // Carried, not recomputed: the rollup already classified WHY each
        // consumption went unpriced. Summing per commodity is the same
        // reduction `attributedCropCost` gets one line above, so the count
        // always travels with the cost it qualifies.
        a.unvaluedNoUnitCost += row.unvaluedNoUnitCost;
        a.unvaluedUnitMismatch += row.unvaluedUnitMismatch;
    }
}

/**
 * 3b. RENT — `resolveRentBasis` per lease, attributed
 * `ParcelLease.parcelId → Parcel → Planting`. A parcel with more than one
 * in-scope (known-commodity) planting splits pro-rata by area share.
 */
function computeRent(
    leases: readonly LeaseRow[],
    plantingsByParcel: Map<string, PlantingInfo[]>,
    acc: Map<CanonicalCommodity, CommodityAcc>,
    exclusions: RawExclusions,
): void {
    for (const lease of leases) {
        const areaHa = decOrNull(lease.parcel?.areaHa);
        const rentAmount = decOrNull(lease.rentAmount);
        const leaseInput: RentBasisLease = { rentAmount, rentUnit: lease.rentUnit, rentUnitRaw: lease.rentUnitRaw };
        const basis = resolveRentBasis(leaseInput, areaHa);
        if (!basis.resolved) {
            exclusions.leasesUnresolvedRent.push({ leaseId: lease.id, reason: basis.reason });
            continue;
        }

        const candidates = plantingsByParcel.get(lease.parcelId) ?? [];
        const known = candidates.filter((p) => p.commodity != null) as (PlantingInfo & {
            commodity: CanonicalCommodity;
        })[];
        if (known.length === 0) {
            exclusions.leasesUnattributed.push(lease.id);
            continue;
        }

        const weights = computeAreaWeights(known.map((p) => ({ id: p.id, areaHa: p.areaHa })));
        // areaHa is guaranteed non-null/positive here — `resolveRentBasis`
        // only resolves when the parcel area is a finite, positive number.
        const parcelAreaHa = areaHa as number;

        if (basis.kind === 'money') {
            const totalForParcel = basis.perHa * parcelAreaHa;
            for (const p of known) {
                const share = totalForParcel * (weights.get(p.id) ?? 0);
                ensureAcc(acc, p.commodity).rentCostMoneyAmount += share;
            }
        } else {
            const totalKgForParcel = basis.kgPerHa * parcelAreaHa;
            for (const p of known) {
                const share = totalKgForParcel * (weights.get(p.id) ?? 0);
                const a = ensureAcc(acc, p.commodity);
                a.rentCostProduceKg += share;
                a.produceRentLeaseIds.add(lease.id);
            }
        }
    }
}

/**
 * 3c/6. PAYROLL — direct `plantingId`/`seasonId` links attribute straight
 * through; unattributed rows allocate pro-rata by area share across the
 * plantings in scope (season-scoped when the row carries one, tenant-wide
 * otherwise). `payrollAllocated` marks any commodity that received an
 * allocated (not directly linked) share.
 */
function computePayroll(
    rows: readonly CostEntryRow[],
    plantingInfo: Map<string, PlantingInfo>,
    plantingsBySeason: Map<string | null, PlantingInfo[]>,
    allKnownPlantings: PlantingInfo[],
    acc: Map<CanonicalCommodity, CommodityAcc>,
    exclusions: RawExclusions,
): void {
    for (const row of rows) {
        const amount = dec(row.amount);

        if (row.plantingId) {
            const info = plantingInfo.get(row.plantingId);
            if (!info || info.commodity == null) {
                exclusions.plantingsUnknownCommodity.push(row.plantingId);
                exclusions.payrollUnattributable.push(row.id);
                continue;
            }
            const a = ensureAcc(acc, info.commodity);
            a.payrollCost += amount;
            a.payrollCostCurrencies.add(row.currency);
            continue;
        }

        const targets = (row.seasonId != null ? plantingsBySeason.get(row.seasonId) : allKnownPlantings) ?? [];
        if (targets.length === 0) {
            exclusions.payrollUnattributable.push(row.id);
            continue;
        }

        const weights = computeAreaWeights(targets.map((p) => ({ id: p.id, areaHa: p.areaHa })));
        for (const p of targets) {
            if (p.commodity == null) continue; // filtered into `targets` only when known — defensive.
            const share = amount * (weights.get(p.id) ?? 0);
            const a = ensureAcc(acc, p.commodity);
            a.payrollCost += share;
            a.payrollCostCurrencies.add(row.currency);
            a.payrollAllocated = true;
        }
    }
}

/**
 * 3d. CASH-OUT — every cost entry, grouped by the currency it was
 * recorded in.
 *
 * Reported BESIDE the cost side, never inside it. `COST_METRICS.
 * GRAIN_CASH_OUT` carries the full reasoning; the short version is that
 * crop cost is CONSUMPTION-based and rent cost is a lease-terms ACCRUAL,
 * so a FERTILIZER purchase or a RENT payment folded into either would
 * bill the same money twice.
 *
 * Grouped rather than summed because this repo has no FX table. A farm
 * holding entries in BGN and EUR gets two figures, not one blended number
 * that reconciles against nothing. The array is sorted by currency so the
 * output is deterministic.
 */
function computeCashOut(rows: readonly CostEntryRow[]): GrainCashOutLine[] {
    const byCurrency = new Map<string, { amount: number; categories: Set<string> }>();
    for (const row of rows) {
        let bucket = byCurrency.get(row.currency);
        if (!bucket) {
            bucket = { amount: 0, categories: new Set<string>() };
            byCurrency.set(row.currency, bucket);
        }
        bucket.amount += dec(row.amount);
        bucket.categories.add(row.category);
    }
    return [...byCurrency.entries()]
        .map(([currency, b]) => ({
            currency,
            amount: round2(b.amount),
            categories: [...b.categories].sort(),
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Finalize one commodity's accumulator into its DTO row — values the
 * priced quantities, resolves `netAssetPosition` / `netWorth`, and names
 * unpriced produce rent.
 */
function finalizeRow(
    commodity: CanonicalCommodity,
    a: CommodityAcc,
    reference: { pricePerTonne: number; currency: string; observedAt: string; source: string } | null,
    exclusions: RawExclusions,
): CommodityNetWorthRow {
    const pricePerTonne = reference?.pricePerTonne ?? null;
    const priceCurrency = reference?.currency ?? null;

    if (pricePerTonne == null) {
        exclusions.commoditiesWithNoPrice.push(commodity);
    }

    const standingCropValue =
        pricePerTonne != null ? round2((a.standingCropExpectedKg / KG_PER_TONNE) * pricePerTonne) : null;
    const grainOnHandValue = pricePerTonne != null ? round2(a.grainOnHandTonnes * pricePerTonne) : null;

    let rentCostProduceValue: number | null = 0;
    if (a.rentCostProduceKg > 0) {
        if (pricePerTonne != null) {
            rentCostProduceValue = round2((a.rentCostProduceKg / KG_PER_TONNE) * pricePerTonne);
        } else {
            rentCostProduceValue = null;
            exclusions.leasesProduceRentUnpriced.push(...a.produceRentLeaseIds);
        }
    }

    const cashCostTotal = round2(a.attributedCropCost + a.rentCostMoneyAmount + a.payrollCost);
    const cashCostCurrencies = new Set<string>([
        ...a.attributedCropCostCurrencies,
        ...a.payrollCostCurrencies,
        ...(a.rentCostMoneyAmount > 0 ? [UNKNOWN_RENT_CURRENCY] : []),
    ]);
    const cashCostCurrencyMixed =
        a.attributedCropCostCurrencyMixed || cashCostCurrencies.size > 1;

    const netAssetPosition =
        pricePerTonne != null
            ? round2((standingCropValue ?? 0) + (grainOnHandValue ?? 0) - (rentCostProduceValue ?? 0))
            : null;

    let netWorth: number | null = null;
    let netWorthUnavailableReason: string | null = null;
    // The CODE is what the client translates; the sentence is the fallback
    // for a client that does not recognise the code. Both are set on every
    // refusal branch — see NET_WORTH_REFUSAL_CODES.
    let netWorthUnavailableCode: NetWorthRefusalCode | null = null;
    let netWorthUnavailableParams: Record<string, string> | null = null;
    if (pricePerTonne == null) {
        netWorthUnavailableCode = 'NO_MARKET_PRICE';
        netWorthUnavailableParams = { commodity };
        netWorthUnavailableReason = `No market price is available for ${commodity}.`;
    } else if (cashCostCurrencyMixed) {
        netWorthUnavailableCode = 'MIXED_COST_CURRENCY';
        netWorthUnavailableReason =
            'Cash costs were recorded in more than one currency; blending them into net worth would misstate the total.';
    } else if (cashCostCurrencies.size === 0) {
        // No currency recorded ANYWHERE on the cost side. That is two
        // situations wearing one shape, and both subtract:
        //
        //   • there is genuinely no cost — cashCostTotal is 0, and
        //     subtracting 0 is the right answer;
        //   • there IS cost, entered through the journal, which never
        //     writes `costCurrency` (the column is nullable, the modal
        //     declares the field and does not send it — see the docblock
        //     on /grain/costs). `addCurrency` in cost-rollup skips nulls,
        //     so a real magnitude arrives with an empty currency set.
        //
        // This branch used to return `netAssetPosition` unchanged, which
        // silently DROPPED the second case's cost from net worth. It was
        // invisible from in here — the figure is internally consistent —
        // and only showed up once /grain/calculator rendered cashCostTotal
        // beside it: a hero of 25,000 next to a table row reading cost
        // 4,000, net worth 25,000.
        //
        // Subtracting treats an unlabelled magnitude as the tenant's
        // display currency, which is the assumption the product already
        // makes wherever it PRINTS these numbers (/grain/costs renders
        // every cost under `Tenant.currencySymbol` regardless of
        // `costCurrency`). The refusals that guard real ambiguity are
        // untouched: mixed currencies, an unknown rent currency, and a
        // cost currency that disagrees with the price currency all still
        // withhold the figure above and below this branch.
        netWorth = round2((netAssetPosition ?? 0) - cashCostTotal);
    } else {
        const onlyCurrency = [...cashCostCurrencies][0];
        if (onlyCurrency === UNKNOWN_RENT_CURRENCY) {
            netWorthUnavailableCode = 'RENT_CURRENCY_UNRECORDED';
            netWorthUnavailableReason =
                'Rent cost currency is not recorded on the lease (ParcelLease has no currency column); it cannot be combined with market-priced assets without inventing one.';
        } else if (onlyCurrency !== priceCurrency) {
            netWorthUnavailableCode = 'COST_PRICE_CURRENCY_MISMATCH';
            netWorthUnavailableParams = {
                costCurrency: onlyCurrency,
                priceCurrency: priceCurrency ?? '',
            };
            netWorthUnavailableReason = `Cost currency (${onlyCurrency}) does not match the market price currency (${priceCurrency}); no currency conversion is performed.`;
        } else {
            netWorth = round2((netAssetPosition ?? 0) - cashCostTotal);
        }
    }

    return {
        commodity,
        pricePerTonne,
        priceCurrency,
        priceObservedAt: reference?.observedAt ?? null,
        priceSource: reference?.source ?? null,

        standingCropAreaHa: a.standingCropAreaHa,
        standingCropExpectedKg: a.standingCropExpectedKg,
        standingCropPlantingIds: a.standingCropPlantingIds,
        standingCropValue,

        grainOnHandTonnes: round3(a.grainOnHandTonnes),
        grainOnHandLotIds: a.grainOnHandLotIds,
        grainOnHandValue,

        attributedCropCost: a.attributedCropCost,
        attributedCropCostCurrencies: [...a.attributedCropCostCurrencies].sort(),
        attributedCropCostCurrencyMixed: a.attributedCropCostCurrencyMixed,

        rentCostMoneyAmount: round2(a.rentCostMoneyAmount),
        rentCostProduceKg: round2(a.rentCostProduceKg),
        rentCostProduceValue,

        payrollCost: round2(a.payrollCost),
        payrollCostCurrencies: [...a.payrollCostCurrencies].sort(),
        payrollCostCurrencyMixed: a.payrollCostCurrencies.size > 1,
        payrollAllocated: a.payrollAllocated,

        cashCostTotal,
        cashCostCurrencies: [...cashCostCurrencies].sort(),
        cashCostCurrencyMixed,

        // Carried beside the cost they qualify: cashCostTotal above is a
        // floor whenever either of these is non-zero.
        unvaluedNoUnitCost: a.unvaluedNoUnitCost,
        unvaluedUnitMismatch: a.unvaluedUnitMismatch,

        netAssetPosition,
        netWorth,
        // Only terms that share the standing crop's own area. netWorth is
        // NOT among them: it carries grainOnHandValue, which has no area at
        // all, and farm-wide overhead.
        perArea: computePerArea({
            standingCropAreaHa: a.standingCropAreaHa,
            standingCropValue,
            attributableCost: cashCostTotal,
            standingCropExcludedCount: a.standingCropExcludedCount,
            unvaluedNoUnitCost: a.unvaluedNoUnitCost,
            unvaluedUnitMismatch: a.unvaluedUnitMismatch,
            payrollAllocated: a.payrollAllocated,
        }),
        breakEven: computeBreakEven({
            standingCropExpectedKg: a.standingCropExpectedKg,
            attributableCost: cashCostTotal,
            pricePerTonne,
            priceCurrency,
            standingCropExcludedCount: a.standingCropExcludedCount,
            unvaluedNoUnitCost: a.unvaluedNoUnitCost,
            unvaluedUnitMismatch: a.unvaluedUnitMismatch,
            payrollAllocated: a.payrollAllocated,
        }),
        netWorthUnavailableReason,
        netWorthUnavailableCode,
        netWorthUnavailableParams,
    };
}

/** All BOUNDED, batched reads this usecase owns — one `runInTenantContext`
 *  transaction, no read inside a loop (query-shape guardrail D1/D2). */
async function loadTenantRows(db: PrismaTx, ctx: RequestContext, seasonId: string | undefined) {
    const plantingRows = await db.planting.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(seasonId ? { cropPlan: { is: { seasonId } } } : {}),
        },
        select: {
            id: true,
            areaM2: true,
            plannedYieldKgPerHa: true,
            parcelId: true,
            // `parcel.name` and `cropType.name` are for the EXCLUSION LABEL,
            // not the arithmetic. Widening a select that already runs costs
            // two columns; a second query per excluded planting would trip
            // D1 and read once per bullet point.
            parcel: { select: { name: true } },
            cropPlan: {
                select: {
                    seasonId: true,
                    cropType: { select: { commodityCanonical: true, name: true } },
                },
            },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PLANTING_TAKE + 1,
    });
    const plantingsTruncated = plantingRows.length > PLANTING_TAKE;
    const plantings = plantingsTruncated ? plantingRows.slice(0, PLANTING_TAKE) : plantingRows;

    // Grain on hand is a POINT-IN-TIME stock read, not season-scoped —
    // there is no season concept on InventoryLot.
    const lotRows = await db.inventoryLot.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, item: { is: { category: 'HARVESTED_PRODUCE' } } },
        select: { id: true, quantityOnHand: true, unitId: true, item: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LOT_TAKE + 1,
    });
    const lotsTruncated = lotRows.length > LOT_TAKE;
    const lots = lotsTruncated ? lotRows.slice(0, LOT_TAKE) : lotRows;

    // ONE batched Unit lookup for every distinct unit the lots use — never
    // a read per lot.
    const unitIds = [...new Set(lots.map((l) => l.unitId))];
    const units = unitIds.length
        ? await db.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, key: true }, take: UNIT_TAKE })
        : [];

    // Active leases only (mirrors rent-roll.ts): not yet ended.
    const leaseRows = await db.parcelLease.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            OR: [{ endDate: null }, { endDate: { gte: new Date() } }],
            parcel: { deletedAt: null },
        },
        select: {
            id: true,
            parcelId: true,
            rentAmount: true,
            rentUnit: true,
            rentUnitRaw: true,
            lessorName: true,
            parcel: { select: { areaHa: true, name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LEASE_TAKE + 1,
    });
    const leasesTruncated = leaseRows.length > LEASE_TAKE;
    const leases = leasesTruncated ? leaseRows.slice(0, LEASE_TAKE) : leaseRows;

    // Cost entries — the /grain/costs register, and the SOLE source of
    // payroll since it replaced the separate PayrollExpense surface.
    //
    // One read serves two different figures, which is why it is not
    // filtered by category here:
    //   • PAYROLL rows feed the COST side, through the same
    //     `computePayroll` allocation they always did (a CostEntry row has
    //     the identical shape, so the allocator is untouched).
    //   • EVERY row feeds CASH-OUT, reported per currency beside the cost
    //     side and never inside it — see COST_METRICS.GRAIN_CASH_OUT for
    //     why folding purchases into consumption-based crop cost would
    //     bill the same sack of fertiliser twice.
    //
    // Scoped to the season directly OR via one of this season's plantings,
    // both bounded by the id set already loaded above.
    const plantingIds = plantings.map((p) => p.id);
    const costEntryRows = await db.costEntry.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            ...(seasonId
                ? { OR: [{ seasonId }, ...(plantingIds.length ? [{ plantingId: { in: plantingIds } }] : [])] }
                : {}),
        },
        select: {
            id: true,
            category: true,
            amount: true,
            currency: true,
            plantingId: true,
            seasonId: true,
            supplier: true,
            description: true,
            incurredOn: true,
        },
        orderBy: [{ incurredOn: 'desc' }, { id: 'desc' }],
        take: PAYROLL_TAKE + 1,
    });
    const costEntriesTruncated = costEntryRows.length > PAYROLL_TAKE;
    const costEntries = costEntriesTruncated
        ? costEntryRows.slice(0, PAYROLL_TAKE)
        : costEntryRows;

    return {
        plantings,
        lots,
        units,
        leases,
        costEntries,
        truncated:
            plantingsTruncated || lotsTruncated || leasesTruncated || costEntriesTruncated,
    };
}

export async function getGrainNetWorth(
    ctx: RequestContext,
    opts: { seasonId?: string } = {},
): Promise<GrainNetWorthResult> {
    assertCanRead(ctx);
    const seasonId = opts.seasonId;

    const fetched = await runInTenantContext(ctx, (db) => loadTenantRows(db, ctx, seasonId));

    // Sibling usecase calls — their own transactions/global reads, not
    // nested inside ours (see module docblock).
    const costRollup = await getCostRollupByPlanting(ctx, { seasonId, take: PLANTING_TAKE });

    const exclusions = emptyExclusions();
    const acc = new Map<CanonicalCommodity, CommodityAcc>();

    const plantingInfo = buildPlantingInfo(fetched.plantings);
    const allPlantings = [...plantingInfo.values()];

    // ── 1. Standing crop ──
    computeStandingCrop(allPlantings, acc, exclusions);

    // ── 2. Grain on hand ──
    const unitById = new Map(fetched.units.map((u) => [u.id, u]));
    computeGrainOnHand(fetched.lots, unitById, acc, exclusions);

    // ── 3a. Attributed crop cost (reused from cost-rollup) ──
    computeAttributedCost(costRollup.rows, plantingInfo, acc, exclusions);

    // ── 3b. Rent, attributed parcel → planting ──
    const plantingsByParcel = new Map<string, PlantingInfo[]>();
    for (const p of allPlantings) {
        if (!p.parcelId) continue;
        let group = plantingsByParcel.get(p.parcelId);
        if (!group) {
            group = [];
            plantingsByParcel.set(p.parcelId, group);
        }
        group.push(p);
    }
    computeRent(fetched.leases, plantingsByParcel, acc, exclusions);

    // ── 3c/6. Payroll, direct + pro-rata by area ──
    const knownCommodityPlantings = allPlantings.filter((p) => p.commodity != null);
    const plantingsBySeason = new Map<string | null, PlantingInfo[]>();
    for (const p of knownCommodityPlantings) {
        let group = plantingsBySeason.get(p.seasonId);
        if (!group) {
            group = [];
            plantingsBySeason.set(p.seasonId, group);
        }
        group.push(p);
    }
    // ONLY the PAYROLL category reaches the cost side. Every other
    // category is a purchase or a cash settlement of an accrual, and both
    // would double-count against consumption-based crop cost or the
    // lease-terms rent accrual — see COST_METRICS.GRAIN_CASH_OUT.
    const payrollEntries = fetched.costEntries.filter((e) => e.category === 'PAYROLL');
    computePayroll(payrollEntries, plantingInfo, plantingsBySeason, knownCommodityPlantings, acc, exclusions);

    // Cash-out: EVERY entry, grouped by the currency it was recorded in.
    // Never summed across currencies — there is no FX table in this repo,
    // and one blended figure would be a number nobody could reconcile.
    const cashOut = computeCashOut(fetched.costEntries);

    // ── 4. Price — one batched lookup for every commodity touched ──
    const commodities = [...acc.keys()].sort(byCanonicalOrder);
    const references = await getMarketReferences(commodities);

    const rows = commodities.map((commodity) =>
        finalizeRow(commodity, acc.get(commodity) ?? newAcc(), references.get(commodity) ?? null, exclusions),
    );

    // De-duplicate + sort every exclusion list — several sources can name
    // the same planting/lease (e.g. a planting with no yield estimate AND
    // an unknown commodity would only ever land in ONE of the two lists,
    // but a planting can be pushed by both cost and payroll attribution).
    exclusions.plantingsUnknownCommodity = [...new Set(exclusions.plantingsUnknownCommodity)].sort();
    exclusions.plantingsMissingYieldEstimate = [...new Set(exclusions.plantingsMissingYieldEstimate)].sort();
    exclusions.leasesProduceRentUnpriced = [...new Set(exclusions.leasesProduceRentUnpriced)].sort();
    exclusions.payrollUnattributable = [...new Set(exclusions.payrollUnattributable)].sort();
    exclusions.commoditiesWithNoPrice = [...new Set(exclusions.commoditiesWithNoPrice)].sort();

    // ── Labelling pass ──
    //
    // ONE pass over ids already collected, resolved against rows already
    // in memory. No query: the selects above were widened by a few columns
    // (parcel.name, cropType.name, lessorName, supplier, description,
    // incurredOn) rather than adding a read, so this cannot trip D1 and
    // costs nothing per entry.
    const label = buildExclusionLabels({
        plantings: fetched.plantings,
        lots: fetched.lots,
        units: new Map(fetched.units.map((u) => [u.id, u.key])),
        leases: fetched.leases,
        costEntries: fetched.costEntries,
    });
    const labelled: GrainNetWorthExclusions = {
        plantingsMissingYieldEstimate: exclusions.plantingsMissingYieldEstimate.map((id) => ({
            id,
            label: label.planting(id),
        })),
        plantingsUnknownCommodity: exclusions.plantingsUnknownCommodity.map((id) => ({
            id,
            label: label.planting(id),
        })),
        lotsUnresolvedUnit: exclusions.lotsUnresolvedUnit.map((e) => ({
            id: e.lotId,
            label: label.lot(e.lotId, e.unitKey),
        })),
        lotsUnknownCommodity: exclusions.lotsUnknownCommodity.map((id) => ({
            id,
            label: label.lot(id),
        })),
        // The id IS the commodity slug, and the label with it: commodity
        // names are the one thing here the CLIENT can translate, and it
        // already does everywhere else on this page.
        commoditiesWithNoPrice: exclusions.commoditiesWithNoPrice.map((id) => ({
            id,
            label: id,
        })),
        leasesUnresolvedRent: exclusions.leasesUnresolvedRent.map((e) => ({
            id: e.leaseId,
            label: label.lease(e.leaseId),
        })),
        leasesUnattributed: exclusions.leasesUnattributed.map((id) => ({
            id,
            label: label.lease(id),
        })),
        leasesProduceRentUnpriced: exclusions.leasesProduceRentUnpriced.map((id) => ({
            id,
            label: label.lease(id),
        })),
        payrollUnattributable: exclusions.payrollUnattributable.map((id) => ({
            id,
            label: label.costEntry(id),
        })),
    };

    return {
        generatedAt: new Date().toISOString(),
        seasonId: seasonId ?? null,
        rows,
        // A FOLD over rows already computed — no additional read, so the
        // D1/D2 query guardrails are untouched. Computed here rather than
        // in the island because /grain/calculator's stated property is
        // that it "never re-derives a cost, a yield or a price", and a
        // client-side reduce over money is exactly that.
        farm: {
            totals: foldFarmTotals(rows),
            refusedWithoutCurrency: rows
                .filter((r) => r.netWorth == null && r.priceCurrency == null)
                .map((r) => r.commodity)
                .sort(),
        },
        exclusions: labelled,
        // Passed straight through, NOT recomputed from `rows` — the rollup
        // counted TRANSACTIONS, and summing the per-commodity counts would
        // multiply a shared one by the commodities it touched.
        unvalued: costRollup.unvalued,
        // Beside the cost side, never inside it. Per currency, never
        // blended — see COST_METRICS.GRAIN_CASH_OUT.
        cashOut,
        truncated: fetched.truncated || costRollup.truncated,
    };
}
