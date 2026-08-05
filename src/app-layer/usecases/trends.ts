/**
 * Market-price trends read usecase.
 *
 * Serves the GLOBAL MarketPriceSeries/Point cache grouped by (source, region)
 * so the chart can split lines by unit/currency (a BGN listings median and a
 * EUR EC cereal price must never share a Y axis). The response is Redis-cached
 * per (commodity, range) for 6h — the underlying data only refreshes weekly /
 * daily — and degrades to a live DB read on any Redis miss or hiccup.
 *
 * The data is tenant-agnostic (no tenantId), so the caller authenticates as a
 * tenant member but the payload is identical for every tenant.
 *
 * @module app-layer/usecases/trends
 */
import prisma from '@/lib/prisma';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/observability/logger';
import type { MarketReference } from '@/lib/market/contract-benchmark';
import {
    RANGE_LOOKBACK_DAYS,
    type TrendCommodity,
    type TrendRange,
    type NewsCategory,
} from '@/app-layer/schemas/trends.schemas';

const CACHE_TTL_SECONDS = 21_600; // 6h — data refreshes weekly/daily
const NEWS_CACHE_TTL_SECONDS = 3_600; // 1h — the news pull runs daily
const MAX_SERIES = 100;
const MAX_POINTS_PER_SERIES = 1000;
const MAX_NEWS = 100;
const COMPONENT = 'trends';
/** Source slugs eligible to benchmark an owned price. */
const SOURCE_EC_AGRIFOOD = 'ec-agrifood';
const SOURCE_ALPHA_VANTAGE = 'alpha-vantage';
/** Every range the read caches under — the invalidation key space. */
const TREND_RANGES = ['1m', '3m', '1y', 'all'] as const;

export interface TrendPoint {
    date: string; // yyyy-mm-dd
    price: number;
    /** Distinct-tenant sample size (listings series only). */
    count?: number;
}

export interface TrendSeries {
    source: string;
    region: string;
    stage: string | null;
    unit: string;
    currency: string;
    label: string | null;
    /**
     * Date of the series' most recent observation ANYWHERE (yyyy-mm-dd), not
     * merely the newest point inside the requested range. Without it the
     * client cannot tell a series that reported this week from one that
     * stopped reporting in March: both hand back a `points` array whose last
     * entry looks equally current. The UI needs it for "as of {date}" and for
     * the stale warning.
     */
    lastObservedAt: string | null;
    points: TrendPoint[];
}

export interface TrendPricesResponse {
    commodity: TrendCommodity;
    range: TrendRange;
    /**
     * When this payload was computed (ISO instant). Staleness is
     * `generatedAt − lastObservedAt`, and it must be computed against the
     * SERVER's clock: the response is Redis-cached for 6h and a rural device
     * can be hours off, so deriving "how old is this" from the browser clock
     * would silently mis-state it.
     */
    generatedAt: string;
    series: TrendSeries[];
}

function cutoffFor(range: TrendRange): Date | null {
    const days = RANGE_LOOKBACK_DAYS[range];
    if (days == null) return null;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d;
}

async function readFromDb(
    commodity: TrendCommodity,
    range: TrendRange,
): Promise<TrendPricesResponse> {
    const cutoff = cutoffFor(range);
    const series = await prisma.marketPriceSeries.findMany({
        where: { commodity },
        take: MAX_SERIES,
        orderBy: [{ source: 'asc' }, { region: 'asc' }, { stage: 'asc' }],
        include: {
            points: {
                where: cutoff ? { date: { gte: cutoff } } : undefined,
                // NEWEST first, then reversed below. Ascending + `take` hands
                // back the OLDEST 1000 points, so on range='all' a series with
                // a long history had its headline frozen in the past — the
                // "latest" price the tiles read was whatever the cap happened
                // to stop at, potentially years old, presented as current.
                orderBy: { date: 'desc' },
                take: MAX_POINTS_PER_SERIES,
                select: { date: true, price: true, meta: true },
            },
        },
    });

    // Newest observation per series REGARDLESS of the range window. It cannot
    // ride along on the `points` include — that relation is already filtered to
    // the window, so on range='1m' the last in-window point would masquerade as
    // the series' latest. One grouped aggregate over the same bounded id set
    // instead of a per-series read (query-shape guardrail D1: no reads in a
    // loop).
    const seriesIds = series.map((s) => s.id);
    const lastDates = new Map<string, Date>();
    if (seriesIds.length > 0) {
        const grouped = await prisma.marketPricePoint.groupBy({
            by: ['seriesId'],
            where: { seriesId: { in: seriesIds } },
            _max: { date: true },
        });
        for (const g of grouped) {
            if (g._max.date) lastDates.set(g.seriesId, g._max.date);
        }
    }

    const mapped: TrendSeries[] = series
        .map((s) => ({
            source: s.source,
            region: s.region,
            stage: s.stage,
            unit: s.unit,
            currency: s.currency,
            label: s.label,
            lastObservedAt: lastDates.get(s.id)?.toISOString().slice(0, 10) ?? null,
            // Restore chronological order for the chart + the delta helpers,
            // which both assume points ascend.
            points: [...s.points].reverse().map((p) => {
                const count =
                    p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta)
                        ? (p.meta as Record<string, unknown>).count
                        : undefined;
                return {
                    date: p.date.toISOString().slice(0, 10),
                    price: Number(p.price),
                    ...(typeof count === 'number' ? { count } : {}),
                };
            }),
        }))
        .filter((s) => s.points.length > 0);

    return { commodity, range, generatedAt: new Date().toISOString(), series: mapped };
}

/** Read the price trends for one commodity + range, Redis-cached (6h). */
export async function getPriceTrends(
    commodity: TrendCommodity,
    range: TrendRange,
): Promise<TrendPricesResponse> {
    // v2: the payload gained `generatedAt` + per-series `lastObservedAt`. A
    // v1 entry deserialises without them, so the UI would render "as of
    // undefined" and treat every series as unjudgeable for up to the 6h TTL.
    // Bumping the version retires those entries instantly.
    const cacheKey = `trends:prices:v2:${commodity}:${range}`;
    const redis = getRedis();

    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached) as TrendPricesResponse;
        } catch {
            /* redis hiccup — fall through to a live DB read */
        }
    }

    const payload = await readFromDb(commodity, range);

    if (redis) {
        try {
            await redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
        } catch (err) {
            // Non-fatal — the response is already computed, just uncached.
            logger.warn('trends: redis set failed', {
                component: COMPONENT,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return payload;
}

// ── News ──────────────────────────────────────────────────────────────

export interface NewsItem {
    id: string;
    /** Origin feed slug. */
    source: string;
    /** 'market' | 'policy' | 'general'. */
    category: string;
    title: string;
    summary: string | null;
    url: string;
    imageUrl: string | null;
    /** ISO-8601 publish time. */
    publishedAt: string;
}

export interface TrendNewsResponse {
    /** The requested filter ('all' when unfiltered). */
    category: NewsCategory | 'all';
    items: NewsItem[];
}

async function readNewsFromDb(
    category: NewsCategory | 'all',
    limit: number,
): Promise<TrendNewsResponse> {
    const rows = await prisma.marketNewsItem.findMany({
        where: category === 'all' ? undefined : { category },
        take: Math.min(limit, MAX_NEWS),
        orderBy: { publishedAt: 'desc' },
        select: {
            id: true,
            source: true,
            category: true,
            title: true,
            summary: true,
            url: true,
            imageUrl: true,
            publishedAt: true,
        },
    });

    const items: NewsItem[] = rows.map((r) => ({
        id: r.id,
        source: r.source,
        category: r.category,
        title: r.title,
        summary: r.summary,
        url: r.url,
        imageUrl: r.imageUrl,
        publishedAt: r.publishedAt.toISOString(),
    }));

    return { category, items };
}

/**
 * Read the aggregated agri-news feed, optionally filtered by category, newest
 * first. Redis-cached per (category, limit) for 1h — the pull runs daily — and
 * degrades to a live DB read on any Redis miss/hiccup. Tenant-agnostic payload
 * (the MarketNewsItem cache carries no tenantId).
 */
export async function getMarketNews(
    category: NewsCategory | 'all',
    limit: number,
): Promise<TrendNewsResponse> {
    const cacheKey = `trends:news:v1:${category}:${limit}`;
    const redis = getRedis();

    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached) as TrendNewsResponse;
        } catch {
            /* redis hiccup — fall through to a live DB read */
        }
    }

    const payload = await readNewsFromDb(category, limit);

    if (redis) {
        try {
            await redis.set(cacheKey, JSON.stringify(payload), 'EX', NEWS_CACHE_TTL_SECONDS);
        } catch (err) {
            logger.warn('trends: news redis set failed', {
                component: COMPONENT,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return payload;
}

// ─── Cache invalidation ──────────────────────────────────────────────

/**
 * Drop the cached price payloads for the given commodities.
 *
 * Without this the 20-minute Barchart cron was pure waste. `schedules.ts`
 * runs it every 20 min on trading days for "near-real-time" data, the read
 * caches for 6h, and the pull performed no invalidation — so licensed
 * requests were spent writing rows that no reader would see for up to six
 * hours. The intraday feed was, in effect, a daily one.
 *
 * Invalidating beats a shorter TTL: a per-source TTL would have to be the
 * MINIMUM across sources touching a commodity, which would drop the weekly
 * EC data to the intraday cadence and multiply cold reads for no gain.
 *
 * Best-effort by construction. A Redis hiccup here means a reader sees data
 * up to one TTL old — exactly the status quo, never an error, and never a
 * reason to fail a pull whose rows are already committed.
 */
export async function invalidatePriceTrendsCache(
    commodities: readonly string[],
): Promise<number> {
    const redis = getRedis();
    if (!redis) return 0;
    const wanted = [...new Set(commodities.filter(Boolean))];
    if (wanted.length === 0) return 0;

    // Enumerated rather than SCAN/KEYS: the key space is
    // (commodity x range) and both are small closed sets, so the exact list
    // is cheap to build and carries none of the production hazards of a
    // pattern scan on a shared Redis.
    const keys = wanted.flatMap((c) => TREND_RANGES.map((r) => `trends:prices:v2:${c}:${r}`));
    try {
        await redis.del(...keys);
        return keys.length;
    } catch (err) {
        logger.warn('trends: cache invalidation failed', {
            component: COMPONENT,
            keys: keys.length,
            detail: err instanceof Error ? err.message : String(err),
        });
        return 0;
    }
}

// ─── Market references for cross-surface comparison ──────────────────

/**
 * Latest market price per commodity, for benchmarking OWNED numbers against.
 *
 * This is the read that ends Trends' isolation. Nothing outside the trends
 * components consumed market prices, so the product could show a farmer what
 * wheat costs and, on the next screen, a wheat contract — and never put the
 * two in the same sentence. `Contract.commodityCanonical` gave them a join
 * key; this gives them a value.
 *
 * Preference order per commodity is deliberate and matches what the Prices
 * tab treats as the headline: the official EC quote first, then the
 * reference benchmark. **The own-listings median is excluded** — it is the
 * median asking price on our own noticeboard, so benchmarking a farmer's
 * contract against it would be telling them how they compare to their
 * neighbours' hopes and calling it the market.
 *
 * Global data, no tenant scope. Bounded by the caller's commodity list.
 */
export async function getMarketReferences(
    commodities: readonly string[],
): Promise<Map<string, MarketReference>> {
    const wanted = [...new Set(commodities.filter(Boolean))];
    if (wanted.length === 0) return new Map();

    const series = await prisma.marketPriceSeries.findMany({
        where: {
            commodity: { in: wanted },
            // Never benchmark against our own noticeboard — see above.
            source: { in: [SOURCE_EC_AGRIFOOD, SOURCE_ALPHA_VANTAGE] },
        },
        take: MAX_SERIES,
        select: {
            commodity: true,
            source: true,
            currency: true,
            unit: true,
            points: { orderBy: { date: 'desc' }, take: 1, select: { date: true, price: true } },
        },
    });

    const byCommodity = new Map<string, MarketReference>();
    for (const s of series) {
        const latest = s.points[0];
        if (!latest) continue;
        // Per-tonne only. A per-bushel quote is a different base, and the
        // no-conversion invariant forbids making it look like the same one.
        if (!/\/t$/i.test(s.unit)) continue;

        const candidate: MarketReference = {
            commodity: s.commodity as MarketReference['commodity'],
            pricePerTonne: Number(latest.price),
            currency: s.currency,
            observedAt: latest.date.toISOString().slice(0, 10),
            source: s.source,
        };
        const existing = byCommodity.get(s.commodity);
        // EC wins over Alpha Vantage; among equals, the fresher observation.
        const better =
            !existing ||
            (existing.source !== SOURCE_EC_AGRIFOOD && candidate.source === SOURCE_EC_AGRIFOOD) ||
            (existing.source === candidate.source && candidate.observedAt > existing.observedAt);
        if (better) byCommodity.set(s.commodity, candidate);
    }
    return byCommodity;
}
