import {
    computeListingsMedianIndex,
    LISTINGS_K_ANON_FLOOR,
    type ListingPriceRow,
} from '@/lib/market/listings-index';

/**
 * NOTE the default commodity: `'Wheat'`, Title-Case.
 *
 * It used to be `'wheat'`, and that one character is why CI never noticed the
 * index was dead. `CreateOfferModal` seeds Title-Case, `TrendCommodity` is
 * lowercase, and `getPriceTrends` matches exactly — so in production
 * `findListingsSeries` returned null forever while this test happily proved
 * the maths. The fixture now uses the casing production actually writes, so a
 * regression in normalisation fails here instead of silently emptying a tile.
 */
const row = (tenant: string, price: number, commodity = 'Wheat', currency = 'BGN'): ListingPriceRow => ({
    commodity,
    pricePerTonne: price,
    priceCurrency: currency,
    sellerTenantId: tenant,
});

describe('computeListingsMedianIndex (k-anonymity)', () => {
    it('has a k-anonymity floor of 3 distinct tenants', () => {
        expect(LISTINGS_K_ANON_FLOOR).toBe(3);
    });

    it('SUPPRESSES a group backed by only 2 distinct tenants', () => {
        const out = computeListingsMedianIndex([
            row('t1', 100),
            row('t2', 200),
            row('t2', 300), // same tenant → still only 2 distinct
        ]);
        expect(out).toHaveLength(0);
    });

    it('EMITS a group backed by 3 distinct tenants with median + count', () => {
        const out = computeListingsMedianIndex([
            row('t1', 100),
            row('t2', 200),
            row('t3', 300),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({
            // Title-Case in, canonical slug out — this is the join key the
            // trends read matches on.
            commodity: 'wheat',
            currency: 'BGN',
            unit: 'BGN/t',
            median: 200, // middle of [100,200,300]
            count: 3, // distinct tenants
        });
    });

    it('averages the two middle values for an even count', () => {
        const out = computeListingsMedianIndex([
            row('t1', 100),
            row('t2', 200),
            row('t3', 300),
            row('t4', 500),
        ]);
        expect(out[0].median).toBe(250); // (200+300)/2
        expect(out[0].count).toBe(4);
    });

    it('groups independently by (commodity, currency)', () => {
        const out = computeListingsMedianIndex([
            // wheat/BGN — 3 tenants → emitted
            row('t1', 100),
            row('t2', 200),
            row('t3', 300),
            // maize/BGN — only 2 tenants → suppressed
            row('t1', 400, 'maize'),
            row('t2', 500, 'maize'),
            // wheat/EUR — 3 tenants → emitted (separate currency group)
            row('t1', 90, 'wheat', 'EUR'),
            row('t2', 110, 'wheat', 'EUR'),
            row('t3', 130, 'wheat', 'EUR'),
        ]);
        const keys = out.map((g) => `${g.commodity}/${g.currency}`);
        expect(keys).toEqual(['wheat/BGN', 'wheat/EUR']);
        expect(out.find((g) => g.currency === 'EUR')?.median).toBe(110);
    });

    it('never leaks tenant ids — output carries only median + count', () => {
        const out = computeListingsMedianIndex([row('t1', 100), row('t2', 200), row('t3', 300)]);
        expect(Object.keys(out[0]).sort()).toEqual(['commodity', 'count', 'currency', 'median', 'unit']);
    });
});

describe('computeListingsMedianIndex — one tenant, one vote', () => {
    it('a tenant with 100 listings cannot set the published median', () => {
        // THE defect this suite exists for. The estimator pushed one price per
        // LISTING but counted one entry per TENANT, so a single account could
        // publish any number it liked — and `count` reported the tenant total,
        // actively reassuring the reader that three parties agreed.
        const flood = Array.from({ length: 100 }, () => row('attacker', 9999));
        const out = computeListingsMedianIndex([
            ...flood,
            row('honest-1', 200),
            row('honest-2', 220),
        ]);

        expect(out).toHaveLength(1);
        // Median of the three TENANT medians [9999, 200, 220] → 220.
        expect(out[0].median).toBe(220);
        expect(out[0].count).toBe(3);
        // The old behaviour: median of 102 prices, 100 of them 9999.
        expect(out[0].median).not.toBe(9999);
    });

    it('collapses a tenant to its own median before the cross-tenant median', () => {
        const out = computeListingsMedianIndex([
            row('t1', 100),
            row('t1', 300), // t1's own median is 200
            row('t2', 500),
            row('t3', 900),
        ]);
        // Median across tenant medians [200, 500, 900] → 500.
        expect(out[0].median).toBe(500);
        expect(out[0].count).toBe(3);
    });

    it('still suppresses below the k-anon floor however many listings exist', () => {
        // The privacy floor is unchanged — it counts distinct tenants, and one
        // tenant flooding the board must not manufacture a publishable group.
        const flood = Array.from({ length: 500 }, () => row('solo', 400));
        expect(computeListingsMedianIndex(flood)).toHaveLength(0);
    });
});

describe('computeListingsMedianIndex — commodity normalisation', () => {
    it('groups Title-Case, lowercase and Bulgarian spellings as ONE commodity', () => {
        // Three tenants, three spellings of wheat. Ungrouped these are three
        // one-tenant groups, each suppressed by the k-anon floor — so the
        // commodity disappears from the index entirely.
        const out = computeListingsMedianIndex([
            row('t1', 100, 'Wheat'),
            row('t2', 200, 'wheat'),
            row('t3', 300, 'пшеница'),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].commodity).toBe('wheat');
        expect(out[0].count).toBe(3);
    });

    it('emits the canonical slug the trends read matches on', () => {
        const out = computeListingsMedianIndex([
            row('t1', 100, 'CORN'),
            row('t2', 200, 'Maize'),
            row('t3', 300, 'царевица'),
        ]);
        expect(out[0].commodity).toBe('maize');
    });

    it('skips an unrecognised commodity rather than inventing a group', () => {
        const out = computeListingsMedianIndex([
            row('t1', 100, 'Unobtainium'),
            row('t2', 200, 'Unobtainium'),
            row('t3', 300, 'Unobtainium'),
        ]);
        expect(out).toEqual([]);
    });
});
