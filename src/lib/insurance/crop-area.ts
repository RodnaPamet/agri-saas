/**
 * Aggregate one crop's area across a location's parcels.
 *
 * Farmers insure a crop, not a parcel: someone with twelve wheat parcels at one
 * location should send ONE request, not twelve. This is the sum behind that
 * chip.
 *
 * Pure, and deliberately so — the component only calls it. A figure a farmer is
 * about to insure on should be testable without rendering anything.
 */
import { haToDca } from '@/lib/agro/rate-calc';
import { productForCrop } from './products';
import type { InsuranceProductKey } from './products';

/** Just the fields the sum needs; the parcels list carries much more. */
export interface CropAreaParcel {
    cropType?: string | null;
    areaHa?: number | null;
}

export interface CropAreaTotal {
    /**
     * Rounded to 2dp on purpose. The chip writes this number into the area
     * FIELD as text, and the area scope is later derived by comparing the
     * field's parsed value against this one. Rounding here means the chip
     * label, the field and that comparison all share one number — otherwise
     * float dust makes a tapped chip read back as a hand edit.
     */
    areaDca: number;
    parcelCount: number;
}

/**
 * Sum the area of every parcel whose crop maps to `productKey`.
 *
 * Normalisation runs through `productForCrop`, so "Winter Wheat", "wheat" and
 * "Пшеница" all count toward the wheat product — which is the whole point, as
 * seed data carries free text. A crop that maps to nothing is excluded rather
 * than guessed at.
 *
 * A null, zero, negative or non-finite `areaHa` is ignored: a parcel with no
 * recorded area cannot contribute to a figure someone is about to be priced
 * on. It is excluded from `parcelCount` too, so the count always describes
 * the parcels actually summed.
 */
export function sumCropArea(
    parcels: readonly CropAreaParcel[],
    productKey: InsuranceProductKey,
): CropAreaTotal {
    let areaHa = 0;
    let parcelCount = 0;

    for (const parcel of parcels) {
        if (productForCrop(parcel.cropType) !== productKey) continue;
        const ha = parcel.areaHa;
        if (typeof ha !== 'number' || !Number.isFinite(ha) || ha <= 0) continue;
        areaHa += ha;
        parcelCount += 1;
    }

    // Sum in hectares and convert ONCE: `haToDca` is an exact ×10, so one
    // conversion at the end carries less float error than one per parcel.
    return { areaDca: Math.round(haToDca(areaHa) * 100) / 100, parcelCount };
}
