/**
 * The crops a farmer can PICK, in one place.
 *
 * Two surfaces offer this list — the journal's «Култура» filter and the cost
 * entry form's `CROP` allocation basis (#1530) — and a third copy is how
 * `cost-categories-agree` and `allocation-bases-agree` both came to exist: a
 * list that must be edited in N places silently becomes N-1. This module is
 * the N=1 version, imported by both rather than restated in either.
 *
 * ## Why these values and not canonical slugs
 *
 * Every entry here is the spelling `Parcel.cropType` STORES — capitalised,
 * free text, written by the crop picker. Measured: `isCanonicalCommodity` is
 * false for all six, while `normalizeCommodity` resolves all six, and `Canola`
 * resolves to `rapeseed` rather than to itself.
 *
 * So the two vocabularies genuinely differ and both are needed:
 *
 *   · the journal filter compares RAW against `Parcel.cropType`, because that
 *     is what the column holds (#1569);
 *   · a `CROP` cost stores the CANONICAL slug, because the figure it feeds is
 *     keyed by commodity and `Wheat` / `wheat` must not be two keys.
 *
 * `cropPickerCommodity` is the forward bridge and `cropPickerValueFor` the
 * reverse one. The reverse is only well-defined while the forward map is
 * INJECTIVE — the moment two picker values resolve to one commodity,
 * `rapeseed → ?` has no single right answer — so it is derived by inverting
 * the forward map rather than written out, and
 * `tests/guards/crop-picker-resolves.test.ts` asserts the injectivity that
 * makes it meaningful. A hand-written reverse table would keep answering
 * after that stopped being true.
 */
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';
import type { CanonicalCommodity } from '@/lib/market/commodity-vocabulary';

/**
 * The pickable crops, as `Parcel.cropType` spells them.
 *
 * Adding one is a product decision with two consequences, both checked by
 * `tests/guards/crop-picker-resolves.test.ts`: it must resolve through
 * `normalizeCommodity` (or a `CROP` cost naming it is refused at the wire),
 * and it needs a label in both locales.
 */
export const CROP_PICKER_VALUES = [
    'Wheat',
    'Barley',
    'Canola',
    'Maize',
    'Sunflower',
    'Peas',
] as const;

export type CropPickerValue = (typeof CROP_PICKER_VALUES)[number];

const PICKER_SET: ReadonlySet<string> = new Set(CROP_PICKER_VALUES);

/** Narrowing guard — a `cropType` the picker does not offer stays free text. */
export function isCropPickerValue(v: string | null | undefined): v is CropPickerValue {
    return v != null && PICKER_SET.has(v);
}

/**
 * The canonical commodity a picked crop means, or null if the vocabulary does
 * not cover it.
 *
 * Null is reachable in principle — the vocabulary is free to drop a slug — and
 * a caller must handle it rather than assert. The guard asserts it is null for
 * none of the six TODAY, which is a different claim and the one worth pinning.
 */
export function cropPickerCommodity(v: CropPickerValue): CanonicalCommodity | null {
    return normalizeCommodity(v);
}

/**
 * The picker value that means a given canonical commodity, or `''`.
 *
 * Needed because the cost form STORES canonical (`rapeseed`) and its picker is
 * keyed by raw (`Canola`), so editing an existing `CROP` cost has to come back
 * the other way. Returns `''` rather than null so it drops straight into a
 * form field whose empty state is the empty string.
 *
 * `''` is also the right answer for a commodity no picker value covers — a row
 * written by the API with a commodity the web picker does not offer. The field
 * then shows empty and the farmer must choose, which is honest: the
 * alternative is displaying a crop that is not what the row says.
 */
export function cropPickerValueFor(commodity: string | null | undefined): string {
    if (!commodity) return '';
    for (const v of CROP_PICKER_VALUES) {
        if (cropPickerCommodity(v) === commodity) return v;
    }
    return '';
}
