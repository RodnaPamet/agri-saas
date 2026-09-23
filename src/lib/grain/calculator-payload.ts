/**
 * The grain calculator's wire payload, and the single mapper that builds it.
 *
 * ── Why this is a module and not a function inside the page ──
 *
 * `toCalculatorRow` lived in `grain/calculator/page.tsx`, which was correct
 * while the page was the only consumer. It no longer is: the native iOS client
 * needs the same answer over HTTP, and a Server Component cannot serve one.
 *
 * Writing a second mapping for the API route would give us two spellings of one
 * payload, free to drift. That is not hypothetical — the same shape cost this
 * project a day on 2026-09-21, when the app built its request URL with
 * `URL.appending(path:)` while the auth client used `URLComponents`. One
 * codebase, two idioms, only one of them right, and nothing to make them
 * disagree out loud. The page and the route now call this, so they cannot.
 *
 * ── What the mapping is FOR ──
 *
 * The island used to receive the usecase's row verbatim — thirty fields shaped
 * by what the usecase COMPUTES rather than by what the page STATES — and
 * assembled an answer out of them. Those decisions are made here: the rent
 * sentinel is filtered out, the uncertainty states are resolved, and whether a
 * term belongs on screen is settled before anything renders. A consumer
 * receives an answer to FORMAT, not parts to assemble.
 *
 * Every field is a number, string, boolean or array thereof. No Decimal and no
 * Date crosses this boundary, which is what makes the payload equally valid
 * across an RSC boundary and a JSON response.
 */
import type {
    CommodityNetWorthRow,
    GrainNetWorthResult,
} from '@/app-layer/usecases/grain-net-worth';
import type { StatusBreakdownVariant } from '@/components/ui/status-breakdown';
import type { FarmNetWorthTotal } from './farm-total';
import type { ExclusionEntry } from './exclusion-labels';
import type { PerAreaFigures } from './per-area';
import type { BreakEvenFigures } from './break-even';
import { costUncertainty, netWorthUncertainty, type UncertaintyState } from './uncertainty';
import { UNKNOWN_RENT_CURRENCY } from './cost-metrics';

export type { ExclusionEntry };

/**
 * One labelled slice of the cost total, decided server-side.
 *
 * `variant` is a PRESENTATION hint — which tone the web table paints the slice.
 * It travels in the payload because the composition (which categories, in what
 * order, in which tone) is structure rather than data, and the web island no
 * longer decides that there are three of them. A non-web client may ignore it.
 */
export interface CalculatorCostSlice {
    id: string;
    /** i18n key under `grain.calculator` — the consumer resolves it. */
    labelKey: string;
    value: number;
    variant: StatusBreakdownVariant | undefined;
}

export interface CalculatorRow {
    commodity: string;

    pricePerTonne: number | null;
    priceCurrency: string | null;
    priceObservedAt: string | null;
    priceSource: string | null;

    standingCropAreaHa: number;
    standingCropExpectedKg: number;
    standingCropValue: number | null;
    /** Per-decare figures over the terms that share this area. */
    perArea: PerAreaFigures;
    /** Market price against the price that clears cost. */
    breakEven: BreakEvenFigures;

    grainOnHandTonnes: number;
    grainOnHandValue: number | null;

    rentCostProduceKg: number;
    rentCostProduceValue: number | null;
    payrollAllocated: boolean;
    cashCostTotal: number;

    // Carried with their COUNTS, so they stay data rather than collapsing into
    // `costUncertainty` — the state says the cost is a floor, these say by how
    // many records and why.
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;

    netWorth: number | null;
    /** English, authored by the usecase — the FALLBACK for an unknown code. */
    netWorthUnavailableReason: string | null;
    /** Machine-readable reason, translated by the consumer when recognised. */
    netWorthUnavailableCode: string | null;
    netWorthUnavailableParams: Record<string, string> | null;

    /** Shared vocabulary — see `@/lib/grain/uncertainty`. */
    netUncertainty: UncertaintyState;
    costUncertainty: UncertaintyState;
    /** Real ISO codes only; the internal rent sentinel is already gone. */
    costCurrencyCodes: string[];
    /** True when rent currency was the sentinel — stated in its own words. */
    rentCurrencyUnknown: boolean;
    /** Whether the rent-in-grain term is part of this farm's arithmetic. */
    showProduceRent: boolean;
    /** The cost's composition — which categories, in what order and tone. */
    costBreakdown: CalculatorCostSlice[];
}

/**
 * ONE shape for every exclusion class. Each entry carries the id (deep links
 * need it) and a label a person recognises, resolved server-side.
 */
export interface CalculatorExclusions {
    plantingsMissingYieldEstimate: ExclusionEntry[];
    plantingsUnknownCommodity: ExclusionEntry[];
    lotsUnresolvedUnit: ExclusionEntry[];
    lotsUnknownCommodity: ExclusionEntry[];
    commoditiesWithNoPrice: ExclusionEntry[];
    leasesUnresolvedRent: ExclusionEntry[];
    leasesUnattributed: ExclusionEntry[];
    leasesProduceRentUnpriced: ExclusionEntry[];
    payrollUnattributable: ExclusionEntry[];
}

/** One currency's worth of money that left the bank. */
export interface CalculatorCashOutLine {
    currency: string;
    amount: number;
    categories: string[];
}

export interface CalculatorData {
    generatedAt: string;
    seasonId: string | null;
    rows: CalculatorRow[];
    /** The farm-level answer — one total per currency. Folded server-side. */
    farm: {
        totals: FarmNetWorthTotal[];
        refusedWithoutCurrency: string[];
    };
    exclusions: CalculatorExclusions;
    /**
     * Farm-wide DISTINCT counts, NOT the sum of the rows'. Deliberately not an
     * exclusion class: nothing here was excluded — the stock moved and the
     * planting is counted, only the money is missing.
     */
    unvalued: { noUnitCost: number; unitMismatch: number };
    /**
     * `COST_METRICS.GRAIN_CASH_OUT` — what LEFT THE BANK, per currency. Its own
     * figure, never added to any cost line: crop cost is consumption-based and
     * rent cost is a lease-terms accrual, so folding a purchase in would bill
     * the same money twice.
     */
    cashOut: CalculatorCashOutLine[];
    /**
     * Cost that landed on land carrying no crop. Carried BECAUSE the rows are
     * short by exactly this — a spread conserves the amount across
     * `rows + this`, so a consumer printing only the rows would show a cost
     * that shrank when the farmer changed how it spreads.
     */
    unallocatedToCrop: {
        amount: number;
        areaHa: number;
        parcelIds: string[];
        currencies: string[];
    };
    imputedLandCharge: GrainNetWorthResult['imputedLandCharge'];
    truncated: GrainNetWorthResult['truncated'];
}

export function toCalculatorRow(row: CommodityNetWorthRow): CalculatorRow {
    return {
        commodity: row.commodity,

        pricePerTonne: row.pricePerTonne,
        priceCurrency: row.priceCurrency,
        priceObservedAt: row.priceObservedAt,
        priceSource: row.priceSource,

        standingCropAreaHa: row.standingCropAreaHa,
        standingCropExpectedKg: row.standingCropExpectedKg,
        standingCropValue: row.standingCropValue,
        perArea: row.perArea,
        breakEven: row.breakEven,

        grainOnHandTonnes: row.grainOnHandTonnes,
        grainOnHandValue: row.grainOnHandValue,

        rentCostProduceKg: row.rentCostProduceKg,
        rentCostProduceValue: row.rentCostProduceValue,
        payrollAllocated: row.payrollAllocated,
        cashCostTotal: row.cashCostTotal,
        unvaluedNoUnitCost: row.unvaluedNoUnitCost,
        unvaluedUnitMismatch: row.unvaluedUnitMismatch,

        netWorth: row.netWorth,
        netWorthUnavailableReason: row.netWorthUnavailableReason,
        netWorthUnavailableCode: row.netWorthUnavailableCode,
        netWorthUnavailableParams: row.netWorthUnavailableParams,

        // ── Derived HERE, not by the consumer ──
        netUncertainty: netWorthUncertainty(row),
        costUncertainty: costUncertainty(row),

        // UNKNOWN_RENT_CURRENCY is an internal sentinel, not an ISO code — the
        // usecase's own docblock says it "is never treated as one". Filtering
        // it here means a consumer renders a list it can trust rather than one
        // it has to clean.
        costCurrencyCodes: row.cashCostCurrencies.filter((c) => c !== UNKNOWN_RENT_CURRENCY),
        rentCurrencyUnknown: row.cashCostCurrencies.includes(UNKNOWN_RENT_CURRENCY),

        // "Should this term be on screen" is a decision, and it belongs with
        // the data. A rent line reading "− €0" states a term the farm does not
        // have.
        showProduceRent: row.rentCostProduceKg > 0,

        costBreakdown: [
            { id: 'field', labelKey: 'costFieldLabel', value: row.attributedCropCost, variant: 'brand' },
            { id: 'rent', labelKey: 'costRentLabel', value: row.rentCostMoneyAmount, variant: 'warning' },
            { id: 'payroll', labelKey: 'costPayrollLabel', value: row.payrollCost, variant: 'info' },
        ],
    };
}

/** The whole payload, from the usecase result. The page and the API route
 *  both call this, so neither can describe the calculator differently. */
export function buildCalculatorPayload(result: GrainNetWorthResult): CalculatorData {
    return {
        generatedAt: result.generatedAt,
        seasonId: result.seasonId,
        rows: result.rows.map(toCalculatorRow),
        farm: result.farm,
        exclusions: result.exclusions,
        unvalued: result.unvalued,
        cashOut: result.cashOut,
        // Both BESIDE the cost side, both for the same reason: neither is money
        // attributable to a crop. A spread that is conserved but not PRINTED
        // reads as a cost that shrank.
        unallocatedToCrop: result.unallocatedToCrop,
        imputedLandCharge: result.imputedLandCharge,
        truncated: result.truncated,
    };
}
