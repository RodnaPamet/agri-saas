import {
    normalizeCommodity,
    type CanonicalCommodity,
} from '@/lib/market/commodity-vocabulary';

/**
 * The insurance product catalogue.
 *
 * NO user-facing strings live here. Keys double as i18n keys, so they stay
 * camelCase with no dots or hyphens; names and blurbs come from `messages/`
 * in step 2.
 */
export interface InsuranceProduct {
    key: InsuranceProductKey;
    kind: 'crop' | 'peril';
    commodity?: CanonicalCommodity;
    /** Integer basis points. 1000 = 10 %. */
    tariffBp: number;
}

export const INSURANCE_PRODUCT_KEYS = [
    'wheat',
    'barley',
    'maize',
    'sunflower',
    'rapeseed',
    'drought',
    'hail',
    'frost',
] as const;

export type InsuranceProductKey = (typeof INSURANCE_PRODUCT_KEYS)[number];

export const INSURANCE_PRODUCTS: readonly InsuranceProduct[] = [
    { key: 'wheat', kind: 'crop', commodity: 'wheat', tariffBp: 1000 },
    { key: 'barley', kind: 'crop', commodity: 'barley', tariffBp: 1000 },
    { key: 'maize', kind: 'crop', commodity: 'maize', tariffBp: 1000 },
    { key: 'sunflower', kind: 'crop', commodity: 'sunflower', tariffBp: 1000 },
    { key: 'rapeseed', kind: 'crop', commodity: 'rapeseed', tariffBp: 1000 },
    { key: 'drought', kind: 'peril', tariffBp: 1000 },
    { key: 'hail', kind: 'peril', tariffBp: 1000 },
    { key: 'frost', kind: 'peril', tariffBp: 1000 },
] as const;

/**
 * Map a parcel's crop to its product, so a wheat parcel opens on wheat.
 *
 * Normalisation is REQUIRED, not defensive: seed data carries free text such
 * as "Winter Wheat" and "Grass", and an exact-match lookup would preselect
 * nothing for most real parcels.
 */
export function productForCrop(
    cropType: string | null | undefined,
): InsuranceProductKey | null {
    if (typeof cropType !== 'string' || cropType.trim() === '') return null;

    // Whole-string first: this is what handles case ("Wheat") and the
    // Bulgarian spellings ("пшеница"), both already in the shared alias table.
    const direct = cropFor(normalizeCommodity(cropType));
    if (direct) return direct;

    // Then TOKEN BY TOKEN, because the shared vocabulary does not carry
    // varietal names. Measured 2026-09-26: normalizeCommodity('Winter Wheat')
    // is null, and 'Winter Wheat' is literally what this repo's seed data puts
    // in a parcel's crop — so a whole-string lookup alone would preselect
    // nothing for the very rows the wizard opens on.
    //
    // Split on non-letters rather than substring-matching: 'ryegrass' must not
    // match 'rye'. A token is normalised through the same shared table, so no
    // spelling knowledge is duplicated here.
    for (const token of cropType.split(/[^\p{L}]+/u)) {
        if (!token) continue;
        const key = cropFor(normalizeCommodity(token));
        if (key) return key;
    }
    return null;
}

function cropFor(commodity: CanonicalCommodity | null): InsuranceProductKey | null {
    if (!commodity) return null;
    const product = INSURANCE_PRODUCTS.find(
        (p) => p.kind === 'crop' && p.commodity === commodity,
    );
    return product ? product.key : null;
}

export function getProduct(key: string): InsuranceProduct | undefined {
    return INSURANCE_PRODUCTS.find((p) => p.key === key);
}
