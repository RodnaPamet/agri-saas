/**
 * Trends — the market price chart and the news feed.
 *
 * Тенденции is one of five tabs on the phone, and until now neither of its two
 * routes was in the spec at all. The native client modelled `PriceSeries`,
 * `PricePoint`, `PricesResponse` and `NewsItem` by MEASURING live responses,
 * which is the state that cost it a whole money screen elsewhere: a struct
 * declared non-optional against a field the server may omit takes out the entire
 * payload, because these are arrays and one bad element fails all of them.
 *
 * ── the query schemas are the ROUTES' own ──
 *
 * `TrendPricesQuerySchema` and `TrendNewsQuerySchema` are imported from
 * `@/app-layer/schemas/trends.schemas`, which is what the handlers `.parse()`
 * with. So the documented parameters cannot drift from the validated ones —
 * they are the same object. That also carries the enums for free: `commodity`
 * is `TREND_CHARTABLE` (crops the farm sells PLUS inputs it buys) and
 * `category` is `NEWS_CATEGORIES` plus the `all` sentinel.
 *
 * ── three date fields, and they are NOT the same format ──
 *
 * Verified at the producer, not from the comments beside them:
 *
 *   TrendPoint.date            .toISOString().slice(0, 10)   -> date      (a DAY)
 *   TrendSeries.lastObservedAt .toISOString().slice(0, 10)   -> date      (a DAY)
 *   TrendPricesResponse.generatedAt  new Date().toISOString() -> date-time
 *   NewsItem.publishedAt       r.publishedAt.toISOString()    -> date-time
 *
 * A client that parses the first two as instants throws on a correct response.
 * This is the third payload in this spec carrying both formats at once, so it
 * is worth stating as a rule rather than a note: in this codebase a date-ish
 * string is a DAY whenever it came through `.slice(0, 10)`, and the only way to
 * know is to read the line that built it.
 *
 * ── why `lastObservedAt` exists, since a client must use it ──
 *
 * It is the newest observation ANYWHERE, not the newest point inside the
 * requested range. Without it a series that reported this week and one that
 * stopped reporting in March are indistinguishable — both hand back a `points`
 * array whose last entry looks equally current. Staleness is
 * `generatedAt − lastObservedAt` and must be computed against the SERVER's
 * clock, because the payload is Redis-cached for 6h and a rural device can be
 * hours off.
 */
import { z } from '@/lib/openapi/zod';
import {
    TrendPricesQuerySchema,
    TrendNewsQuerySchema,
} from '@/app-layer/schemas/trends.schemas';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const TrendPointSchema = z
    .object({
        /** A DAY, `yyyy-mm-dd` — the producer slices the instant off. */
        date: z.string().date(),
        price: z.number(),
        /**
         * Distinct-tenant sample size, and ONLY on the listings-derived
         * series. Absent on feed series, which is a different claim from
         * zero: a feed price is not a sample of anything.
         */
        count: z.number().optional(),
    })
    .openapi('TrendPoint', {
        description:
            'One observation. `date` is a calendar day, not an instant. `count` appears only on listings-derived series, where it is the distinct-tenant sample size — its absence means the series is not sampled, not that the sample was zero.',
    });

const TrendSeriesSchema = z
    .object({
        source: z.string(),
        region: z.string(),
        stage: z.string().nullable(),
        unit: z.string(),
        currency: z.string(),
        label: z.string().nullable(),
        /**
         * Newest observation ANYWHERE, not the newest point in this range.
         * A DAY. Null when the series has never reported.
         */
        lastObservedAt: z.string().date().nullable(),
        points: z.array(TrendPointSchema),
    })
    .openapi('TrendSeries', {
        description:
            'One price line, grouped by (source, region) so a chart can split lines that differ in unit or currency — series are NOT comparable across those without conversion. lastObservedAt is the newest observation anywhere, which is what distinguishes a series reporting this week from one that stopped months ago; both otherwise present a points array whose last entry looks equally current.',
    });

const TrendPricesResponseSchema = z
    .object({
        commodity: z.string(),
        range: z.enum(['1m', '3m', '1y', 'all']),
        /** ISO instant, from the SERVER's clock — see the module note. */
        generatedAt: z.string().datetime(),
        series: z.array(TrendSeriesSchema),
    })
    .openapi('TrendPricesResponse', {
        description:
            'Market price series for one commodity, grouped by source and region. Staleness is generatedAt minus a series’ lastObservedAt and must be computed against generatedAt rather than the device clock — the payload is cached for 6h and a rural device may be hours off.',
    });

const NewsItemSchema = z
    .object({
        id: z.string(),
        /** Origin feed slug. */
        source: z.string(),
        category: z.string(),
        title: z.string(),
        summary: z.string().nullable(),
        url: z.string(),
        imageUrl: z.string().nullable(),
        /** A full ISO instant. */
        publishedAt: z.string().datetime(),
    })
    .openapi('NewsItem', {
        description:
            'One aggregated agri-news article. summary and imageUrl are genuinely nullable — many feeds carry neither — so a client must render a headline-only item rather than treating it as malformed.',
    });

const TrendNewsResponseSchema = z
    .object({
        /** Echoes the requested filter; `all` when unfiltered. */
        category: z.string(),
        items: z.array(NewsItemSchema),
    })
    .openapi('TrendNewsResponse', {
        description:
            'The aggregated news feed, newest first. category echoes the filter that produced it, so a client can tell a stale response from the one it asked for.',
    });

export function registerTrendsPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/trends/prices',
        operationId: 'getTrendPrices',
        summary: 'Market price series for one commodity',
        description:
            'The GLOBAL market-price series for one commodity, grouped by (source, region) so a chart can split lines that differ in unit or currency. The payload is tenant-AGNOSTIC — the tenant in the path authenticates the caller, it does not scope the data. ' +
            '\n\nLabels are localised to the READER’s own language column, not to a request cookie: a native client sends no `NEXT_LOCALE`, so a cookie-derived locale would hand the phone the unauthenticated `en` default. ' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**. The ETag is derived from the payload, which differs by language, so it varies by locale correctly — hashing the query alone would have served a cached 304 in the wrong language. Cached 6h server-side.',
        tags: ['Trends'],
        params: TenantParams,
        query: TrendPricesQuerySchema,
        success: {
            status: 200,
            description: 'The series. May be EMPTY for a commodity nothing has quoted yet.',
            schema: TrendPricesResponseSchema,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/trends/news',
        operationId: 'getTrendNews',
        summary: 'Aggregated agri-news feed',
        description:
            'The GLOBAL aggregated news feed, newest first, optionally filtered by category. Tenant-agnostic payload; the tenant in the path authenticates the caller. ' +
            '\n\nCarries a weak ETag; send `If-None-Match` and handle **304**. Cached 1h server-side.',
        tags: ['Trends'],
        params: TenantParams,
        query: TrendNewsQuerySchema,
        success: {
            status: 200,
            description: 'The feed, newest first.',
            schema: TrendNewsResponseSchema,
        },
    });
}
