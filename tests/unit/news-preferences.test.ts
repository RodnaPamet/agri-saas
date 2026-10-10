/**
 * The two asymmetric rules for a stored Новини preference.
 *
 * `reject unknown on WRITE, ignore unknown on READ` is the whole design, and
 * it is the kind of pair that rots by being "made consistent" by somebody who
 * sees only one half. Both directions are asserted here, next to each other,
 * with the reason each way round.
 *
 * The `null` / `[]` distinction is tested for the same reason: it affects no
 * filtering at all — both show the full feed — so there is no behaviour to
 * notice if it quietly collapses. The only thing that would reveal it is a
 * prompt shown to someone who had already declined, months later.
 */
import {
    MAX_NEWS_TAG_PREFERENCES,
    NewsPreferencesBodySchema,
    readNewsPreferences,
} from '@/lib/news/preferences';
import { ALL_NEWS_TAGS } from '@/lib/news/categorize';

describe('readNewsPreferences — ignore unknown on READ', () => {
    it('control: the vocabulary is non-empty, so these cases are real', () => {
        // Without this every assertion below could be passing over an empty
        // known-set, where "drops unknown tags" and "drops everything" agree.
        expect(ALL_NEWS_TAGS.length).toBeGreaterThanOrEqual(5);
    });

    it('keeps known tags in the stored order', () => {
        // Not sorted: the stored order is the reader's. The FEED sorts, because
        // there a cache key depends on it.
        expect(readNewsPreferences(['prices', 'wheat'])).toEqual(['prices', 'wheat']);
    });

    it('DROPS a tag the vocabulary no longer covers', () => {
        // The reason this is not an error: tags get renamed, and a list
        // validated only when it was written would filter the feed down to
        // nothing with no way for the reader to understand why.
        expect(readNewsPreferences(['wheat', 'retired-tag'])).toEqual(['wheat']);
    });

    it('an all-unknown list reads as [] — "chose nothing", not null', () => {
        // `[]` here is honest: they DID choose, and nothing they chose survives.
        // Answering `null` would claim they never chose and re-open the prompt.
        expect(readNewsPreferences(['gone', 'also-gone'])).toEqual([]);
    });

    it('distinguishes never-chose from chose-nothing', () => {
        expect(readNewsPreferences(null)).toBeNull();
        expect(readNewsPreferences(undefined)).toBeNull();
        expect(readNewsPreferences([])).toEqual([]);
    });

    it.each([
        ['an object', { tags: ['wheat'] }],
        ['a string', 'wheat'],
        ['a number', 7],
        ['a boolean', true],
    ])('a malformed stored value (%s) reads as null, not []', (_label, stored) => {
        // `null`, because a malformed value is not a choice anybody made.
        // Reading it as `[]` would assert the reader chose nothing.
        expect(readNewsPreferences(stored)).toBeNull();
    });

    it('drops non-string members of an otherwise valid array', () => {
        expect(readNewsPreferences(['wheat', 7, null, 'prices'])).toEqual(['wheat', 'prices']);
    });
});

describe('NewsPreferencesBodySchema — reject unknown on WRITE', () => {
    it('accepts known tags', () => {
        const r = NewsPreferencesBodySchema.safeParse({ tags: ['wheat', 'prices'] });

        expect(r.success).toBe(true);
        expect(r.success && r.data.tags).toEqual(['wheat', 'prices']);
    });

    it('accepts the empty list — clearing is a choice', () => {
        const r = NewsPreferencesBodySchema.safeParse({ tags: [] });

        expect(r.success).toBe(true);
        expect(r.success && r.data.tags).toEqual([]);
    });

    it('REFUSES an unknown tag, and NAMES it', () => {
        // Named so a client bug is diagnosable from the response rather than by
        // diffing against the catalogue. The opposite of the read path, because
        // here a person is choosing and a typo is a bug worth surfacing.
        const r = NewsPreferencesBodySchema.safeParse({ tags: ['wheat', 'nonsense'] });

        expect(r.success).toBe(false);
        expect(r.success === false && JSON.stringify(r.error.issues)).toContain('nonsense');
    });

    it('de-duplicates rather than storing a choice twice', () => {
        const r = NewsPreferencesBodySchema.safeParse({ tags: ['wheat', 'wheat'] });

        expect(r.success && r.data.tags).toEqual(['wheat']);
    });

    it('bounds the list length', () => {
        const tooMany = Array.from({ length: MAX_NEWS_TAG_PREFERENCES + 1 }, () => 'wheat');

        expect(NewsPreferencesBodySchema.safeParse({ tags: tooMany }).success).toBe(false);
    });

    it.each([
        ['a missing field', {}],
        ['null', { tags: null }],
        ['a bare string', { tags: 'wheat' }],
        ['numbers', { tags: [1, 2] }],
    ])('refuses %s', (_label, body) => {
        expect(NewsPreferencesBodySchema.safeParse(body).success).toBe(false);
    });

    it('the two rules genuinely DISAGREE on the same input', () => {
        // The pair, in one assertion, because that is the thing somebody will
        // try to "make consistent". The same list is refused on write and
        // accepted-with-dropping on read, deliberately.
        const list = ['wheat', 'retired-tag'];

        expect(NewsPreferencesBodySchema.safeParse({ tags: list }).success).toBe(false);
        expect(readNewsPreferences(list)).toEqual(['wheat']);
    });
});
