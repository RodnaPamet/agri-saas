/**
 * Break-even: the price a crop must fetch to cover what it cost.
 *
 * Net worth says what the grain is worth. Break-even says whether to sell
 * it, and the answer is a comparison a farmer can make in one glance —
 * market price against the price that clears cost.
 *
 * ── Why the visual is a RATIO, and why that is not a currency blend ──
 *
 * `market / breakEven` is dimensionless. Both sides are in the SAME
 * currency by construction: `getGrainNetWorth` refuses a row outright
 * unless its cost currency equals its price currency, so the quotient
 * carries no currency at all. A EUR crop and a BGN crop can therefore sit
 * on one ratio scale without anything being blended, because there is no
 * money on that scale. The money itself is still shown per crop with its
 * own code — the ratio is the comparison, the figures are the evidence.
 *
 * ── Why the bound does NOT invert here ──────────────────────────────
 *
 * On the per-dca margin, an unpriced consumption understates the cost and
 * therefore OVERSTATES the margin — AT_LEAST cost, AT_MOST margin. Here
 * the same cause understates the price needed to clear that cost, so the
 * true break-even is this or HIGHER. Same input, same direction:
 * AT_LEAST. Worth stating because the two figures sit next to each other
 * and it would be natural to assume they hedge the same way.
 *
 * @module lib/grain/break-even
 */
import { UNCERTAINTY, costIsFloor, type UncertaintyState } from './uncertainty';

export type BreakEvenRefusalCode = 'NO_EXPECTED_TONNAGE' | 'NO_MARKET_PRICE';

export interface BreakEvenInput {
    /** Expected yield of the INCLUDED plantings. */
    standingCropExpectedKg: number;
    /** `cashCostTotal` — the per-planting attributed cost. */
    attributableCost: number;
    pricePerTonne: number | null;
    priceCurrency: string | null;
    standingCropExcludedCount: number;
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;
    payrollAllocated: boolean;
}

export interface BreakEvenFigures {
    /** Cost ÷ tonnes. The price that clears. */
    breakEvenPricePerTonne: number | null;
    marketPricePerTonne: number | null;
    currency: string | null;
    /** `market / breakEven × 100`. Dimensionless — see the module docblock. */
    coverPercent: number | null;
    /** Whether the market price clears the cost. Null when unknowable. */
    covered: boolean | null;
    uncertainty: UncertaintyState;
    refusalCode: BreakEvenRefusalCode | null;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function computeBreakEven(input: BreakEvenInput): BreakEvenFigures {
    const tonnes = (input.standingCropExpectedKg || 0) / 1000;
    const hasTonnage = Number.isFinite(tonnes) && tonnes > 0;
    const market = input.pricePerTonne;

    if (!hasTonnage || market == null) {
        return {
            breakEvenPricePerTonne: null,
            marketPricePerTonne: market,
            currency: input.priceCurrency,
            coverPercent: null,
            covered: null,
            uncertainty: UNCERTAINTY.REFUSED,
            refusalCode: !hasTonnage ? 'NO_EXPECTED_TONNAGE' : 'NO_MARKET_PRICE',
        };
    }

    const breakEven = round2(input.attributableCost / tonnes);

    return {
        breakEvenPricePerTonne: breakEven,
        marketPricePerTonne: market,
        currency: input.priceCurrency,
        // A costless crop clears at any price. The RATIO is undefined, so
        // it is withheld rather than reported as Infinity — but the
        // verdict below is not in doubt.
        coverPercent: breakEven > 0 ? round2((market / breakEven) * 100) : null,
        covered: market >= breakEven,
        uncertainty: breakEvenUncertainty(input),
        refusalCode: null,
    };
}

/**
 * REFUSED > PARTIAL > AT_LEAST > ALLOCATED > EXACT.
 *
 * The same precedence the row, farm and per-dca levels use, so the four
 * cannot disagree about which qualifier matters most. The bound is
 * AT_LEAST rather than AT_MOST for the reason in the module docblock: an
 * understated cost understates the price needed to clear it.
 */
function breakEvenUncertainty(input: BreakEvenInput): UncertaintyState {
    if (input.standingCropExcludedCount > 0) return UNCERTAINTY.PARTIAL;
    if (costIsFloor(input)) return UNCERTAINTY.AT_LEAST;
    if (input.payrollAllocated) return UNCERTAINTY.ALLOCATED;
    return UNCERTAINTY.EXACT;
}
