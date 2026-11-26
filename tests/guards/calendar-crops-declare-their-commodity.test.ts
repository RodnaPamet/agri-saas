/**
 * A calendar crop that HAS a canonical commodity must declare it.
 *
 * ## The direction `reference-slugs.ts` does not cover
 *
 * That module guards the DATASET side: a reference figure must be written
 * under the canonical slug, because — in its own words — a dataset written
 * with an alias *"loads, serves, and is found by no crop: a figure that
 * exists and is never shown"*. It names the join targets explicitly, and one
 * of them is **the calendar's `commodityCanonical`**.
 *
 * Nothing guarded that target. Measured on main before this guard: **5 of 40**
 * calendar crops declared the field, and six crops that have a canonical
 * commodity omitted it — `wheat-durum`, `rye`, `oats`, `pea`, `lentil`, `soy`.
 * Every one of those six has a national yield row in the benchmarks dataset,
 * and three of them (`wheat-durum` 15, `rye` 7, `oats` 5) have pest
 * thresholds. So the outcome was identical to the failure `reference-slugs`
 * exists to prevent — a figure that exists and is never shown — reached from
 * the uncovered side. The durum wheat page showed no pests while the bread
 * wheat page showed fifteen.
 *
 * ## Why the expectation is DERIVED and not a list
 *
 * `normalizeCommodity` already knows the vocabulary, so for most crops the
 * rule needs no maintenance: if the crop key resolves to a canonical
 * commodity, the crop must declare that value. A hand list would be the thing
 * that goes stale, and this file would become the stale half.
 *
 * Three keys the resolver CANNOT see need an explicit entry, and that is the
 * right place for them because each is a human judgement rather than a
 * lookup — see `UNRESOLVABLE_BY_NAME`.
 *
 * ## What is deliberately NOT required
 *
 * That every FIELD crop declare one. `dry-bean`, `broad-bean`, `vetch` and
 * `triticale` have no canonical commodity at all — the vocabulary does not
 * know them, and `reference-slugs` says a slug it does not know "passes: it
 * has no canonical spelling to disagree with". Inventing a value for them
 * would put a non-canonical slug in the field whose whole purpose is to carry
 * a canonical one.
 */
import { CALENDAR } from '@/lib/agro/calendar/load';
import {
    CANONICAL_COMMODITIES,
    normalizeCommodity,
} from '@/lib/market/commodity-vocabulary';

/**
 * Crop keys whose canonical commodity `normalizeCommodity` cannot derive,
 * each with the reason it is a judgement rather than a lookup.
 *
 * Every entry is asserted to name a crop that EXISTS and a commodity that is
 * CANONICAL, so a renamed crop or a typo'd commodity fails loudly instead of
 * sitting here inert — the failure mode an exemption table invites.
 */
const UNRESOLVABLE_BY_NAME: ReadonlyArray<readonly [string, string, string]> = [
    [
        'wheat-bread',
        'wheat',
        'The calendar splits wheat by end use and the vocabulary does not: '
            + '`wheat` is the only canonical wheat, because that is what the exchange '
            + 'trades and what the price series quote. Bread wheat is wheat.',
    ],
    [
        'wheat-durum',
        'wheat',
        'Durum is wheat for every purpose this field serves — the МЗХ guide says '
            + '«пшеница» without distinguishing end use for any of the fifteen pest '
            + 'thresholds, and the national yield row is for `wheat`. Declaring it is '
            + 'what stops the durum page showing zero pests while bread wheat shows 15.',
    ],
    [
        'soy',
        'soybean',
        'The calendar key is the Bulgarian short form and the canonical commodity is '
            + 'the full English one. Not an alias the vocabulary carries, so the '
            + 'resolver returns null for it.',
    ],
];

const CANONICAL = new Set<string>(CANONICAL_COMMODITIES);

/** The commodity a crop OUGHT to declare, or null if none is known. */
function expectedCommodity(key: string): string | null {
    const explicit = UNRESOLVABLE_BY_NAME.find(([k]) => k === key);
    if (explicit) return explicit[1];
    return normalizeCommodity(key);
}

describe('a calendar crop declares its canonical commodity', () => {
    it('prints its denominator', () => {
        const expected = CALENDAR.crops.filter((c) => expectedCommodity(c.key) !== null);
        const declared = CALENDAR.crops.filter((c) => c.commodityCanonical);
        console.log(
            `[calendar-commodity] crops=${CALENDAR.crops.length} `
                + `expected-to-declare=${expected.length} declared=${declared.length} `
                + `explicit-entries=${UNRESOLVABLE_BY_NAME.length}`,
        );
        // Floors, so a resolver that stopped resolving — or a dataset that lost
        // its crops — fails here rather than passing over an empty population.
        expect(CALENDAR.crops.length).toBeGreaterThanOrEqual(40);
        expect(expected.length).toBeGreaterThanOrEqual(11);
    });

    it('every crop with a known canonical commodity declares it', () => {
        const missing: string[] = [];
        const wrong: string[] = [];
        for (const crop of CALENDAR.crops) {
            const want = expectedCommodity(crop.key);
            if (want === null) continue;
            if (!crop.commodityCanonical) missing.push(`${crop.key} (want ${want})`);
            else if (crop.commodityCanonical !== want) {
                wrong.push(`${crop.key} declares ${crop.commodityCanonical}, want ${want}`);
            }
        }
        expect({ missing, wrong }).toEqual({ missing: [], wrong: [] });
    });

    it('every DECLARED commodity is a canonical one', () => {
        // The inverse of `reference-slugs.assertCanonicalSlug`, applied to the
        // calendar rather than to the reference datasets: a
        // `commodityCanonical: "canola"` would be found by no figure, which is
        // the same defect one step along.
        const notCanonical = CALENDAR.crops
            .filter((c) => c.commodityCanonical && !CANONICAL.has(c.commodityCanonical))
            .map((c) => `${c.key} -> ${c.commodityCanonical}`);
        expect(notCanonical).toEqual([]);
    });

    it('CONTROL — the resolver can still resolve, so the rule above has teeth', () => {
        // Without this, an emptied vocabulary makes `expectedCommodity` return
        // null for everything and the main assertion passes over nothing.
        expect(normalizeCommodity('rye')).toBe('rye');
        expect(normalizeCommodity('oats')).toBe('oats');
        expect(CANONICAL.size).toBeGreaterThanOrEqual(10);
    });

    it('every explicit entry names a real crop and a canonical commodity', () => {
        const keys = new Set(CALENDAR.crops.map((c) => c.key));
        for (const [key, commodity, reason] of UNRESOLVABLE_BY_NAME) {
            expect(keys.has(key)).toBe(true);
            expect(CANONICAL.has(commodity)).toBe(true);
            // A reason long enough to be a reason, not a placeholder.
            expect(reason.length).toBeGreaterThan(40);
        }
    });

    it('no explicit entry duplicates what the resolver already knows', () => {
        // An entry the resolver could derive is dead weight that reads as a
        // decision — and would go stale silently if the vocabulary later
        // gained the alias.
        const redundant = UNRESOLVABLE_BY_NAME.filter(
            ([key]) => normalizeCommodity(key) !== null,
        ).map(([key]) => key);
        expect(redundant).toEqual([]);
    });
});
