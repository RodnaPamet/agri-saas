/**
 * Agri-news feed read usecase.
 *
 * Serves the GLOBAL MarketNewsItem cache newest-first, keyset-paginated by id
 * (stable tiebreak under equal publishedAt). Each page is Redis-cached for 15
 * min (the news-pull job runs ~2h) and degrades to a live DB read on any Redis
 * miss/hiccup.
 *
 * The data is tenant-agnostic (no tenantId), so the caller authenticates as a
 * tenant member but the payload is identical for every tenant. Reads the global
 * `prisma` client directly because there is no tenantId to filter on / no RLS
 * risk — the same shape as `getPriceTrends` (see USECASE_ALLOWLIST in
 * tests/unit/no-direct-prisma.test.ts). Only public headline metadata is
 * served (title + snippet + source + link) — no full-text, no business data.
 *
 * @module app-layer/usecases/trends-news
 */
import prisma from '@/lib/prisma';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import { NEWS_PAGE_SIZE } from '@/app-layer/schemas/trends.schemas';

const CACHE_TTL_SECONDS = 900; // 15 min — data refreshes ~2h
const COMPONENT = 'trends-news';

export interface NewsItemDTO {
    id: string;
    feedSource: string;
    title: string;
    snippet: string;
    url: string;
    imageUrl: string | null;
    /** ISO-8601 publication timestamp. */
    publishedAt: string;
}

export interface NewsFeedPage {
    items: NewsItemDTO[];
    /** Cursor (last item id) for the next page, or null when exhausted. */
    nextCursor: string | null;
}

async function readFromDb(cursor?: string): Promise<NewsFeedPage> {
    // Keyset pagination: newest first, id as the stable tiebreak + cursor.
    const rows = await prisma.marketNewsItem.findMany({
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: NEWS_PAGE_SIZE + 1, // one extra row probes for a next page
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
            id: true,
            feedSource: true,
            title: true,
            snippet: true,
            url: true,
            imageUrl: true,
            publishedAt: true,
        },
    });

    const hasMore = rows.length > NEWS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, NEWS_PAGE_SIZE) : rows;
    return {
        items: page.map((r) => ({
            id: r.id,
            feedSource: r.feedSource,
            title: r.title,
            snippet: r.snippet,
            url: r.url,
            imageUrl: r.imageUrl,
            publishedAt: r.publishedAt.toISOString(),
        })),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
}

/** Read one page of the agri-news feed, Redis-cached (15 min). */
export async function getMarketNews(cursor?: string): Promise<NewsFeedPage> {
    const cacheKey = `trends:news:v1:${cursor ?? 'head'}`;
    const redis = getRedis();

    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached) as NewsFeedPage;
        } catch {
            /* redis hiccup — fall through to a live DB read */
        }
    }

    const payload = await readFromDb(cursor);

    if (redis) {
        try {
            await redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
        } catch (err) {
            // Non-fatal — the response is already computed, just uncached.
            logger.warn('trends-news: redis set failed', {
                component: COMPONENT,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return payload;
}
