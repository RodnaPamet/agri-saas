import { CANONICAL_COMMODITIES } from '@/lib/market/commodity-vocabulary';
import {
    INSURANCE_PRODUCTS,
    INSURANCE_PRODUCT_KEYS,
    getProduct,
    productForCrop,
} from '@/lib/insurance/products';

describe('the product catalogue', () => {
    it('has unique keys', () => {
        const keys = INSURANCE_PRODUCTS.map((p) => p.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('keys are i18n-safe: camelCase, no dots or hyphens', () => {
        // Keys double as i18n keys; a dot would nest the message and a hyphen
        // would break the lookup, both only at render time.
        for (const key of INSURANCE_PRODUCT_KEYS) {
            expect(key).toMatch(/^[a-z][a-zA-Z0-9]*$/);
        }
    });

    it('the exported tuple and the catalogue agree', () => {
        expect([...INSURANCE_PRODUCT_KEYS].sort()).toEqual(
            INSURANCE_PRODUCTS.map((p) => p.key).sort(),
        );
    });

    it('every crop product names a canonical commodity', () => {
        for (const p of INSURANCE_PRODUCTS.filter((x) => x.kind === 'crop')) {
            expect(p.commodity).toBeDefined();
            expect(CANONICAL_COMMODITIES).toContain(p.commodity);
        }
    });

    it('peril products carry no commodity', () => {
        for (const p of INSURANCE_PRODUCTS.filter((x) => x.kind === 'peril')) {
            expect(p.commodity).toBeUndefined();
        }
    });

    it('every tariff is 1000 basis points (10 %)', () => {
        for (const p of INSURANCE_PRODUCTS) expect(p.tariffBp).toBe(1000);
    });

    it('contains both kinds, and enough of each to be worth a selector', () => {
        expect(INSURANCE_PRODUCTS.filter((p) => p.kind === 'crop').length).toBeGreaterThanOrEqual(5);
        expect(INSURANCE_PRODUCTS.filter((p) => p.kind === 'peril').length).toBeGreaterThanOrEqual(3);
    });
});

describe('productForCrop — normalisation is required, not defensive', () => {
    it('maps free-text seed data to a product', () => {
        // 'Winter Wheat' is literally what this repo's seed data puts in a
        // parcel's crop, and normalizeCommodity alone returns null for it.
        expect(productForCrop('Winter Wheat')).toBe('wheat');
        expect(productForCrop('wheat')).toBe('wheat');
        expect(productForCrop('Wheat')).toBe('wheat');
    });

    it('reaches the Bulgarian spellings through the shared alias table', () => {
        expect(productForCrop('пшеница')).toBe('wheat');
    });

    it('matches whole tokens, never substrings', () => {
        // 'ryegrass' is a grass, not rye. Substring matching would insure it
        // as a cereal.
        expect(productForCrop('ryegrass')).toBeNull();
    });

    it('returns null for a crop with no product', () => {
        expect(productForCrop('Grass')).toBeNull();
    });

    it.each([null, undefined, ''])('returns null for %p', (input) => {
        expect(productForCrop(input)).toBeNull();
    });

    it('never returns a peril key', () => {
        for (const raw of ['Winter Wheat', 'maize', 'Grass', null]) {
            const key = productForCrop(raw);
            if (key) expect(getProduct(key)?.kind).toBe('crop');
        }
    });
});

describe('getProduct', () => {
    it('finds a known key and refuses an unknown one', () => {
        expect(getProduct('wheat')?.kind).toBe('crop');
        expect(getProduct('hail')?.kind).toBe('peril');
        expect(getProduct('nope')).toBeUndefined();
    });
});
