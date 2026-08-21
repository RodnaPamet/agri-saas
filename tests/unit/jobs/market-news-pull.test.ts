/**
 * Unit tests for runMarketNewsPull with injected fetch + db seams (no network,
 * no DB). Pins: per-feed fetch, sanitisation, keyword categorisation, idempotent
 * upsert shape, the 60-day prune cutoff, and per-feed fail-soft.
 */
import { runMarketNewsPull } from '@/app-layer/jobs/market-news-pull';
import type { RawNewsItem } from '@/lib/news/rss-client';

// One fixed feed list so the test is independent of the curated defaults / env.
jest.mock('@/lib/news/feeds', () => ({
    resolveNewsFeeds: () => [
        { slug: 'agri-bg', url: 'https://agri.bg/rss', defaultCategory: 'general' },
        { slug: 'ec-agrifood', url: 'https://ec.europa.eu/rss', defaultCategory: 'policy' },
    ],
}));

function rawItem(over: Partial<RawNewsItem> = {}): RawNewsItem {
    return {
        title: 'Дъжд през уикенда',
        url: 'https://x/1',
        summary: 'кратко',
        publishedAt: new Date('2026-07-14T00:00:00Z'),
        guid: 'g1',
        imageUrl: null,
        ...over,
    };
}

function fakeDb() {
    const upserts: any[] = [];
    const deletes: any[] = [];
    return {
        marketNewsItem: {
            upsert: jest.fn(async (args: any) => {
                upserts.push(args);
                return {};
            }),
            deleteMany: jest.fn(async (args: any) => {
                deletes.push(args);
                return { count: 3 };
            }),
        },
        _upserts: upserts,
        _deletes: deletes,
    };
}

const NOW = () => new Date('2026-07-15T12:00:00Z');

describe('runMarketNewsPull', () => {
    it('fetches every feed, upserts each item, and prunes', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            .mockResolvedValueOnce([rawItem({ guid: 'a' }), rawItem({ guid: 'b', url: 'https://x/2' })])
            .mockResolvedValueOnce([rawItem({ guid: 'c', url: 'https://x/3' })]);

        const r = await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        expect(fetchFeedImpl).toHaveBeenCalledTimes(2);
        expect(r).toEqual({ feeds: 2, fetched: 3, upserted: 3, pruned: 3 });
        expect(db.marketNewsItem.upsert).toHaveBeenCalledTimes(3);
    });

    it('categorises via keyword override, falling back to the feed default', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            // agri-bg (default general): a price headline promotes to market.
            .mockResolvedValueOnce([rawItem({ title: 'Цената на пшеницата', guid: 'p' })])
            // ec-agrifood (default policy): a neutral headline keeps policy.
            .mockResolvedValueOnce([rawItem({ title: 'Weekly overview', guid: 'n' })]);

        await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        const cats = db._upserts.map((u) => u.create.category);
        expect(cats).toEqual(['market', 'policy']);
    });

    it('sanitises HTML out of title + summary before persisting', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest.fn().mockResolvedValueOnce([
            rawItem({ title: 'Cena <b>x</b>', summary: '<script>alert(1)</script>hi', guid: 's' }),
        ]).mockResolvedValueOnce([]);

        await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        const c = db._upserts[0].create;
        expect(c.title).not.toContain('<');
        expect(c.summary).not.toContain('<script>');
    });

    it('computes a stable, feed-namespaced guidHash used as the upsert key', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            .mockResolvedValueOnce([rawItem({ guid: 'same' })])
            .mockResolvedValueOnce([rawItem({ guid: 'same' })]);

        await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        const [h1, h2] = db._upserts.map((u) => u.where.guidHash);
        expect(h1).toMatch(/^[a-f0-9]{64}$/);
        // Same guid from different feeds ⇒ different hash (namespaced by slug).
        expect(h1).not.toBe(h2);
    });

    it('prunes items older than 60 days from `now`', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest.fn().mockResolvedValue([]);

        await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        expect(db.marketNewsItem.deleteMany).toHaveBeenCalledTimes(1);
        const cutoff: Date = db._deletes[0].where.publishedAt.lt;
        // 2026-07-15 minus 60 days = 2026-05-16.
        expect(cutoff.toISOString().slice(0, 10)).toBe('2026-05-16');
    });

    it('is fail-soft: a feed that throws is skipped, the batch continues', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce([rawItem({ guid: 'ok' })]);

        const r = await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        expect(r.upserted).toBe(1);
        expect(db.marketNewsItem.upsert).toHaveBeenCalledTimes(1);
    });

    it('scopes to one feed when feedSlug is given', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest.fn().mockResolvedValue([rawItem()]);

        const r = await runMarketNewsPull(
            { feedSlug: 'ec-agrifood' },
            { db: db as any, fetchFeedImpl, now: NOW },
        );

        expect(fetchFeedImpl).toHaveBeenCalledTimes(1);
        expect(fetchFeedImpl).toHaveBeenCalledWith('https://ec.europa.eu/rss', expect.any(Object));
        expect(r.feeds).toBe(1);
    });

    // ── URL scheme, checked at ingest (issue #654 harvest) ──

    it('skips an item whose link is not http(s)', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            .mockResolvedValueOnce([
                rawItem({ guid: 'bad', url: 'javascript:alert(1)' }),
                rawItem({ guid: 'ok', url: 'https://agro.bg/1' }),
            ])
            .mockResolvedValue([]);

        const r = await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        // The whole card is an anchor, so an item with no usable link is
        // skipped rather than stored linkless.
        expect(r.upserted).toBe(1);
        const urls = db.marketNewsItem.upsert.mock.calls.map(
            (c: any[]) => c[0].create.url,
        );
        expect(urls).toEqual(['https://agro.bg/1']);
    });

    it.each(['http://plain.example/x', 'https://secure.example/x'])(
        'keeps an ordinary %s link',
        async (url) => {
            const db = fakeDb();
            const fetchFeedImpl = jest
                .fn()
                .mockResolvedValueOnce([rawItem({ url })])
                .mockResolvedValue([]);

            const r = await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });
            expect(r.upserted).toBe(1);
        },
    );

    it('nulls an unsafe imageUrl but keeps the item', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            .mockResolvedValueOnce([
                rawItem({ url: 'https://agro.bg/1', imageUrl: 'javascript:alert(1)' }),
            ])
            .mockResolvedValue([]);

        const r = await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });

        // imageUrl is stored "for later" and rendered by nobody yet — which is
        // exactly why it is checked here and not at a render site.
        expect(r.upserted).toBe(1);
        const call = db.marketNewsItem.upsert.mock.calls[0][0];
        expect(call.create.imageUrl).toBeNull();
        expect(call.update.imageUrl).toBeNull();
        expect(call.create.url).toBe('https://agro.bg/1');
    });

    it('keeps a good imageUrl', async () => {
        const db = fakeDb();
        const fetchFeedImpl = jest
            .fn()
            .mockResolvedValueOnce([
                rawItem({ url: 'https://agro.bg/1', imageUrl: 'https://agro.bg/i.jpg' }),
            ])
            .mockResolvedValue([]);

        await runMarketNewsPull({}, { db: db as any, fetchFeedImpl, now: NOW });
        expect(db.marketNewsItem.upsert.mock.calls[0][0].create.imageUrl).toBe(
            'https://agro.bg/i.jpg',
        );
    });
});
