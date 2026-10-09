/**
 * A Bulgarian crop PREFIX resolves to the same slug a whole word does.
 *
 * ## The defect, as the owner reported it (2026-10-08)
 *
 * «пшеница» finds the wheat offer on Борса. «пше» does not. «whea» does.
 *
 * The asymmetry is not about the resolver being strict — it is about where the
 * vocabulary lives. `ExchangeListing.commodity` stores the ENGLISH slug, so
 * the repository's `commodity contains q` branch makes any English prefix work
 * for free. There is no Bulgarian text in that column for «пше» to be a prefix
 * of, and `normalizeCommodity` is an exact lookup, so the Bulgarian half had
 * nothing to match against at either end.
 *
 * `commoditiesMatchingPrefix` resolves the prefix against the ALIAS TABLE —
 * the only place Bulgarian spellings exist — and feeds the slugs to the exact
 * `commodity in (…)` branch the listings route already had from #1426.
 *
 * ## What is asserted, and what deliberately is not
 *
 * This file is about the RESOLVER. It does not touch the database, because the
 * mapping from a typed prefix to a set of slugs is the whole of the new
 * behaviour — the `in` branch that consumes those slugs shipped in #1426 and
 * is covered by the exchange search tests.
 *
 * Regions are NOT changed and that absence is deliberate rather than
 * overlooked. agrent-ios asked whether `regionCodesMatchingName` has the same
 * gap; it does not. It filters on `nameBg.includes(q) || nameEn.includes(q)`,
 * which is substring matching, so «Пле» already finds Плевен — and the
 * repository ALSO matches `regionName contains q` against the stored name. Two
 * substring paths, no exact-match floor. A case below pins that, so the claim
 * is checked rather than remembered.
 */
import {
    commoditiesMatchingPrefix,
    normalizeCommodity,
    COMMODITY_PREFIX_MIN_LENGTH,
    CANONICAL_COMMODITIES,
} from '@/lib/market/commodity-vocabulary';
import { regionCodesMatchingName } from '@/lib/geo/bulgaria-regions';

describe("the owner's case", () => {
    it('«пше» resolves to wheat, as «пшеница» already did', () => {
        expect(commoditiesMatchingPrefix('пше')).toEqual(['wheat']);
        expect(normalizeCommodity('пшеница')).toBe('wheat');
    });

    it('control: «пше» resolved to NOTHING through the exact resolver', () => {
        // The defect in one assertion. Without this the case above would pass
        // against a world where «пше» already worked.
        expect(normalizeCommodity('пше')).toBeNull();
    });

    it('«whea» still resolves — the English half was never broken', () => {
        expect(commoditiesMatchingPrefix('whea')).toEqual(['wheat']);
    });
});

describe('the prefix resolver', () => {
    it.each([
        ['рап', ['rapeseed']],
        ['ече', ['barley']],
        ['слън', ['sunflower']],
        ['цар', ['maize']],
        ['ове', ['oats']],
        ['ръж', ['rye']],
        ['гра', ['peas']],
        ['лещ', ['lentils']],
        ['соя', ['soybean']],
    ])('«%s» resolves to %s', (term, expected) => {
        expect(commoditiesMatchingPrefix(term as string)).toEqual(expected);
    });

    it('subsumes the exact match — a word is a prefix of itself', () => {
        for (const slug of CANONICAL_COMMODITIES) {
            expect(commoditiesMatchingPrefix(slug)).toContain(slug);
        }
    });

    it('deduplicates: wheat has six spellings and a short prefix hits several', () => {
        // `wheat`, `commonwheat`, `softwheat`, `durum`, `durumwheat`, `пшеница`.
        // Without the Set, «wh» would return wheat once per matching alias.
        const r = commoditiesMatchingPrefix('wh');
        expect(r).toEqual(['wheat']);
        expect(new Set(r).size).toBe(r.length);
    });

    it('an ambiguous prefix returns SEVERAL — that is the answer, not a failure', () => {
        // «so» starts `soybean`, `soybeans`, `soya` AND `softwheat`.
        expect(commoditiesMatchingPrefix('so')).toEqual(['soybean', 'wheat']);
    });

    it('refuses an INPUT, like normalizeCommodity does', () => {
        // «диз» is diesel. The exchange does not trade inputs, and the module's
        // safe default is that only a differently-named resolver returns them.
        expect(commoditiesMatchingPrefix('диз')).toEqual([]);
        expect(commoditiesMatchingPrefix('dies')).toEqual([]);
    });

    it('is folded: case, spacing and punctuation do not matter', () => {
        expect(commoditiesMatchingPrefix('ПШЕ')).toEqual(['wheat']);
        expect(commoditiesMatchingPrefix(' Пше ')).toEqual(['wheat']);
        expect(commoditiesMatchingPrefix('Sun-Flo')).toEqual(['sunflower']);
    });

    it('nothing resolves below the length floor', () => {
        expect(COMMODITY_PREFIX_MIN_LENGTH).toBe(2);
        expect(commoditiesMatchingPrefix('ц')).toEqual([]);
        expect(commoditiesMatchingPrefix('s')).toEqual([]);
        expect(commoditiesMatchingPrefix('')).toEqual([]);
        expect(commoditiesMatchingPrefix(null)).toEqual([]);
        expect(commoditiesMatchingPrefix(undefined)).toEqual([]);
    });

    it('control: a ONE-letter query really would have been broad', () => {
        // The floor's justification, measured rather than asserted. If this
        // came back as 1 the floor would be pointless and should go.
        expect(commoditiesMatchingPrefix('с', 1).length).toBeGreaterThan(1);
        expect(commoditiesMatchingPrefix('s', 1).length).toBeGreaterThan(1);
    });

    it('an inflected PLURAL resolves — all ten crops (#1473)', () => {
        // Bulgarian pluralises an -а/-я noun by REPLACING the final vowel, so
        // the plural is never a prefix of the singular: «пшеници» does not
        // begin «пшеница». Measured before the fix, 10 of 10 crops resolved in
        // the singular and 0 in the plural, while «цени на пшеници» is the
        // ordinary way to say it.
        expect(commoditiesMatchingPrefix('пшеници')).toEqual(['wheat']);
        expect(commoditiesMatchingPrefix('царевици')).toEqual(['maize']);
        expect(commoditiesMatchingPrefix('слънчогледи')).toEqual(['sunflower']);
        expect(commoditiesMatchingPrefix('рапици')).toEqual(['rapeseed']);
        expect(commoditiesMatchingPrefix('ечемики')).toEqual(['barley']);
        expect(commoditiesMatchingPrefix('овеси')).toEqual(['oats']);
        expect(commoditiesMatchingPrefix('ръжи')).toEqual(['rye']);
        expect(commoditiesMatchingPrefix('грахи')).toEqual(['peas']);
        expect(commoditiesMatchingPrefix('лещи')).toEqual(['lentils']);
        // «соя» → «сои» loses TWO characters to the stem, leaving exactly the
        // two-character floor. It is the case closest to the boundary and the
        // one that would break first if the floor moved.
        expect(commoditiesMatchingPrefix('сои')).toEqual(['soybean']);
    });

    it('stemming is a FALLBACK — an exact answer is never widened', () => {
        // The safety property of the change, and finding a case that can
        // actually FAIL took a search: at the default floor, stemming only ever
        // widens a prefix by one character, and across all 279 prefixes of
        // every alias there is NOT ONE query where exact-first and
        // always-stemming disagree. A test at the default floor therefore
        // proves nothing — the first version of this test passed with the
        // exact-first guard deleted.
        //
        // `minLength: 1` exposes it, using the same parameter the control below
        // already relies on:
        //
        //     со @1  ->  ['soybean']                exact wins
        //     с  @1  ->  ['soybean', 'sunflower']   what the stem would answer
        //
        // So if stemming ran unconditionally, «со» would answer for «с» and
        // pick up sunflower. It must not.
        expect(commoditiesMatchingPrefix('со', 1)).toEqual(['soybean']);
        expect(commoditiesMatchingPrefix('с', 1)).toEqual(['soybean', 'sunflower']);

        // And the ordinary cases, which hold at the default floor even though
        // they cannot distinguish the two orders — kept because they are what a
        // reader will check first.
        expect(commoditiesMatchingPrefix('so')).toEqual(['soybean', 'wheat']);
        expect(commoditiesMatchingPrefix('леща')).toEqual(['lentils']);
        expect(commoditiesMatchingPrefix('пше')).toEqual(['wheat']);
    });

    it('the floor applies to the STEM, not only to the input', () => {
        // Without that, a two-character query ending in a vowel stems to one
        // character and matches most of the table. These are above the floor as
        // typed and below it once stemmed, so they must stay empty.
        //
        // Measured rather than assumed, after a first draft asserted «ца» here
        // and was wrong: «ца» IS an exact prefix of «царевица», so it resolves
        // on the exact path before stemming is reached — and «ра», «со» and
        // «ле» likewise match rapeseed, soybean and lentils. Only a
        // two-character query with no exact match tests the floor at all.
        for (const q of ['ше', 'жи', 'ти', 'ко', 'въ', 'ня', 'пе']) {
            expect(commoditiesMatchingPrefix(q)).toEqual([]);
        }
        // The control: a two-character query that DOES have an exact prefix
        // still answers, so the loop above is not passing because the resolver
        // refuses everything short.
        expect(commoditiesMatchingPrefix('ца')).toEqual(['maize']);
        // And a refused INPUT stays refused — `нафта` is diesel, which this
        // resolver does not answer for, plural or not.
        expect(commoditiesMatchingPrefix('нафти')).toEqual([]);
        expect(commoditiesMatchingPrefix('дизели')).toEqual([]);
    });

    it('a MID-WORD fragment does not match — this is a prefix, not a substring', () => {
        // The function is named for prefixes and documented as such, and until
        // this case existed nothing held it to that: swapping `startsWith` for
        // `includes` passed every other test in the file. The difference is not
        // academic — «ца» is a prefix of царевица and ALSO sits inside пшеница,
        // so a substring matcher answers a two-letter query with two crops
        // where the owner asked for one.
        expect(commoditiesMatchingPrefix('ше')).toEqual([]); // inside пшеница
        expect(commoditiesMatchingPrefix('ница')).toEqual([]); // ends пшеница
        expect(commoditiesMatchingPrefix('hea')).toEqual([]); // inside wheat
        expect(commoditiesMatchingPrefix('ца')).toEqual(['maize']); // NOT also wheat
    });

    it('control: those fragments really are present mid-word', () => {
        // Otherwise the case above would pass against fragments that appear
        // nowhere, proving nothing about prefix-versus-substring.
        expect('пшеница'.includes('ше')).toBe(true);
        expect('пшеница'.includes('ница')).toBe(true);
        expect('пшеница'.includes('ца')).toBe(true);
        expect('wheat'.includes('hea')).toBe(true);
    });

    it('a prefix that matches nothing resolves to nothing', () => {
        // And NOT to every commodity, which is the failure mode of a matcher
        // that treats an empty filter as "no filter".
        expect(commoditiesMatchingPrefix('zzz')).toEqual([]);
        expect(commoditiesMatchingPrefix('щщ')).toEqual([]);
    });
});

describe('regions already do substring matching — no change needed', () => {
    it('«Пле» finds Плевен', () => {
        // The claim agrent-ios asked me to check. `regionCodesMatchingName`
        // uses `.includes`, not equality, so the region axis never had the
        // exact-match gap the commodity axis had.
        expect(regionCodesMatchingName('Пле').length).toBeGreaterThan(0);
    });

    it('and an English prefix finds it too', () => {
        expect(regionCodesMatchingName('Plev').length).toBeGreaterThan(0);
    });

    it('control: a region prefix matching nothing returns nothing', () => {
        expect(regionCodesMatchingName('Zzzz')).toEqual([]);
        expect(regionCodesMatchingName('')).toEqual([]);
    });
});
