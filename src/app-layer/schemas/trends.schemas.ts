/**
 * Zod schemas for the market-price trends read API.
 *
 * @module app-layer/schemas/trends.schemas
 */
// `@/lib/openapi/zod`, not bare `zod`: this file adds `.openapi()` annotations
// (the news feed's query params carry their own descriptions), and that method
// only exists after `extendZodWithOpenApi` has run. The generator applies it,
// so the spec built fine — but a test importing this module DIRECTLY got the
// unextended `z` and died with `.openapi is not a function`. Same convention
// as `catalog.schemas.ts` and `parcel-history.schemas.ts`.
import { z } from '@/lib/openapi/zod';

import { NEWS_CATEGORIES } from '@/lib/news/categorize';
import { INPUT_COMMODITIES } from '@/lib/market/commodity-vocabulary';
import { ALL_NEWS_TAGS } from '@/lib/news/categorize';

/**
 * Crops with a price feed behind them.
 *
 * A SUBSET of `CANONICAL_COMMODITIES`, not all of it: the exchange can name
 * ten crops but only four are quoted by the EC / Alpha Vantage / Barchart
 * feeds, and offering a picker entry that can only ever draw an empty chart
 * reads as a broken page.
 */
export const TREND_CROPS = ['wheat', 'maize', 'barley', 'sunflower'] as const;

/**
 * Everything the trends chart can be asked for — crops the farm sells AND
 * inputs it buys.
 *
 * Built from `INPUT_COMMODITIES` rather than restated, so adding an input to
 * the vocabulary makes it requestable here without a second edit that someone
 * has to remember. Widening this is what lets Trends serve fuel and
 * fertiliser at all: the query schema below is enum-validated, so before this
 * `?commodity=diesel` was a 400.
 *
 * Widening it does NOT put diesel in front of a farmer by accident.
 * `firstInterestedCommodity` — the only thing that picks a commodity on the
 * user's behalf — resolves interest keywords through the crop-only
 * `normalizeCommodity`, so an interest in `дизел` still returns null.
 */
export const TREND_CHARTABLE = [...TREND_CROPS, ...INPUT_COMMODITIES] as const;

/** Commodities the trends chart supports (matches the MarketPriceSeries slugs). */
export const TrendCommodity = z.enum(TREND_CHARTABLE);
export type TrendCommodity = z.infer<typeof TrendCommodity>;

/** News category buckets (single source of truth: src/lib/news/categorize.ts). */
export const NewsCategory = z.enum(NEWS_CATEGORIES);
export type NewsCategory = z.infer<typeof NewsCategory>;

/**
 * Query params for GET /api/t/[tenantSlug]/trends/news. `category` accepts a
 * bucket or the sentinel 'all' (default) which means no filter; `limit` is
 * bounded so a client can never ask for an unbounded scan.
 */
/**
 * Comma-separated tag keys, ANY-OF, with UNRECOGNISED KEYS DROPPED.
 *
 * Dropping rather than 400ing is the contract's rule and the reason is the
 * caller: a client passes its STORED preferences straight into this
 * parameter, so a tag the server has since renamed would otherwise turn a
 * saved preference into a broken feed. That is deliberately the opposite of
 * `PUT /api/me/news-preferences`, which does 400 — there a person is
 * choosing, and a typo is a client bug worth surfacing. Reject unknown on
 * write, ignore unknown on read.
 *
 * If EVERY key is unrecognised the result is an empty list, which the usecase
 * treats as UNFILTERED rather than as "match nothing". The response echoes
 * the tags actually applied, which is how a client discovers that happened
 * instead of inferring a server fault from a suspiciously full feed.
 *
 * Sorted and de-duplicated here rather than at the cache key, so the echo, the
 * query and the key all see one canonical list — `wheat,barley` and
 * `barley,wheat,wheat` are the same request.
 */
const NewsTagsParam = z
    .string()
    .max(400)
    .openapi({
        description:
            'Comma-separated tag keys from `GET /trends/news/tags`, matched ANY-OF. Keys the server does not recognise are DROPPED, not rejected — read the `tags` echo in the response to see which were applied. All keys unrecognised means an UNFILTERED feed, not an empty one.',
        example: 'wheat,subsidies',
    })
    .optional()
    .transform((raw) => {
        if (!raw) return [] as string[];
        const known = new Set(ALL_NEWS_TAGS);
        return [
            ...new Set(
                raw
                    .split(',')
                    .map((t) => t.trim())
                    .filter((t) => t.length > 0 && known.has(t)),
            ),
        ].sort();
    });

export const TrendNewsQuerySchema = z.object({
    category: z.union([NewsCategory, z.literal('all')]).default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    tags: NewsTagsParam,
    /**
     * Free-text search over `title` + `summary`, case-insensitive.
     *
     * Bounded at 200 characters because it reaches a `contains` over every
     * stored row; an unbounded term is an unbounded scan. `min(1)` after the
     * trim so `?q=%20` is a missing filter rather than a search for a space,
     * which would match every article and read as "search is broken".
     */
    q: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .openapi({
            description:
                'Case-insensitive search over title and summary, across at most the last 60 days of articles. Bypasses the server cache, so prefer the ETag.',
            example: 'пшеница',
        })
        .optional(),
    /** Opaque keyset cursor from a previous `nextCursor`. Passed back verbatim. */
    cursor: z
        .string()
        .max(200)
        .openapi({
            description:
                'A `nextCursor` from a previous page, passed back verbatim. Opaque — do not parse or construct one. An unrecognised or stale cursor is ignored and you get the first page.',
        })
        .optional(),
});
export type TrendNewsQuery = z.infer<typeof TrendNewsQuerySchema>;

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
