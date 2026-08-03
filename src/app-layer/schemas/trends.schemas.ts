/**
 * Zod schemas for the market-price trends read API.
 *
 * @module app-layer/schemas/trends.schemas
 */
import { z } from 'zod';

/** Commodities the trends chart supports (matches the MarketPriceSeries slugs). */
export const TrendCommodity = z.enum(['wheat', 'maize', 'barley', 'sunflower']);
export type TrendCommodity = z.infer<typeof TrendCommodity>;

/** Time window the chart requests. */
export const TrendRange = z.enum(['1m', '3m', '1y', 'all']);
export type TrendRange = z.infer<typeof TrendRange>;

/** Query params for GET /api/t/[tenantSlug]/trends/prices. */
export const TrendPricesQuerySchema = z.object({
    commodity: TrendCommodity,
    range: TrendRange.default('1y'),
});
export type TrendPricesQuery = z.infer<typeof TrendPricesQuerySchema>;

/** Number of days each range window looks back (`all` → null = unbounded). */
export const RANGE_LOOKBACK_DAYS: Record<TrendRange, number | null> = {
    '1m': 31,
    '3m': 93,
    '1y': 366,
    all: null,
};

/**
 * Query params for GET /api/t/[tenantSlug]/trends/news.
 * `cursor` is the id of the last item on the previous page (opaque to the
 * client) — newest-first keyset pagination. Bounded/optional.
 */
export const TrendNewsQuerySchema = z.object({
    cursor: z.string().min(1).max(64).optional(),
});
export type TrendNewsQuery = z.infer<typeof TrendNewsQuerySchema>;

/** Page size for the news feed read. */
export const NEWS_PAGE_SIZE = 20;
