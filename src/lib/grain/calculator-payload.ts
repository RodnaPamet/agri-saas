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
 *
 * ── where these types now come from ──
 *
 * The payload's own shapes are `z.infer` of the schemas in
 * `@/lib/dto/grain-calculator.dto`, re-exported here under the names they have
 * always had. That is deliberate and it is the point: `grain.paths.ts` left
 * this operation's response undocumented because writing the shape as Zod would
 * have been a THIRD spelling of one money payload, free to drift from these
 * interfaces and from the mapper below. Deriving the types FROM the schema
 * removes the third spelling by removing the second — there is one definition,
 * and it is the one the API publishes.
 *
 * The leaf types this composes (`PerAreaFigures`, `BreakEvenFigures`,
 * `FarmNetWorthTotal`, `ExclusionEntry`, `UncertaintyState`) stay owned by the
 * modules that COMPUTE them; those have mirrors in the DTO module pinned by
 * compile-time equality assertions, so a divergence is a type error rather than
 * a silent lie in the spec.
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
import type { z } from '@/lib/openapi/zod';
import type {
    CalculatorCostSliceSchema,
    CalculatorRowSchema,
    CalculatorExclusionsSchema,
    CalculatorCashOutLineSchema,
    CalculatorDataSchema,
} from '@/lib/dto/grain-calculator.dto';
import { UNKNOWN_RENT_CURRENCY } from './cost-metrics';

export type { ExclusionEntry };

/**
 * The payload's shapes.
 *
 * Declared by the schemas in `@/lib/dto/grain-calculator.dto` and inferred
 * here, so the type, the runtime validator and the published OpenAPI component
 * are one definition. Editing a field is one edit.
 *
 * `CalculatorCostSlice.variant` was `StatusBreakdownVariant | undefined` — a
 * REQUIRED key holding undefined. `undefined` does not survive
 * `JSON.stringify`, so over HTTP the key is simply ABSENT; the schema says
 * optional, which is what a client actually receives. Nothing that builds a
 * slice needs to change: passing `variant` explicitly still typechecks.
 */
export type CalculatorCostSlice = z.infer<typeof CalculatorCostSliceSchema>;
export type CalculatorRow = z.infer<typeof CalculatorRowSchema>;
export type CalculatorExclusions = z.infer<typeof CalculatorExclusionsSchema>;
export type CalculatorCashOutLine = z.infer<typeof CalculatorCashOutLineSchema>;
export type CalculatorData = z.infer<typeof CalculatorDataSchema>;

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
