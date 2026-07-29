/**
 * Unit tests — Exchange write-API Zod schemas.
 *
 * The Exchange tables are GLOBAL (no RLS), so these schemas are a load-bearing
 * guard: a bad numeric value must be rejected with a clean 400 HERE, never
 * reach Prisma's Decimal column and 500. Covers the validation holes closed in
 * the write-path hardening PR — non-numeric / huge / negative magnitudes, the
 * currency allow-list, and past-expiry rejection.
 */
import {
    CreateListingSchema,
    CreateInquirySchema,
} from '@/app-layer/schemas/exchange.schemas';

const baseListing = {
    side: 'SELL',
    kind: 'CULTURE',
    commodity: 'Wheat',
    quantityTonnes: 10,
    regionCode: 'BG-16',
};

describe('CreateListingSchema — quantityTonnes', () => {
    it('accepts a positive number and a numeric string (coerced to number)', () => {
        const a = CreateListingSchema.parse({ ...baseListing, quantityTonnes: 12.5 });
        expect(a.quantityTonnes).toBe(12.5);
        const b = CreateListingSchema.parse({ ...baseListing, quantityTonnes: '12.500' });
        expect(b.quantityTonnes).toBe(12.5);
        expect(typeof b.quantityTonnes).toBe('number');
    });

    it('rejects a non-numeric string BEFORE it can reach Prisma', () => {
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: 'abc' })).toThrow();
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: '10; DROP' })).toThrow();
    });

    it('rejects zero, negative, and over-cap magnitudes', () => {
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: 0 })).toThrow();
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: -5 })).toThrow();
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: '-5' })).toThrow();
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: 1_000_001 })).toThrow();
    });

    it('rejects more than 3 decimal places in the string form', () => {
        expect(() => CreateListingSchema.parse({ ...baseListing, quantityTonnes: '12.5555' })).toThrow();
    });
});

describe('CreateListingSchema — pricePerTonne', () => {
    it('accepts >= 0, null, and omitted', () => {
        expect(CreateListingSchema.parse({ ...baseListing, pricePerTonne: 0 }).pricePerTonne).toBe(0);
        expect(CreateListingSchema.parse({ ...baseListing, pricePerTonne: '250.75' }).pricePerTonne).toBe(250.75);
        expect(CreateListingSchema.parse({ ...baseListing, pricePerTonne: null }).pricePerTonne).toBeNull();
        expect(CreateListingSchema.parse({ ...baseListing }).pricePerTonne).toBeUndefined();
    });

    it('rejects negative, non-numeric, and over-cap prices', () => {
        expect(() => CreateListingSchema.parse({ ...baseListing, pricePerTonne: -1 })).toThrow();
        expect(() => CreateListingSchema.parse({ ...baseListing, pricePerTonne: 'free' })).toThrow();
        expect(() => CreateListingSchema.parse({ ...baseListing, pricePerTonne: 10_000_001 })).toThrow();
    });
});

describe('CreateListingSchema — priceCurrency is EUR-only', () => {
    it('defaults to EUR when omitted', () => {
        expect(CreateListingSchema.parse({ ...baseListing }).priceCurrency).toBe('EUR');
    });
    it('accepts EUR', () => {
        expect(CreateListingSchema.parse({ ...baseListing, priceCurrency: 'EUR' }).priceCurrency).toBe('EUR');
    });
    // The write-side half of the euro migration. BGN rows were CONVERTED once
    // at the fixed 1.95583; USD floats and cannot be. Either way, a NEW listing
    // in a second currency would put two incomparable prices side by side on
    // the same map — which is the defect the migration closed.
    it('rejects every other currency, including the two the column still holds', () => {
        for (const cur of ['BGN', 'USD', 'GBP', 'btc', 'eur']) {
            expect(() => CreateListingSchema.parse({ ...baseListing, priceCurrency: cur })).toThrow();
        }
    });
});

describe('CreateListingSchema — expiresAt', () => {
    it('accepts a future ISO datetime, null, and omitted', () => {
        const future = new Date(Date.now() + 86_400_000).toISOString();
        expect(CreateListingSchema.parse({ ...baseListing, expiresAt: future }).expiresAt).toBe(future);
        expect(CreateListingSchema.parse({ ...baseListing, expiresAt: null }).expiresAt).toBeNull();
        expect(CreateListingSchema.parse({ ...baseListing }).expiresAt).toBeUndefined();
    });

    it('rejects a past expiry', () => {
        const past = new Date(Date.now() - 86_400_000).toISOString();
        expect(() => CreateListingSchema.parse({ ...baseListing, expiresAt: past })).toThrow();
    });
});

describe('CreateInquirySchema — quantityTonnes', () => {
    const baseInquiry = { listingId: 'lst-1', message: 'interested' };

    it('accepts a positive value, null, and omitted', () => {
        expect(CreateInquirySchema.parse({ ...baseInquiry, quantityTonnes: 5 }).quantityTonnes).toBe(5);
        expect(CreateInquirySchema.parse({ ...baseInquiry, quantityTonnes: null }).quantityTonnes).toBeNull();
        expect(CreateInquirySchema.parse({ ...baseInquiry }).quantityTonnes).toBeUndefined();
    });

    it('rejects non-numeric / negative / over-cap quantities', () => {
        expect(() => CreateInquirySchema.parse({ ...baseInquiry, quantityTonnes: 'lots' })).toThrow();
        expect(() => CreateInquirySchema.parse({ ...baseInquiry, quantityTonnes: -1 })).toThrow();
        expect(() => CreateInquirySchema.parse({ ...baseInquiry, quantityTonnes: 5_000_000 })).toThrow();
    });
});
