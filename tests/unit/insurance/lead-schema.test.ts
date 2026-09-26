import { CreateInsuranceLeadSchema } from '@/app-layer/schemas/insurance.schemas';

/**
 * The request contract, at the boundary.
 *
 * The load-bearing property is the ABSENCE of a price field: the server
 * recomputes the premium, so a client that names its own must be ignored
 * rather than trusted. `.strip()` does that, and this file proves it — a test
 * asserting only "a valid body parses" would pass against a schema that
 * happily forwarded a client-supplied premium.
 */
describe('CreateInsuranceLeadSchema', () => {
    const quote = {
        productKey: 'wheat' as const,
        areaDca: 1000,
        sumInsuredCents: 10_000_000,
        instalments: 3 as const,
    };

    it('accepts a message-only body exactly as before', () => {
        // An installed PWA can run yesterday's bundle for days, and the native
        // clients post here too. This must never stop working.
        const r = CreateInsuranceLeadSchema.safeParse({
            parcelId: 'p1',
            message: 'Please quote this parcel',
        });
        expect(r.success).toBe(true);
    });

    it('accepts a quote-only body', () => {
        const r = CreateInsuranceLeadSchema.safeParse({ parcelId: 'p1', quote });
        expect(r.success).toBe(true);
    });

    it('REFUSES a body with neither a message nor a quote', () => {
        expect(CreateInsuranceLeadSchema.safeParse({ parcelId: 'p1' }).success).toBe(false);
        expect(
            CreateInsuranceLeadSchema.safeParse({ parcelId: 'p1', message: '   ' }).success,
        ).toBe(false);
    });

    it('STRIPS a client-supplied premium and every other price field', () => {
        const r = CreateInsuranceLeadSchema.safeParse({
            parcelId: 'p1',
            quote: {
                ...quote,
                premiumCents: 1,
                tariffBp: 1,
                instalmentsCents: [1],
                engineVersion: 99,
            },
        });
        expect(r.success).toBe(true);
        if (!r.success) return;
        const parsed = r.data.quote as Record<string, unknown>;
        expect(parsed).toEqual({
            productKey: 'wheat',
            areaDca: 1000,
            sumInsuredCents: 10_000_000,
            instalments: 3,
        });
        expect(parsed.premiumCents).toBeUndefined();
        expect(parsed.tariffBp).toBeUndefined();
    });

    it.each([
        ['an unknown product', { ...quote, productKey: 'olives' }],
        ['a zero area', { ...quote, areaDca: 0 }],
        ['a negative sum insured', { ...quote, sumInsuredCents: -1 }],
        ['a fractional sum insured', { ...quote, sumInsuredCents: 1.5 }],
        ['five instalments', { ...quote, instalments: 5 }],
        ['an over-cap area', { ...quote, areaDca: 2_000_001 }],
    ])('refuses %s', (_label, bad) => {
        expect(
            CreateInsuranceLeadSchema.safeParse({ parcelId: 'p1', quote: bad }).success,
        ).toBe(false);
    });
});
