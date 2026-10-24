/**
 * How much of a product a treatment actually applied (#2284).
 *
 * ## Why this is its own module
 *
 * The number it returns is written in two places that must agree: the
 * `CONSUMPTION` stock transaction, and the `quantities` on the
 * `INPUT_APPLICATION` journal entry that the Дневник shows. It lived inline in
 * `recordInputApplication` while there was one caller. There are now two — the
 * #2172 correction route has to recompute it when a dose is corrected, or the
 * journal keeps showing the quantity of the dose that was replaced — and a
 * second copy of this arithmetic is a second answer to a regulated question.
 *
 * ## The area is the TREATED area, not the parcel's
 *
 * `treatedAreaHa ?? parcelAreaHa`, and that coalesce is the whole of #2284. A
 * `NULL` treated area means THE WHOLE PARCEL, which is why the fallback is the
 * parcel and not zero.
 *
 * This was the last area consumer in the product not to coalesce. Both of the
 * others already did:
 *
 *   - `JournalRepository.ts`: `COALESCE(SUM(COALESCE(op."treatedAreaHa", p."areaHa")), 0)`
 *   - `farm-record-diary.ts`:  `toDka(l.treatedAreaHa ?? l.areaHa)`
 *
 * so a 2 ha treatment of a 10 ha block PRINTED 2 ha in the register and
 * recorded ten hectares' worth of product on the journal entry.
 *
 * It is reachable in PRODUCTION and has been since 20 October: the iPhone app
 * sends `parcels[].treatedAreaHa` for every parcel a farmer marks as partly
 * treated (agrent-ios #375, on every TestFlight build since). #2284 first
 * claimed no client sent it — that was grepped in this repository only, and the
 * client that sends it lives in the other one. Any treatment recorded from the
 * phone with a partial area since that date has a whole-parcel quantity on its
 * journal entry.
 *
 * ## The three branches, and the legacy fallback
 *
 * A RATE dose (L/ha) over an area yields the rate's NUMERATOR unit, then
 * converts into the product's stock unit (L/ha × ha = L; deducting into an mL
 * lot scales ×1000). A flat dose converts dose-unit → product-unit when both
 * are known. Anything else falls back to the legacy "assume the units match"
 * multiply — a unit outside the conversion catalogue, or dimensions that cannot
 * reconcile (a volume rate into a weight lot: no density) — so unregistered
 * units keep working exactly as they did. The `isRateUnit` / `canConvert`
 * guards are what stop the conversion helpers throwing from in here.
 */

import { applyRate, convert, canConvert, isRateUnit } from '@/lib/units/unit-conversion';

/** Only the two fields of a `Unit` row this needs. */
export interface AppliedQuantityUnit {
    measure?: string | null;
    key?: string | null;
}

export interface AppliedQuantityInput {
    /** The dose as recorded on the line. */
    doseValue: number;
    /** The dose's unit, `undefined` when the row was not found. */
    doseUnit?: AppliedQuantityUnit | undefined;
    /** The product's stock unit, `undefined` when the row was not found. */
    productUnit?: AppliedQuantityUnit | undefined;
    /**
     * Per-line treated area in hectares, or `null` for the whole parcel.
     * See the note above — passing the parcel area here instead would hide the
     * distinction this argument exists to carry.
     */
    treatedAreaHa: number | null;
    /** The parcel's own area in hectares, or `null` when it has none recorded. */
    parcelAreaHa: number | null;
}

/**
 * The area a dose was applied over, in hectares.
 *
 * `0` for a parcel with no recorded area and no treated area — which makes the
 * applied quantity `0` and, downstream, suppresses the deduction entirely. That
 * is deliberate and load-bearing: a fixture without `areaHa` deducted nothing,
 * and a test asserting "the diary does not deduct" passed for the wrong reason
 * until the area was set. See the note in
 * `tests/integration/mark-parcel-records-in-diary.test.ts`.
 */
export function appliedAreaHa(treatedAreaHa: number | null, parcelAreaHa: number | null): number {
    return treatedAreaHa ?? parcelAreaHa ?? 0;
}

/**
 * The quantity a treatment applied, in the PRODUCT's stock unit, rounded to
 * four decimal places.
 */
export function computeAppliedQuantity(input: AppliedQuantityInput): number {
    const areaHa = appliedAreaHa(input.treatedAreaHa, input.parcelAreaHa);
    const dose = input.doseValue;
    const { doseUnit, productUnit } = input;

    let raw: number;
    if (doseUnit?.measure === 'RATE' && doseUnit.key && isRateUnit(doseUnit.key)) {
        const applied = applyRate(dose, doseUnit.key, areaHa, 'ha');
        raw =
            productUnit?.key && canConvert(applied.unitKey, productUnit.key)
                ? convert(applied.value, applied.unitKey, productUnit.key)
                : applied.value;
    } else if (doseUnit?.key && productUnit?.key && canConvert(doseUnit.key, productUnit.key)) {
        raw = convert(dose, doseUnit.key, productUnit.key);
    } else {
        raw = doseUnit?.measure === 'RATE' ? dose * areaHa : dose;
    }
    return Math.round(raw * 1e4) / 1e4;
}
