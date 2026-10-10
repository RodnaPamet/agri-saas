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
// The money-rent sentinel, imported rather than re-spelled. `cost-rollup`
// pushes it because `ParcelLease` has no currency column. It is a sibling lib
// module, so there is no cycle and no second copy to drift — a local constant
// here would make every money-rent farm's cost rate look like an ordinary
// single-currency one the moment the two spellings diverged.
import { UNKNOWN_RENT_CURRENCY } from './cost-metrics';
import { UNCERTAINTY, costIsFloor, type UncertaintyState } from './uncertainty';

/** Why a per-dca VALUE figure was withheld. Never a blank, never a NaN. */
export type PerAreaRefusalCode = 'NO_STANDING_CROP_AREA' | 'NO_STANDING_CROP_VALUE';

/**
 * Why the COST rate was withheld — a SEPARATE vocabulary, deliberately.
 *
 * `refusalCode` describes the value figures, and after #1512 the cost rate
 * stands on its own: it can be present when they are refused and refused when
 * they are present. One code for both would have to mean "something is missing
 * somewhere", which is not a sentence a client can render.
 *
 * `COST_CURRENCY_MIXED` and `COST_CURRENCY_UNRECORDED` mirror
 * `MIXED_COST_CURRENCY` / `RENT_CURRENCY_UNRECORDED` on net worth, for the same
 * reason and with the same severity: no FX is ever invented, so costs that are
 * not in ONE known currency are not a money figure and are withheld rather
 * than blended.
 */
export type PerAreaCostRefusalCode =
    | 'NO_OCCUPIED_AREA'
    | 'COST_CURRENCY_MIXED'
    | 'COST_CURRENCY_UNRECORDED';

export interface PerAreaInput {
    /** INCLUDED-planting area. See the denominator trap above. */
    standingCropAreaHa: number;
    /**
     * Land the crop OCCUPIES — the COST rate's denominator (#1512).
     *
     * A different area from `standingCropAreaHa`, and the distinction is the
     * point. That one is the area whose expected YIELD is counted, so it is
     * the only honest denominator for a value figure. A parcel growing this
     * crop with no yield estimate still costs money and still occupies land,
     * so dividing a cost by the yield-covered area understates the rate by
     * exactly the land the farm cannot forecast — and on a farm with no real
     * plantings it is 0, which turned a knowable rate into a refusal.
     */
    occupiedAreaHa: number;
    standingCropValue: number | null;
    /** `cashCostTotal` — the per-planting attributed cost. */
    attributableCost: number;
    /**
     * Every currency contributing to `attributableCost`, which is a MAGNITUDE
     * sum taken regardless of mix — `cashCostTotal`'s own docblock says never to
     * assume it shares a currency with the market price.
     *
     * So the cost rate cannot be labelled with `priceCurrency`, and #1606
     * shipped it with no currency at all: a bare number a client had to guess
     * the unit of. This closes that gap. May contain the `UNKNOWN_RENT_CURRENCY`
     * sentinel, which `ParcelLease` forces because it has no currency column.
     *
     * EMPTY is not an error and not a refusal. It means no cost row recorded a
     * currency anywhere — overwhelmingly the journal path, which never writes
     * `costCurrency` — and the product already treats an unlabelled magnitude as
     * the tenant's display currency wherever it PRINTS one (`/grain/costs`
     * renders every cost under `Tenant.currencySymbol` regardless). Net worth
     * makes the same assumption in the same situation and says so. Refusing here
     * instead would withhold the rate on exactly the farms that have no
     * structured cost data, which are the ones #1512 was filed about.
     */
    costCurrencies: readonly string[];
    /** Plantings of this commodity dropped for a missing yield estimate. */
    standingCropExcludedCount: number;
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;
    /** Cost entries that reached NO commodity — see `costIsFloor`. */
    unattributedCostEntries: number;
    payrollAllocated: boolean;
}

export interface PerAreaFigures {
    /** Display unit. Storage stays hectares; there is no second stored unit. */
    /**
     * The denominator of `standingValuePerDca` and `marginPerDca` — the
     * yield-covered area in decares.
     *
     * NOT the denominator of `attributableCostPerDca`. See `costAreaDca`.
     */
    areaDca: number;
    /**
     * The denominator of `attributableCostPerDca`, in decares (#1512).
     *
     * Exposed because anything displayed beside a per-decare figure has to
     * match it, and after #1512 the cost rate divides by a different area
     * from the value figures. Without this a client would show the
     * yield-covered area — 0 on a farm with no yield estimates — directly
     * above a cost-per-decare computed from a real one, which is a
     * contradiction a farmer reads in one glance.
     *
     * Each figure's own denominator is named rather than left for a client to
     * recompute, so the two cannot drift: a client multiplying back up gets
     * the number the server divided by, by construction.
     */
    costAreaDca: number;
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
    /**
     * The currency `attributableCostPerDca` is denominated in.
     *
     * `null` means NO cost row recorded one, and by the convention documented on
     * `costCurrencies` the figure is then in the tenant's display currency —
     * which the server does not know and the client does. So null is an
     * INSTRUCTION ("use your tenant symbol"), not an absence. It is never null
     * beside a non-null rate for any other reason: a cost that is not in one
     * known currency is withheld, not labelled.
     */
    costCurrency: string | null;
    /**
     * Why `attributableCostPerDca` is null, when it is.
     *
     * Non-null exactly when `attributableCostPerDca` is null, which a test pins
     * — the pair is the whole contract, and a refusal with no code is the dash
     * this module exists to avoid.
     */
    costRefusalCode: PerAreaCostRefusalCode | null;
    uncertainty: UncertaintyState;
    refusalCode: PerAreaRefusalCode | null;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function computePerArea(input: PerAreaInput): PerAreaFigures {
    const areaDca = round2((input.standingCropAreaHa || 0) * DCA_PER_HA);
    const costAreaDca = round2((input.occupiedAreaHa || 0) * DCA_PER_HA);

    // `> 0` and not `!== 0`: this also rejects NaN and negatives, either of
    // which would otherwise reach the division and come back out as a
    // confident figure nobody can reconcile.
    const divisible = Number.isFinite(areaDca) && areaDca > 0;
    const costDivisible = Number.isFinite(costAreaDca) && costAreaDca > 0;

    // Guarded on BOTH return paths, which it was not. `costAreaDca` is
    // REPORTED rather than left for a client to recompute, so a NaN here
    // reaches `z.number()` — zod accepts NaN — and then serialises to JSON
    // `null`, failing a non-nullable field on a path no test covers. The
    // refusal path already guarded it; the success path returned it raw.
    //
    // `areaDca` needs no equivalent: the success path is reached only when
    // `divisible` holds, which already requires it to be finite. The cost
    // denominator has no such gate, because the cost rate is computed
    // independently of whether the value figures resolve (#1512).
    const reportedCostAreaDca = Number.isFinite(costAreaDca) ? costAreaDca : 0;

    // The COST rate stands on its own (#1512). It needs the occupied area and
    // the cost, and nothing else — not a market price, not a yield estimate.
    // Coupling it to `standingCropValue` was the defect: a farm that knows
    // exactly what it is spending got no cost-per-decare because nobody could
    // say what the crop was worth, which is a different question.
    // The currency is a SECOND gate on the cost rate, and it is not optional.
    // `attributableCost` is a magnitude sum taken across whatever currencies the
    // rows carried, so dividing it by an area yields a number with no unit
    // unless the mix resolves to one. Printing that beside a currency symbol is
    // the 24 000 лв-shown-as-€24 000 class of error, arrived at by arithmetic
    // instead of by a missing field.
    const realCostCurrencies = [...new Set(input.costCurrencies)].filter(
        (c) => c !== UNKNOWN_RENT_CURRENCY,
    );
    const hasUnknownCostCurrency = input.costCurrencies.includes(UNKNOWN_RENT_CURRENCY);

    // Order encodes severity. A mix is reported as a MIX even when the unknown
    // sentinel is among the mixture: "these are several currencies" is the more
    // actionable sentence than "one of them is unrecorded", and the farmer's fix
    // differs — reconcile the entries, versus record the lease.
    const costCurrencyRefusal: PerAreaCostRefusalCode | null =
        realCostCurrencies.length > 1 ||
        (realCostCurrencies.length >= 1 && hasUnknownCostCurrency)
            ? 'COST_CURRENCY_MIXED'
            : hasUnknownCostCurrency
              ? 'COST_CURRENCY_UNRECORDED'
              : null;

    // EMPTY resolves to null-meaning-tenant-currency, NOT to a refusal. See
    // `costCurrencies`: net worth makes the same assumption in the same
    // situation, and refusing would withhold the rate on precisely the farms
    // #1512 was filed about.
    const costCurrency = realCostCurrencies.length === 1 ? realCostCurrencies[0] : null;

    const costRefusalCode: PerAreaCostRefusalCode | null = !costDivisible
        ? 'NO_OCCUPIED_AREA'
        : costCurrencyRefusal;

    const attributableCostPerDca =
        costRefusalCode == null ? round2(input.attributableCost / costAreaDca) : null;

    const refusalCode: PerAreaRefusalCode | null = !divisible
        ? 'NO_STANDING_CROP_AREA'
        : input.standingCropValue == null
          ? 'NO_STANDING_CROP_VALUE'
          : null;

    if (refusalCode != null) {
        return {
            areaDca: Number.isFinite(areaDca) ? areaDca : 0,
            costAreaDca: reportedCostAreaDca,
            // Both VALUE figures stay refused — the margin included, because
            // it subtracts a value that does not exist. `refusalCode` keeps
            // describing exactly that, which is what the calculator's
            // per-commodity list keys on.
            standingValuePerDca: null,
            attributableCostPerDca,
            // Carried on the refusal path too: the whole point of #1512 is that
            // the cost rate survives a value refusal, so the fields that make it
            // legible have to survive with it.
            costCurrency: attributableCostPerDca == null ? null : costCurrency,
            costRefusalCode,
            marginPerDca: null,
            uncertainty: UNCERTAINTY.REFUSED,
            refusalCode,
        };
    }

    const value = input.standingCropValue as number;
    return {
        areaDca,
        costAreaDca: reportedCostAreaDca,
        standingValuePerDca: round2(value / areaDca),
        attributableCostPerDca,
        costCurrency: attributableCostPerDca == null ? null : costCurrency,
        costRefusalCode,
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
