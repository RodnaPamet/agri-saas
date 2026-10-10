/**
 * Unit test for the market-news read usecase.
 *
 * `getMarketNews` reads the GLOBAL MarketNewsItem cache (no tenantId) via the
 * global prisma client, newest-first, optionally filtered by category, tags
 * and a search term, paged by an opaque cursor, and Redis-cached for 1h
 * except for searches. Both prisma + redis are mocked — no DB, no Redis.
 *
 * ## The assertions that exist for a WRONG ANSWER rather than an error
 *
 * Two of #231's failure modes are silent, and both are pinned here:
 *
 *   · a filter missing from the CACHE KEY serves the previous caller's
 *     filtered payload to the next one, for up to an hour, with nothing
 *     logged. The key is asserted in full per filter rather than with a
 *     `stringContaining`, because a key that merely MENTIONS a tag can still
 *     collide between two different tag sets.
 *   · an EMPTY tag list (every key unrecognised) must mean UNFILTERED. As
 *     `hasSome: []` it matches no rows, so a client passing a renamed
 *     preference would see an empty feed and read it as "no news".
 */
const mockFindMany = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, swapped per case
let mockRedis: any = null;

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { marketNewsItem: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));
jest.mock('@/lib/redis', () => ({ getRedis: () => mockRedis }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { getMarketNews } from '@/app-layer/usecases/trends';

const row = (over: Record<string, unknown> = {}) => ({
    id: 'n1',
    source: 'agri-bg',
    category: 'market',
    title: 'Цената на пшеницата',
    summary: 'обзор',
    url: 'https://agri.bg/1',
    imageUrl: null,
    publishedAt: new Date('2026-07-14T09:30:00.000Z'),
    tags: ['wheat', 'prices'],
    ...over,
});

/** The `where` AND-clauses of the Nth findMany call. */
const clausesOf = (n = 0): Record<string, unknown>[] =>
    (mockFindMany.mock.calls[n][0].where?.AND ?? []) as Record<string, unknown>[];

beforeEach(() => {
    mockFindMany.mockReset();
    mockRedis = null;
});

describe('getMarketNews', () => {
    it('returns the empty shape when no items exist (Redis off)', async () => {
        mockFindMany.mockResolvedValue([]);
        const res = await getMarketNews('all', 50);
        // `category` is required on the wire — the installed iOS build decodes
        // it as a non-optional String — and every other filter echoes what was
        // actually applied.
        expect(res).toEqual({ category: 'all', tags: [], q: null, items: [], nextCursor: null });
        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });

    it('maps rows to the wire shape with ISO publishedAt, newest first', async () => {
        mockFindMany.mockResolvedValue([row()]);
        const res = await getMarketNews('all', 50);
        expect(res.items[0]).toEqual({
            id: 'n1',
            source: 'agri-bg',
            category: 'market',
            title: 'Цената на пшеницата',
            summary: 'обзор',
            url: 'https://agri.bg/1',
            imageUrl: null,
            publishedAt: '2026-07-14T09:30:00.000Z',
            tags: ['wheat', 'prices'],
        });
        // `id` is the tie-break the cursor's tuple comparison depends on.
        // Four feeds publish on the hour, so without it a page boundary inside
        // one second skips or repeats rows — and the sort would still LOOK
        // right on any fixture whose timestamps happen to be distinct.
        expect(mockFindMany.mock.calls[0][0].orderBy).toEqual([
            { publishedAt: 'desc' },
            { id: 'desc' },
        ]);
    });

    it('filters by category when not "all", and leaves it open for "all"', async () => {
        mockFindMany.mockResolvedValue([]);
        await getMarketNews('policy', 50);
        expect(clausesOf()).toEqual([{ category: 'policy' }]);

        mockFindMany.mockClear();
        await getMarketNews('all', 50);
        expect(mockFindMany.mock.calls[0][0].where).toBeUndefined();
    });

    it('bounds the take to the requested limit, capped at 100 — plus ONE', async () => {
        // The +1 is how `nextCursor` is decided. Deriving it from
        // `rows.length === take` instead is wrong exactly once per feed — on
        // the page that happens to end on the boundary — and hands the reader
        // a cursor to an empty page.
        mockFindMany.mockResolvedValue([]);
        await getMarketNews('all', 25);
        expect(mockFindMany.mock.calls[0][0].take).toBe(26);

        mockFindMany.mockClear();
        await getMarketNews('all', 500);
        expect(mockFindMany.mock.calls[0][0].take).toBe(101);
    });

    it('serves from the Redis cache without hitting the DB', async () => {
        const cached = JSON.stringify({
            category: 'all',
            tags: [],
            q: null,
            nextCursor: null,
            items: [row({ publishedAt: '2026-07-14T09:30:00.000Z' })],
        });
        mockRedis = { get: jest.fn().mockResolvedValue(cached), set: jest.fn() };
        const res = await getMarketNews('all', 50);
        expect(res.items).toHaveLength(1);
        expect(mockFindMany).not.toHaveBeenCalled();
    });

    it('writes the DB result back to Redis on a miss', async () => {
        mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
        mockFindMany.mockResolvedValue([row()]);
        await getMarketNews('market', 10);
        expect(mockRedis.set).toHaveBeenCalledWith(
            // `v1:{category}:{tags}:{q}:{limit}:{cursor}` with tags and q empty —
            // three separators, not four. Spelled out in full rather than with
            // a `stringContaining`, because a key that merely MENTIONS the
            // category still collides between two different tag sets.
            'trends:news:v1:market:::10:',
            expect.any(String),
            'EX',
            3600,
        );
    });

    describe('tags (#231 step 3)', () => {
        it('filters ANY-OF with hasSome', async () => {
            mockFindMany.mockResolvedValue([]);
            await getMarketNews('all', 50, { tags: ['barley', 'wheat'] });

            expect(clausesOf()).toEqual([{ tags: { hasSome: ['barley', 'wheat'] } }]);
        });

        it('an EMPTY tag list means UNFILTERED, never match-nothing', async () => {
            // The every-key-unrecognised case. `hasSome: []` matches no rows,
            // so a client passing a renamed preference would get an empty feed
            // and read it as "there is no news" — the filter would look like
            // it worked.
            mockFindMany.mockResolvedValue([]);
            await getMarketNews('all', 50, { tags: [] });

            expect(mockFindMany.mock.calls[0][0].where).toBeUndefined();
        });

        it('is in the cache key, and two different tag sets do NOT collide', async () => {
            mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
            mockFindMany.mockResolvedValue([]);

            await getMarketNews('all', 50, { tags: ['barley', 'wheat'] });
            await getMarketNews('all', 50, { tags: ['wheat'] });

            const keys = mockRedis.set.mock.calls.map((c: unknown[]) => c[0]);
            expect(keys[0]).toBe('trends:news:v1:all:barley,wheat::50:');
            expect(keys[1]).toBe('trends:news:v1:all:wheat::50:');
            expect(new Set(keys).size).toBe(2);
        });
    });

    describe('q (#231 step 3)', () => {
        it('searches title and summary, case-insensitively', async () => {
            mockFindMany.mockResolvedValue([]);
            await getMarketNews('all', 50, { q: 'пшеница' });

            expect(clausesOf()).toEqual([
                {
                    OR: [
                        { title: { contains: 'пшеница', mode: 'insensitive' } },
                        { summary: { contains: 'пшеница', mode: 'insensitive' } },
                    ],
                },
            ]);
        });

        it('BYPASSES the cache entirely — neither read nor written', async () => {
            // The key space of a free-text search is unbounded, so caching per
            // query churns the cache and evicts the hot unfiltered feed every
            // reader shares. Both halves asserted: a `get` that still ran
            // could serve a stale search, and a `set` that still ran is the
            // eviction this avoids.
            mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
            mockFindMany.mockResolvedValue([]);

            await getMarketNews('all', 50, { q: 'пшеница' });

            expect(mockRedis.get).not.toHaveBeenCalled();
            expect(mockRedis.set).not.toHaveBeenCalled();
            expect(mockFindMany).toHaveBeenCalledTimes(1);
        });

        it('echoes the term, so a client can tell which response it has', async () => {
            mockFindMany.mockResolvedValue([]);
            const res = await getMarketNews('all', 50, { q: 'рапица' });

            expect(res.q).toBe('рапица');
        });
    });

    describe('cursor (#231 step 3)', () => {
        it('compares the (publishedAt, id) TUPLE, not the timestamp alone', async () => {
            mockFindMany.mockResolvedValue([row()]);
            const first = await getMarketNews('all', 1);
            mockFindMany.mockClear();
            mockFindMany.mockResolvedValue([]);

            // One row for a page of one means no further page.
            expect(first.nextCursor).toBeNull();

            mockFindMany.mockResolvedValue([row(), row({ id: 'n2' })]);
            const page = await getMarketNews('all', 1);
            expect(page.nextCursor).not.toBeNull();

            mockFindMany.mockClear();
            mockFindMany.mockResolvedValue([]);
            await getMarketNews('all', 1, { cursor: page.nextCursor });

            // `publishedAt: { lt }` alone would skip every other row sharing
            // that second; `lte` would repeat them.
            expect(clausesOf()).toEqual([
                {
                    OR: [
                        { publishedAt: { lt: new Date('2026-07-14T09:30:00.000Z') } },
                        { publishedAt: new Date('2026-07-14T09:30:00.000Z'), id: { lt: 'n1' } },
                    ],
                },
            ]);
        });

        it('IGNORES a malformed cursor rather than refusing it', async () => {
            // A reader whose saved cursor points at an article the 60-day
            // retention has deleted should get page one, not a 400 that
            // persists until they clear their state.
            mockFindMany.mockResolvedValue([]);
            await getMarketNews('all', 50, { cursor: 'not-a-cursor' });

            expect(mockFindMany.mock.calls[0][0].where).toBeUndefined();
        });

        it('is in the cache key — page 2 must not serve page 1', async () => {
            mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
            mockFindMany.mockResolvedValue([]);

            await getMarketNews('all', 50, { cursor: 'Y3Vyc29y' });

            expect(mockRedis.set.mock.calls[0][0]).toBe('trends:news:v1:all:::50:Y3Vyc29y');
        });
    });
});
