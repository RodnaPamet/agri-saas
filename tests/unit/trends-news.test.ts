/**
 * Unit — `getMarketNews` read usecase (keyset pagination + DTO mapping).
 *
 * Redis is stubbed to null so every call takes the live-DB path; prisma is
 * mocked so we assert the query shape (newest-first, take = PAGE+1) and the
 * nextCursor derivation without a database.
 */
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { marketNewsItem: { findMany } },
}));

import { getMarketNews } from '@/app-layer/usecases/trends-news';
import { NEWS_PAGE_SIZE } from '@/app-layer/schemas/trends.schemas';

function fakeRow(i: number) {
    return {
        id: `id-${i}`,
        feedSource: 'АГРО.БГ',
        title: `Title ${i}`,
        snippet: `Snippet ${i}`,
        url: `https://agro.bg/${i}`,
        imageUrl: i % 2 === 0 ? `https://agro.bg/img/${i}.webp` : null,
        publishedAt: new Date(Date.UTC(2026, 6, 14, 12, 0, 0) - i * 1000),
    };
}

beforeEach(() => findMany.mockReset());

describe('getMarketNews', () => {
    it('maps rows to DTOs and derives a nextCursor when a full page + 1 is returned', async () => {
        // PAGE_SIZE + 1 rows → hasMore true; last returned id is the cursor.
        findMany.mockResolvedValue(
            Array.from({ length: NEWS_PAGE_SIZE + 1 }, (_, i) => fakeRow(i)),
        );

        const page = await getMarketNews();

        expect(page.items).toHaveLength(NEWS_PAGE_SIZE);
        expect(page.nextCursor).toBe(`id-${NEWS_PAGE_SIZE - 1}`);
        // ISO string + null-safe image mapping.
        expect(page.items[0]).toMatchObject({
            id: 'id-0',
            feedSource: 'АГРО.БГ',
            url: 'https://agro.bg/0',
        });
        expect(typeof page.items[0].publishedAt).toBe('string');

        // Query shape: newest-first, take = PAGE + 1, no cursor on head page.
        const arg = findMany.mock.calls[0][0];
        expect(arg.take).toBe(NEWS_PAGE_SIZE + 1);
        expect(arg.orderBy).toEqual([{ publishedAt: 'desc' }, { id: 'desc' }]);
        expect(arg.cursor).toBeUndefined();
    });

    it('returns nextCursor=null on a short final page', async () => {
        findMany.mockResolvedValue([fakeRow(0), fakeRow(1)]);
        const page = await getMarketNews();
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeNull();
    });

    it('applies the cursor (+skip) when paging forward', async () => {
        findMany.mockResolvedValue([]);
        await getMarketNews('id-5');
        const arg = findMany.mock.calls[0][0];
        expect(arg.cursor).toEqual({ id: 'id-5' });
        expect(arg.skip).toBe(1);
    });
});
