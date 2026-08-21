/**
 * `commodityLabel` — the slug→name resolution the Exchange never had.
 *
 * Since #484 the stored `commodity` is the canonical lowercase slug, and
 * `ExchangeClient` rendered it verbatim — so a Bulgarian operator read
 * `wheat` on a listing. The labels already existed under
 * `trends.commodities.*` in both locales; nothing outside the trends pages
 * consumed them.
 *
 * The fallback is the part worth testing hardest. `commodity` is a plain
 * string column, so a row can hold a value in no catalogue, and next-intl's
 * default behaviour for a missing key is to RENDER THE KEY PATH rather than
 * throw — which is exactly how `ag.offers.ask.consent` stayed invisible for
 * weeks (#662). A fallback that produced `trends.commodities.foo` would be
 * strictly worse than the `foo` the old code showed.
 */

import { commodityLabel } from '@/lib/market/commodity-label';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';
import { CANONICAL_COMMODITIES, INPUT_COMMODITIES } from '@/lib/market/commodity-vocabulary';

type Dict = Record<string, string>;

/** A translator with `has`, the shape next-intl actually provides. */
function translator(dict: Dict) {
    const t = ((key: string) => {
        if (!(key in dict)) throw new Error(`missing: ${key}`);
        return dict[key];
    }) as ((key: string) => string) & { has: (key: string) => boolean };
    t.has = (key: string) => key in dict;
    return t;
}

/**
 * A translator WITHOUT `has`, returning the joined key path on a miss —
 * next-intl's documented default. Both shapes must reach the fallback.
 */
function pathReturningTranslator(dict: Dict) {
    return (key: string) => dict[key] ?? `trends.commodities.${key}`;
}

const EN = en.trends.commodities as unknown as Dict;
const BG = bg.trends.commodities as unknown as Dict;

describe('commodityLabel', () => {
    it('renders the Bulgarian name for a known slug', () => {
        expect(commodityLabel(translator(BG), 'wheat')).toBe('Пшеница');
        expect(commodityLabel(translator(BG), 'sunflower')).toBe('Слънчоглед');
    });

    it('renders the English name for the same slug', () => {
        expect(commodityLabel(translator(EN), 'wheat')).toBe('Wheat');
    });

    it('covers every slug the product can store, in BOTH locales', () => {
        // The claim the fix rests on: no new i18n key is needed because the
        // catalogue is already complete. If a commodity is ever added to the
        // vocabulary without a label, this fails rather than shipping a
        // title-cased English slug to a Bulgarian farmer.
        const slugs = [...CANONICAL_COMMODITIES, ...INPUT_COMMODITIES];
        expect(slugs.length).toBeGreaterThanOrEqual(15);
        for (const slug of slugs) {
            expect(EN[slug]).toBeTruthy();
            expect(BG[slug]).toBeTruthy();
            // …and the label is a real name, not the slug echoed back.
            expect(commodityLabel(translator(BG), slug)).not.toBe(slug);
        }
    });

    describe('fallback for a slug in no catalogue', () => {
        it('title-cases rather than rendering the key path (has-aware)', () => {
            expect(commodityLabel(translator(BG), 'triticale')).toBe('Triticale');
        });

        it('title-cases when the translator returns the key path instead', () => {
            // No `has`; next-intl's default miss behaviour.
            expect(commodityLabel(pathReturningTranslator(BG), 'triticale')).toBe(
                'Triticale',
            );
        });

        it('never renders a next-intl key path', () => {
            const out = commodityLabel(pathReturningTranslator(BG), 'some-unknown-crop');
            expect(out).not.toContain('trends.commodities');
            expect(out).toBe('Some Unknown Crop');
        });

        it('splits hyphens, so a multi-word slug reads as words', () => {
            expect(commodityLabel(translator({}), 'ammonium-nitrate')).toBe(
                'Ammonium Nitrate',
            );
        });

        it('survives a translator that throws', () => {
            const throwing = (() => {
                throw new Error('boom');
            }) as (key: string) => string;
            expect(commodityLabel(throwing, 'wheat')).toBe('Wheat');
        });
    });

    describe('degenerate input', () => {
        it.each(['', '   '])('returns empty for %p', (slug) => {
            expect(commodityLabel(translator(BG), slug)).toBe('');
        });
    });

    it('does not mutate the slug it was given', () => {
        // The value is identity — it goes back out as a URL param and an API
        // query. Only the label may change.
        const slug = 'wheat';
        commodityLabel(translator(BG), slug);
        expect(slug).toBe('wheat');
    });
});
