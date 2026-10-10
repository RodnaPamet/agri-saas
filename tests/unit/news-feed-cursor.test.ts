/**
 * The Новини feed cursor — keyset, opaque, and forgiving of nonsense.
 *
 * Executed rather than asserted-about, because every property here is a
 * behaviour that fails as a WRONG ANSWER:
 *
 *   · a cursor that drops the id turns a page boundary inside one second into
 *     skipped or duplicated articles, and the feed still looks fine;
 *   · a cursor that REFUSES malformed input leaves a reader stuck on an error
 *     until they clear client state, for a value the server issued;
 *   · a `publishedAt: { lt }` fragment instead of the tuple comparison reads
 *     correctly and silently loses rows.
 */
import {
    cursorWhere,
    decodeFeedCursor,
    encodeFeedCursor,
    type FeedCursor,
} from '@/lib/news/feed-cursor';

const AT = new Date('2026-10-09T06:00:00.000Z');

describe('encode / decode', () => {
    it('round-trips a position exactly', () => {
        const back = decodeFeedCursor(encodeFeedCursor({ publishedAt: AT, id: 'clx123' }));

        expect(back?.id).toBe('clx123');
        expect(back?.publishedAt.toISOString()).toBe(AT.toISOString());
    });

    it('is opaque — the id is not readable in the cursor', () => {
        // Not security: a sign saying "do not parse me". A client that can read
        // the format will eventually construct one, and then it cannot change.
        const c = encodeFeedCursor({ publishedAt: AT, id: 'clx123' });

        expect(c).not.toContain('clx123');
        expect(c).not.toContain('2026');
    });

    it('survives an id containing the separator', () => {
        // `indexOf` + `slice` rather than `split('|')`, so an id that somehow
        // carries the separator does not silently truncate to its first part —
        // which would produce a VALID-looking cursor pointing at a different
        // row.
        const back = decodeFeedCursor(encodeFeedCursor({ publishedAt: AT, id: 'a|b|c' }));

        expect(back?.id).toBe('a|b|c');
    });

    describe.each([
        ['empty', ''],
        ['null', null],
        ['undefined', undefined],
        ['not base64', '!!!!'],
        ['no separator', Buffer.from('justtext', 'utf8').toString('base64url')],
        ['unparseable date', Buffer.from('nope|clx1', 'utf8').toString('base64url')],
        ['empty id', Buffer.from('2026-10-09T06:00:00.000Z|', 'utf8').toString('base64url')],
        ['empty date', Buffer.from('|clx1', 'utf8').toString('base64url')],
    ])('a %s cursor decodes to null', (_label, raw) => {
        it('is ignored, not refused', () => {
            expect(decodeFeedCursor(raw as string | null | undefined)).toBeNull();
        });
    });
});

describe('cursorWhere', () => {
    it('spreads to nothing without a cursor', () => {
        expect(cursorWhere(null)).toBeUndefined();
    });

    it('compares the TUPLE, so no row is skipped or repeated', () => {
        // The whole reason the id is in the cursor. `publishedAt: { lt }`
        // alone skips every other row sharing that second; `lte` repeats them.
        // Four feeds publish on the hour, so that second is routinely shared.
        const c: FeedCursor = { publishedAt: AT, id: 'clx5' };

        expect(cursorWhere(c)).toEqual({
            OR: [
                { publishedAt: { lt: AT } },
                { publishedAt: AT, id: { lt: 'clx5' } },
            ],
        });
    });

    it('the fragment is strictly OLDER — it never re-includes its own row', () => {
        // A positive control on the comparison direction: the cursor row
        // itself must not satisfy either arm, or every page repeats its last
        // item as the next page's first.
        const c: FeedCursor = { publishedAt: AT, id: 'clx5' };
        const w = cursorWhere(c) as { OR: Record<string, { lt?: unknown }>[] };

        // arm 1 is strictly earlier; arm 2 is the same instant and a strictly
        // smaller id. `clx5` satisfies neither.
        expect(w.OR[0].publishedAt.lt).toEqual(AT);
        expect(w.OR[1].id?.lt).toBe('clx5');
    });
});
