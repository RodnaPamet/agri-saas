/**
 * The canonical commodity vocabulary.
 *
 * This module exists because four surfaces named commodities and none agreed —
 * and the consequence was not cosmetic. `getPriceTrends` matches
 * `where: { commodity }` exactly and case-sensitively, `CreateOfferModal`
 * seeds Title-Case, and nothing normalised in between, so the own-listings
 * median was written every Monday and never once read.
 *
 * The tests that matter are the ones proving DIFFERENT SPELLINGS COLLAPSE:
 * a fold that misses one alias silently splits a group below the k-anonymity
 * floor, and the commodity disappears from the index rather than erroring.
 */
import {
    CANONICAL_COMMODITIES,
    isCanonicalCommodity,
    normalizeCommodity,
} from '@/lib/market/commodity-vocabulary';
import { TrendCommodity } from '@/app-layer/schemas/trends.schemas';

describe('normalizeCommodity', () => {
    it('accepts the exact casing production writes', () => {
        // CreateOfferModal's seed list is Title-Case. This is the one that was
        // broken in production for the entire life of the feature.
        expect(normalizeCommodity('Wheat')).toBe('wheat');
        expect(normalizeCommodity('Maize')).toBe('maize');
        expect(normalizeCommodity('Sunflower')).toBe('sunflower');
        expect(normalizeCommodity('Barley')).toBe('barley');
    });

    it('folds case, whitespace and separators', () => {
        expect(normalizeCommodity('WHEAT')).toBe('wheat');
        expect(normalizeCommodity('  wheat  ')).toBe('wheat');
        expect(normalizeCommodity('Sunflower Seed')).toBe('sunflower');
        expect(normalizeCommodity('soft-wheat')).toBe('wheat');
    });

    it('treats Bulgarian names as first-class, not as separate commodities', () => {
        // The product is bilingual and the column has been free text since it
        // shipped. A Bulgarian farmer typing пшеница means what an English one
        // typing Wheat means; grouping them apart is how a real group falls
        // below the k-anon floor and vanishes.
        expect(normalizeCommodity('пшеница')).toBe('wheat');
        expect(normalizeCommodity('Царевица')).toBe('maize');
        expect(normalizeCommodity('слънчоглед')).toBe('sunflower');
        expect(normalizeCommodity('ечемик')).toBe('barley');
    });

    it('maps common trade synonyms', () => {
        expect(normalizeCommodity('corn')).toBe('maize');
        expect(normalizeCommodity('canola')).toBe('rapeseed');
        expect(normalizeCommodity('soya')).toBe('soybean');
    });

    it('returns null for the unknown rather than inventing a commodity', () => {
        // Returning the raw string would recreate free text one row at a time.
        expect(normalizeCommodity('Unobtainium')).toBeNull();
        expect(normalizeCommodity('')).toBeNull();
        expect(normalizeCommodity(null)).toBeNull();
        expect(normalizeCommodity(undefined)).toBeNull();
        expect(normalizeCommodity('   ')).toBeNull();
    });

    it('is idempotent — normalising a canonical slug is a no-op', () => {
        for (const c of CANONICAL_COMMODITIES) {
            expect(normalizeCommodity(c)).toBe(c);
            expect(isCanonicalCommodity(c)).toBe(true);
        }
    });
});

describe('vocabulary alignment', () => {
    it('covers every TrendCommodity, so a price series can always be named', () => {
        // If these drift, a commodity with a live price series becomes
        // un-listable on the exchange — or worse, listable under a spelling the
        // trends read can never match.
        for (const c of TrendCommodity.options) {
            expect(isCanonicalCommodity(c)).toBe(true);
        }
    });

    it('round-trips the Title-Case label the offer modal displays', () => {
        // CreateOfferModal derives its options from CANONICAL_COMMODITIES and
        // Title-Cases them for display, so the label a user sees must fold back
        // to the slug the API stores.
        for (const slug of CANONICAL_COMMODITIES) {
            const label = slug.charAt(0).toUpperCase() + slug.slice(1);
            expect(normalizeCommodity(label)).toBe(slug);
        }
    });
});
