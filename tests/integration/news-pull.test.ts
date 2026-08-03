/**
 * Integration test: news-pull upsert idempotence, against a real DB.
 *
 * The feed fetch is injected (deps.fetchFeed) so no network is touched; the DB
 * client is the test-DB client (deps.db). Core invariant: running the pull TWICE
 * over identical feed data produces an IDENTICAL row count — the unique urlHash
 * makes every write idempotent (dedupe on re-run).
 */
import { runNewsPull } from '@/app-layer/jobs/news-pull';
import type { ParsedFeed } from '@/lib/market/news-feed-client';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const FEED: ParsedFeed = {
    sourceLabel: 'АГРО.БГ',
    items: [
        {
            title: 'Пшеницата поскъпва',
            url: 'https://agro.bg/a/1',
            snippet: 'Кратко резюме.',
            imageUrl: 'https://agro.bg/img/1.webp',
            publishedAt: new Date('2026-07-14T10:00:00Z'),
        },
        {
            title: 'Втора новина',
            url: 'https://agro.bg/a/2',
            snippet: '',
            imageUrl: null,
            publishedAt: new Date('2026-07-13T08:00:00Z'),
        },
    ],
};

describeFn('news-pull (integration — real DB)', () => {
    let prisma: PrismaClient;
    const deps = {
        feeds: ['https://agro.bg/rss'],
        fetchFeed: async (): Promise<ParsedFeed> => FEED,
    };

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    beforeEach(async () => {
        await prisma.marketNewsItem.deleteMany({});
    });

    afterAll(async () => {
        await prisma.marketNewsItem.deleteMany({});
        await prisma.$disconnect();
    });

    it('persists items and is idempotent across re-runs (dedupe on urlHash)', async () => {
        const first = await runNewsPull({}, { ...deps, db: prisma });
        expect(first.upserted).toBe(2);
        const countAfter1 = await prisma.marketNewsItem.count();
        expect(countAfter1).toBe(2);

        // Second run over identical data — no duplicate rows.
        const second = await runNewsPull({}, { ...deps, db: prisma });
        expect(second.upserted).toBe(2);
        const countAfter2 = await prisma.marketNewsItem.count();
        expect(countAfter2).toBe(2);
    });

    it('prunes items older than the retention window', async () => {
        await runNewsPull({}, { ...deps, db: prisma });
        // Insert an ancient item directly; the next run should prune it.
        await prisma.marketNewsItem.create({
            data: {
                urlHash: 'ancient-hash',
                feedSource: 'АГРО.БГ',
                title: 'Стара новина',
                snippet: '',
                url: 'https://agro.bg/a/old',
                imageUrl: null,
                publishedAt: new Date('2020-01-01T00:00:00Z'),
            },
        });
        expect(await prisma.marketNewsItem.count()).toBe(3);

        const result = await runNewsPull({}, { ...deps, db: prisma });
        expect(result.pruned).toBe(1);
        expect(await prisma.marketNewsItem.count()).toBe(2);
    });
});
