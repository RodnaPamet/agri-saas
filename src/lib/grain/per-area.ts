/**
 * Per-decare figures for the grain calculator.
 *
 * Bulgarian farmers think in декари and the land market quotes rent in
 * лв/дка. Absolute totals answer "what is it worth"; per-dca answers the
 * questions a farmer acts on — is this field better than that one, is this
 * year better than last, does this rented parcel earn its rent.
 *
 * ── The numerator trap ──────────────────────────────────────────────
 *
 * `netWorth / area` is nonsense and is never computed. Net worth is
 * `standing + onHand − rentInGrain − cost`, and `grainOnHandValue` has NO
 * area: it is tonnes in a store, harvested off land that may not even be
 * this season's. The cost side carries farm-wide overhead. Dividing that
 * numerator by a planting-area denominator mixes scopes and produces a
 * confident, wrong number.
 *
 * Only terms attributable to the standing crop's own plantings share the
 * denominator: `standingCropValue`, and the cost that was attributed per
 * planting (`attributedCropCost + rentCostMoneyAmount + payrollCost`,
 * which is exactly `cashCostTotal`).
 *
 * ── The denominator trap ────────────────────────────────────────────
 *
 * `standingCropAreaHa` sums INCLUDED plantings only — `computeStandingCrop`
 * filters to `summary.includedPlantingIds` before reducing — so tonnage,
 * value and hectares all describe the same set. Using total planted area
 * instead would silently understate by however many plantings lacked a
 * yield estimate.
 *
 * But `cashCostTotal` is NOT filtered that way: it is every cost attributed
 * to the commodity, including those excluded plantings. So when anything
 * was excluded, the cost side covers more land than the revenue side and
 * the margin is understated — while an unpriced consumption biases it the
 * other way. Two opposite biases cannot be expressed as one bound, so the
 * figure is PARTIAL, which is what the vocabulary already means by
 * "records are missing".
 *
 * @module lib/grain/per-area
 */
import { DCA_PER_HA } from '@/lib/agro/rate-calc';
import { UNCERTAINTY, costIsFloor, type UncertaintyState } from './uncertainty';

/** Why a per-dca figure was withheld. Never a blank, never a NaN. */
export type PerAreaRefusalCode = 'NO_STANDING_CROP_AREA' | 'NO_STANDING_CROP_VALUE';

export interface PerAreaInput {
    /** INCLUDED-planting area. See the denominator trap above. */
    standingCropAreaHa: number;
    standingCropValue: number | null;
    /** `cashCostTotal` — the per-planting attributed cost. */
    attributableCost: number;
    /** Plantings of this commodity dropped for a missing yield estimate. */
    standingCropExcludedCount: number;
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;
    payrollAllocated: boolean;
}

export interface PerAreaFigures {
    /** Display unit. Storage stays hectares; there is no second stored unit. */
    areaDca: number;
    standingValuePerDca: number | null;
    attributableCostPerDca: number | null;
    /**
     * `(standingCropValue − attributableCost) / area`.
     *
     * Named a MARGIN and never "net worth per dca", because it is built
     * from a strict subset of net worth's terms — the ones that share an
     * area — and the two must not be mistaken for each other.
     */
    marginPerDca: number | null;
    uncertainty: UncertaintyState;
    refusalCode: PerAreaRefusalCode | null;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function computePerArea(input: PerAreaInput): PerAreaFigures {
    const areaDca = round2((input.standingCropAreaHa || 0) * DCA_PER_HA);

    // `> 0` and not `!== 0`: this also rejects NaN and negatives, either of
    // which would otherwise reach the division and come back out as a
    // confident figure nobody can reconcile.
    const divisible = Number.isFinite(areaDca) && areaDca > 0;
    const refusalCode: PerAreaRefusalCode | null = !divisible
        ? 'NO_STANDING_CROP_AREA'
        : input.standingCropValue == null
          ? 'NO_STANDING_CROP_VALUE'
          : null;

    if (refusalCode != null) {
        return {
            areaDca: Number.isFinite(areaDca) ? areaDca : 0,
            standingValuePerDca: null,
            attributableCostPerDca: null,
            marginPerDca: null,
            uncertainty: UNCERTAINTY.REFUSED,
            refusalCode,
        };
    }

    const value = input.standingCropValue as number;
    return {
        areaDca,
        standingValuePerDca: round2(value / areaDca),
        attributableCostPerDca: round2(input.attributableCost / areaDca),
        marginPerDca: round2((value - input.attributableCost) / areaDca),
        uncertainty: perAreaUncertainty(input),
        refusalCode: null,
    };
}

/**
 * The same precedence the farm total uses, for the same reason.
 *
 * PARTIAL outranks the bounds: a margin whose cost covers land its revenue
 * does not is not merely imprecise, it is about a different area. Below
 * that, bound before allocation, matching `costUncertainty` so the three
 * levels — row, farm, per-dca — cannot disagree about which qualifier
 * matters more.
 *
 * AT_MOST rather than AT_LEAST: an unpriced consumption understates the
 * cost, which OVERSTATES the margin. The bound on the margin points the
 * opposite way to the bound on the cost that caused it.
 */
function perAreaUncertainty(input: PerAreaInput): UncertaintyState {
    if (input.standingCropExcludedCount > 0) return UNCERTAINTY.PARTIAL;
    if (costIsFloor(input)) return UNCERTAINTY.AT_MOST;
    if (input.payrollAllocated) return UNCERTAINTY.ALLOCATED;
    return UNCERTAINTY.EXACT;
}
