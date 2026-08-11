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
    COMMODITY_ALIASES,
    INPUT_COMMODITIES,
    commoditiesInCategory,
    commodityMeta,
    isCanonicalCommodity,
    isInputCommodity,
    normalizeAnyCommodity,
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

// ── Inputs the farm buys ─────────────────────────────────────────────

describe('input commodities', () => {
    it('resolves every input slug through the any-commodity resolver', () => {
        for (const slug of INPUT_COMMODITIES) {
            expect(normalizeAnyCommodity(slug)).toBe(slug);
        }
    });

    // Break: a hyphenated slug that the fold strips. `ammonium-nitrate`
    // folds to `ammoniumnitrate`, which is NOT in the canonical/input SET,
    // so it reaches the resolver only via an explicit alias entry.
    it('resolves the hyphenated slug the fold would otherwise miss', () => {
        expect(normalizeAnyCommodity('ammonium-nitrate')).toBe('ammonium-nitrate');
        expect(normalizeAnyCommodity('ammoniumnitrate')).toBe('ammonium-nitrate');
        expect(normalizeAnyCommodity('Ammonium Nitrate')).toBe('ammonium-nitrate');
    });

    // Break: THE failure this module exists to prevent. A feed spelling that
    // does not resolve silently splits one series into two rather than
    // erroring, and the commodity looks under-represented forever.
    it.each([
        ['нафта', 'diesel'],
        ['дизел', 'diesel'],
        ['дизелово гориво', 'diesel'],
        ['gas oil', 'diesel'],
        ['gasoil', 'diesel'],
        ['уреа', 'urea'],
        ['карбамид', 'urea'],
        ['дап', 'dap'],
        ['диамониев фосфат', 'dap'],
        ['diammonium phosphate', 'dap'],
        ['мап', 'map'],
        ['моноамониев фосфат', 'map'],
        ['monoammonium phosphate', 'map'],
        ['амониев нитрат', 'ammonium-nitrate'],
        ['амселитра', 'ammonium-nitrate'],
        ['AN', 'ammonium-nitrate'],
    ])('folds %p to %p', (spelling, slug) => {
        expect(normalizeAnyCommodity(spelling)).toBe(slug);
    });

    it('classifies every slug in both lists — no unclassified commodity', () => {
        for (const slug of CANONICAL_COMMODITIES) {
            expect(commodityMeta(slug)).toEqual({ kind: 'output', category: 'grain' });
        }
        expect(commodityMeta('diesel')).toEqual({ kind: 'input', category: 'fuel' });
        for (const slug of ['urea', 'dap', 'map', 'ammonium-nitrate']) {
            expect(commodityMeta(slug)).toEqual({ kind: 'input', category: 'fertilizer' });
        }
        expect(commodityMeta('not-a-commodity')).toBeNull();
    });

    it('partitions the whole vocabulary across the three categories', () => {
        const all = [...CANONICAL_COMMODITIES, ...INPUT_COMMODITIES];
        const covered = [
            ...commoditiesInCategory('grain'),
            ...commoditiesInCategory('fuel'),
            ...commoditiesInCategory('fertilizer'),
        ];
        // Every slug appears exactly once — no gaps (a commodity that no
        // category offers is invisible in the picker) and no duplicates.
        expect([...covered].sort()).toEqual([...all].sort());
        expect(new Set(covered).size).toBe(covered.length);
    });

    it('separates the two lists cleanly', () => {
        for (const slug of INPUT_COMMODITIES) {
            expect(isInputCommodity(slug)).toBe(true);
            expect(isCanonicalCommodity(slug)).toBe(false);
        }
        for (const slug of CANONICAL_COMMODITIES) {
            expect(isCanonicalCommodity(slug)).toBe(true);
            expect(isInputCommodity(slug)).toBe(false);
        }
    });
});

// ── The regression that matters most ─────────────────────────────────

describe('the exchange vocabulary is untouched by input commodities', () => {
    // Break: THE highest-consequence regression in this change — a farmer
    // able to list a tonne of diesel for sale on a grain exchange.
    it('still names exactly the ten crops, in order', () => {
        expect(CANONICAL_COMMODITIES).toEqual([
            'wheat', 'maize', 'barley', 'sunflower', 'rapeseed',
            'oats', 'rye', 'soybean', 'peas', 'lentils',
        ]);
    });

    // `normalizeCommodity` IS the exchange write schema's resolver
    // (exchange.schemas.ts CommodityField) and the offer modal's list is
    // CANONICAL_COMMODITIES. So refusing inputs here is what makes the
    // exchange safe — at every call site, without any of them changing.
    it('refuses every input slug', () => {
        for (const slug of INPUT_COMMODITIES) {
            expect(normalizeCommodity(slug)).toBeNull();
        }
    });

    it('refuses every input ALIAS, in either language', () => {
        for (const [alias, slug] of Object.entries(COMMODITY_ALIASES)) {
            if (!isInputCommodity(slug)) continue;
            expect(normalizeCommodity(alias)).toBeNull();
        }
    });

    it('still accepts every crop spelling it accepted before', () => {
        for (const [alias, slug] of Object.entries(COMMODITY_ALIASES)) {
            if (isInputCommodity(slug)) continue;
            expect(normalizeCommodity(alias)).toBe(slug);
        }
    });
});

describe('prototype pollution', () => {
    // Break: a plain-object alias table inherits Object.prototype, so
    // `COMMODITY_ALIASES['constructor']` returned a FUNCTION and the
    // `?? null` fallback never fired — handing a function back typed as a
    // commodity slug, from any free-text field up to 120 chars.
    it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
        'returns null for the Object.prototype member %p',
        (member) => {
            expect(normalizeAnyCommodity(member)).toBeNull();
            expect(normalizeCommodity(member)).toBeNull();
        },
    );
});
