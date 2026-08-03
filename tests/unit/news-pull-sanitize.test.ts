/**
 * Unit — `news-pull` sanitisation + per-feed error isolation.
 *
 * RSS is untrusted remote HTML, so the job MUST run title + snippet through
 * `sanitizePlainText` (Epic C.5) before persist. Also proves that one throwing
 * feed never kills the run (the other feed's items still persist) and that
 * non-http article URLs are dropped.
 */
import { runNewsPull, type NewsPullDeps } from '@/app-layer/jobs/news-pull';
import type { ParsedFeed } from '@/lib/market/news-feed-client';

interface Upserted {
    urlHash: string;
    title: string;
    snippet: string;
    url: string;
    imageUrl: string | null;
    feedSource: string;
}

/** Minimal in-memory MarketNewsItem delegate capturing upsert payloads. */
function makeDb() {
    const rows: Upserted[] = [];
    const db = {
        marketNewsItem: {
            upsert: jest.fn(async ({ create }: { create: Upserted }) => {
                rows.push(create);
                return create;
            }),
            deleteMany: jest.fn(async () => ({ count: 0 })),
        },
    };
    return { db, rows };
}

const XSS_FEED: ParsedFeed = {
    sourceLabel: '<b>АГРО.БГ</b>',
    items: [
        {
            title: 'Цена <script>alert(1)</script> нагоре',
            url: 'https://agro.bg/a/1',
            snippet: 'Резюме <img src=x onerror=alert(2)> тук',
            imageUrl: 'https://agro.bg/img/1.webp',
            publishedAt: new Date('2026-07-14T10:00:00Z'),
        },
        {
            // Non-http article URL — must be dropped.
            title: 'Bad protocol',
            url: 'javascript:alert(3)',
            snippet: 'x',
            imageUrl: null,
            publishedAt: new Date('2026-07-14T09:00:00Z'),
        },
    ],
};

describe('runNewsPull — sanitisation', () => {
    it('strips script/onerror payloads from title + snippet before persist', async () => {
        const { db, rows } = makeDb();
        const deps: NewsPullDeps = {
            feeds: ['https://agro.bg/rss'],
            fetchFeed: async () => XSS_FEED,
            db: db as unknown as NewsPullDeps['db'],
        };

        const result = await runNewsPull({}, deps);

        // Only the http item persisted (javascript: URL dropped).
        expect(rows).toHaveLength(1);
        expect(result.upserted).toBe(1);

        const [row] = rows;
        expect(row.title).not.toContain('<script>');
        expect(row.title).not.toContain('alert');
        expect(row.title).toContain('Цена');
        expect(row.title).toContain('нагоре');
        expect(row.snippet).not.toMatch(/<img|onerror/i);
        expect(row.snippet).toContain('Резюме');
        // Source label sanitised too (tags stripped).
        expect(row.feedSource).toBe('АГРО.БГ');
    });

    it('isolates a throwing feed and still persists the healthy feed', async () => {
        const { db, rows } = makeDb();
        const deps: NewsPullDeps = {
            feeds: ['https://dead.example/feed', 'https://agro.bg/rss'],
            fetchFeed: async (url) => {
                if (url.includes('dead.example')) throw new Error('403 Forbidden');
                return XSS_FEED;
            },
            db: db as unknown as NewsPullDeps['db'],
        };

        const result = await runNewsPull({}, deps);

        expect(result.failedFeeds).toBe(1);
        expect(result.upserted).toBe(1);
        expect(rows).toHaveLength(1);
    });

    it('returns early with no writes when no feeds are configured', async () => {
        const { db } = makeDb();
        const result = await runNewsPull(
            {},
            { feeds: [], db: db as unknown as NewsPullDeps['db'] },
        );
        expect(result).toEqual({
            feeds: 0,
            fetched: 0,
            upserted: 0,
            pruned: 0,
            failedFeeds: 0,
        });
        expect(db.marketNewsItem.upsert).not.toHaveBeenCalled();
    });
});
