/**
 * One margin scale per currency, and nothing quietly dropped.
 *
 * ── Why this is not the cover bar's problem ─────────────────────────
 *
 * Cover is a RATIO — `market / breakEven`, both sides in the same
 * currency by construction — so it is dimensionless and every crop shares
 * one 0-100 scale no matter what it is priced in. Margin per decare is
 * MONEY. A EUR bar and a BGN bar on one axis would be a blend, which this
 * product refuses everywhere else: `foldFarmTotals` buckets by currency
 * and emits one total per bucket, because there is no FX table in the
 * repo and inventing one at the view layer would be the worst place to
 * put it.
 *
 * So the grouping here is not a new rule. It is the farm total's rule,
 * applied to a second figure — including its second half, which is that
 * a row excluded from a bucket is NAMED rather than omitted.
 */
import { foldMarginScales } from '@/lib/grain/margin-scale';
import { UNCERTAINTY } from '@/lib/grain/uncertainty';

const row = (over: Partial<Parameters<typeof foldMarginScales>[0][number]> = {}) => ({
    commodity: 'wheat',
    marginPerDca: 80 as number | null,
    refusalCode: null,
    uncertainty: UNCERTAINTY.EXACT,
    priceCurrency: 'EUR' as string | null,
    ...over,
});

describe('foldMarginScales', () => {
    it('puts each currency on its own scale', () => {
        const { groups } = foldMarginScales([
            row({ commodity: 'wheat', marginPerDca: 80, priceCurrency: 'EUR' }),
            row({ commodity: 'barley', marginPerDca: 900, priceCurrency: 'BGN' }),
            row({ commodity: 'maize', marginPerDca: 40, priceCurrency: 'EUR' }),
        ]);

        expect(groups.map((g) => g.currency).sort()).toEqual(['BGN', 'EUR']);
        const eur = groups.find((g) => g.currency === 'EUR');
        const bgn = groups.find((g) => g.currency === 'BGN');
        expect(eur?.items).toHaveLength(2);
        expect(bgn?.items).toHaveLength(1);
    });

    it('never lets one currency set another currency scale', () => {
        // The whole point. 900 BGN must not stretch the EUR axis, or the
        // EUR crops render as slivers of a number they have no relation to.
        const { groups } = foldMarginScales([
            row({ commodity: 'wheat', marginPerDca: 80, priceCurrency: 'EUR' }),
            row({ commodity: 'barley', marginPerDca: 900, priceCurrency: 'BGN' }),
        ]);
        expect(groups.find((g) => g.currency === 'EUR')?.maxAbs).toBe(80);
        expect(groups.find((g) => g.currency === 'BGN')?.maxAbs).toBe(900);
    });

    it('sizes the scale by the largest MAGNITUDE, so a loss is not off-axis', () => {
        // A −500 with a +80 needs a 500 axis, not an 80 one, or the loss
        // runs past the end of its own track.
        const { groups } = foldMarginScales([
            row({ commodity: 'wheat', marginPerDca: 80 }),
            row({ commodity: 'barley', marginPerDca: -500 }),
        ]);
        expect(groups[0].maxAbs).toBe(500);
    });

    it('orders crops best-margin first, with the refused ones last', () => {
        const { groups } = foldMarginScales([
            row({ commodity: 'a', marginPerDca: null, refusalCode: 'NO_STANDING_CROP_AREA' }),
            row({ commodity: 'b', marginPerDca: -20 }),
            row({ commodity: 'c', marginPerDca: 120 }),
        ]);
        expect(groups[0].items.map((i) => i.commodity)).toEqual(['c', 'b', 'a']);
    });

    describe('a bar is only drawn when it can mean something', () => {
        it('is not comparable with a single drawable crop', () => {
            // One bar always fills its own scale, because it IS the scale.
            // That is a picture that cannot be wrong and cannot inform.
            const { groups } = foldMarginScales([row({ marginPerDca: 80 })]);
            expect(groups[0].comparable).toBe(false);
        });

        it('is comparable with two', () => {
            const { groups } = foldMarginScales([
                row({ commodity: 'wheat', marginPerDca: 80 }),
                row({ commodity: 'barley', marginPerDca: 40 }),
            ]);
            expect(groups[0].comparable).toBe(true);
        });

        it('is not comparable when every margin is zero', () => {
            // maxAbs 0 would divide the fill by nothing.
            const { groups } = foldMarginScales([
                row({ commodity: 'wheat', marginPerDca: 0 }),
                row({ commodity: 'barley', marginPerDca: 0 }),
            ]);
            expect(groups[0].comparable).toBe(false);
            expect(groups[0].maxAbs).toBe(0);
        });

        it('does not count refused crops toward being comparable', () => {
            const { groups } = foldMarginScales([
                row({ commodity: 'wheat', marginPerDca: 80 }),
                row({ commodity: 'barley', marginPerDca: null, refusalCode: 'NO_STANDING_CROP_VALUE' }),
            ]);
            expect(groups[0].comparable).toBe(false);
            expect(groups[0].items).toHaveLength(2); // both still listed
        });
    });

    describe('nothing is silently dropped', () => {
        it('names crops that have no currency at all, off to one side', () => {
            // No price ⇒ no currency ⇒ no scale it could belong to. The
            // farm total names these rather than omitting them, and a
            // comparison that quietly shrinks describes a smaller farm
            // than the one being read about.
            const { groups, unscaled } = foldMarginScales([
                row({ commodity: 'wheat', marginPerDca: 80 }),
                row({ commodity: 'maize', marginPerDca: null, priceCurrency: null }),
            ]);
            expect(unscaled).toEqual(['maize']);
            expect(groups).toHaveLength(1);
            expect(groups[0].items.map((i) => i.commodity)).toEqual(['wheat']);
        });

        it('keeps a refused crop inside its currency group, listed but undrawn', () => {
            const { groups, unscaled } = foldMarginScales([
                row({ commodity: 'wheat', marginPerDca: 80 }),
                row({ commodity: 'barley', marginPerDca: null, refusalCode: 'NO_STANDING_CROP_AREA' }),
            ]);
            expect(unscaled).toEqual([]);
            expect(groups[0].items.map((i) => i.commodity)).toEqual(['wheat', 'barley']);
        });

        it('survives a degenerate margin without producing a scale from it', () => {
            for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
                const { groups } = foldMarginScales([row({ marginPerDca: bad })]);
                expect(Number.isFinite(groups[0].maxAbs)).toBe(true);
            }
        });
    });

    it('returns nothing at all for no rows', () => {
        expect(foldMarginScales([])).toEqual({ groups: [], unscaled: [] });
    });
});
