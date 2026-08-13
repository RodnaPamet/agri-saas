/**
 * `CommodityMeta.feed` must agree with what the pull job actually fetches.
 *
 * The field drives the Prices tab's operator hint — the text an admin reads
 * when a chart is empty. A wrong value there is worse than no hint: the
 * previous hard-coded version named `EC_AGRIFOOD_BASE_URL` and
 * `ALPHA_VANTAGE_API_KEY` for every commodity including urea, which neither
 * of them can populate, so an operator who followed it would configure two
 * irrelevant things and still see nothing.
 *
 * Declaring the mapping in the vocabulary is what makes the hint truthful; it
 * is ALSO a second copy of knowledge that lives in the clients. These
 * assertions are the seam between the two, deriving one side from the real
 * exported constants rather than restating them, so adding a Pink Sheet
 * fertiliser (or dropping one) fails here instead of quietly making the hint
 * lie again.
 */
import {
    INPUT_COMMODITIES,
    commodityMeta,
    type AnyCommodity,
    type CommodityFeed,
} from '@/lib/market/commodity-vocabulary';
import { PINK_SHEET_FERTILIZERS } from '@/lib/market/world-bank-client';
import { TREND_CROPS } from '@/app-layer/schemas/trends.schemas';

/** Every slug the vocabulary classifies, both sides of the ledger. */
const ALL: readonly AnyCommodity[] = [
    'wheat',
    'maize',
    'barley',
    'sunflower',
    'rapeseed',
    'oats',
    'rye',
    'soybean',
    'peas',
    'lentils',
    ...INPUT_COMMODITIES,
];

function slugsWithFeed(feed: CommodityFeed): string[] {
    return ALL.filter((c) => commodityMeta(c)?.feed === feed).sort();
}

describe('CommodityMeta.feed agrees with the feeds that exist', () => {
    it('marks exactly the Pink Sheet fertilisers as world-bank', () => {
        // Derived from the client's own allowlist, not restated — adding a
        // fertiliser column to PINK_SHEET_FERTILIZERS without classifying it
        // here would otherwise leave urea's neighbour telling operators there
        // is no feed for a price we are actively pulling.
        expect(slugsWithFeed('world-bank')).toEqual([...PINK_SHEET_FERTILIZERS].sort());
    });

    it('marks exactly the trend crops as ec-agrifood', () => {
        expect(slugsWithFeed('ec-agrifood')).toEqual([...TREND_CROPS].sort());
    });

    it('marks diesel, and only diesel, as oil-bulletin', () => {
        expect(slugsWithFeed('oil-bulletin')).toEqual(['diesel']);
    });

    it('leaves the hand-typed inputs as none', () => {
        // MAP and ammonium nitrate have no free feed anywhere. The empty state
        // for them is a fact about the world, not a misconfiguration, and the
        // hint has to be able to say so.
        const none = slugsWithFeed('none');
        expect(none).toContain('map');
        expect(none).toContain('ammonium-nitrate');
    });

    it('classifies every slug — no commodity is left unmapped', () => {
        for (const c of ALL) {
            expect(commodityMeta(c)?.feed).toBeDefined();
        }
    });

    it('never claims a feed for a crop the EC pull does not fetch', () => {
        // rapeseed IS served by the EC oilseeds endpoint, but the job only
        // maps sunflower out of it (market-prices-pull.ts). Claiming a feed we
        // do not pull would send an operator hunting for a broken job.
        for (const c of ['rapeseed', 'oats', 'rye', 'soybean', 'peas', 'lentils'] as const) {
            expect(commodityMeta(c)?.feed).toBe('none');
        }
    });
});
