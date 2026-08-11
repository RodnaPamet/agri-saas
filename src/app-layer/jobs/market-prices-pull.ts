/**
 * market-prices-pull — pull market-price series into the GLOBAL price cache.
 *
 * Three independent sources, each selectable via `payload.source` (omit → all):
 *
 *   • 'ec'       — EC AGRI-food weekly cereal (wheat/maize/barley) + oilseed
 *                  (sunflower) prices. Cereals are EUR; oilseeds carry the
 *                  member state's national currency (BG→BGN, RO→RON). Records
 *                  for the same (region, stage, week) across markets are
 *                  averaged into one point.
 *   • 'av'       — Alpha Vantage global reference series (WHEAT→wheat,
 *                  CORN→maize), USD/GLOBAL. Skipped when ALPHA_VANTAGE_API_KEY
 *                  is unset. Respects the 25 req/day free budget (2 requests)
 *                  with linear backoff on a rate-limit signal.
 *   • 'listings' — k-anonymised WEEKLY median over ALL tenants' ACTIVE
 *                  ExchangeListings (≥3 distinct tenants per group). See
 *                  src/lib/market/listings-index.ts.
 *
 * These GLOBAL cache tables carry no tenantId and no RLS (like SoilSample), so
 * the ordinary `prisma` singleton — which runs as the DB superuser and matches
 * the `superuser_bypass` policy — reads every tenant's ACTIVE listings and
 * writes the shared cache directly. No per-tenant context is needed.
 *
 * All writes are idempotent: series resolve on the SIX-column natural key
 * (source, commodity, region, stage, currency, unit); points upsert on
 * (seriesId, date). A re-run never duplicates a row. Currency and unit are
 * part of that key deliberately — see the note on `seriesKey` below.
 *
 * @module jobs/market-prices-pull
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import {
    fetchCerealPrices,
    fetchOilseedPrices,
    CEREAL_PRODUCT_CODES,
    type EcObservation,
    type EcFetchOptions,
} from '@/lib/market/ec-agrifood-client';
import {
    fetchAlphaVantageCommodity,
    AlphaVantageRateLimitError,
    ALPHA_VANTAGE_FUNCTIONS,
    type AlphaVantageFetchOptions,
} from '@/lib/market/alpha-vantage-client';
import {
    fetchBarchartQuotes,
    BarchartRateLimitError,
    BARCHART_CONTRACTS,
} from '@/lib/market/barchart-client';
import {
    fetchDieselPrices,
    OilBulletinRateLimitError,
    type DieselObservation,
} from '@/lib/market/oil-bulletin-client';
import { computeListingsMedianIndex, type ListingPriceRow } from '@/lib/market/listings-index';
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';
import { invalidatePriceTrendsCache } from '@/app-layer/usecases/trends';
import type { MarketPricesPullPayload } from './types';

const COMPONENT = 'market-prices-pull';

/** EC member states we pull (each becomes its own region series). */
const EC_MEMBER_STATES = ['BG', 'RO', 'EL', 'EU'];
/** Bounded scan caps. */
const MAX_SERIES = 2000;
const MAX_LISTINGS = 5000;
/** Alpha Vantage: max attempts per commodity before giving up (25/day budget). */
const AV_MAX_ATTEMPTS = 3;

export interface MarketPricesPullResult {
    sources: string[];
    seriesTouched: number;
    pointsUpserted: number;
    listingsScanned: number;
    suppressed: number;
}

/** The Prisma delegates this job touches (global cache tables + listings). */
type MarketDbClient = Pick<
    PrismaClient,
    'marketPriceSeries' | 'marketPricePoint' | 'exchangeListing'
>;

/** Injectable seams so tests can drive the pull without real network / prod DB. */
export interface MarketPricesPullDeps {
    fetchCereal?: typeof fetchCerealPrices;
    fetchOilseed?: typeof fetchOilseedPrices;
    fetchAv?: typeof fetchAlphaVantageCommodity;
    fetchBarchart?: typeof fetchBarchartQuotes;
    fetchDiesel?: typeof fetchDieselPrices;
    /** DB client override (integration tests pass the test-DB client). */
    db?: MarketDbClient;
    /** Sleep (ms) — no-op in tests. */
    sleep?: (ms: number) => Promise<void>;
}

/** One normalised item to persist (a point on an implied series). */
interface UpsertItem {
    source: string;
    commodity: string;
    region: string;
    stage: string | null;
    unit: string;
    currency: string;
    label: string | null;
    date: Date;
    price: number;
    meta?: Prisma.InputJsonValue;
}

// ── date helpers ──────────────────────────────────────────────────────

/** Parse EC "dd/mm/yyyy" → UTC date-only, or null. */
function parseDdmmyyyy(s: string): Date | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? '').trim());
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse "yyyy-mm-dd..." → UTC date-only, or null. */
function parseIsoDate(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((s ?? '').trim());
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Monday (UTC) of the week containing `date`. */
function startOfIsoWeek(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const delta = dow === 0 ? -6 : 1 - dow; // shift back to Monday
    d.setUTCDate(d.getUTCDate() + delta);
    return d;
}

/**
 * Series identity — INCLUDING currency and unit.
 *
 * They used to be excluded, and `unit`/`currency` were written only on
 * create. So when an upstream feed changed denomination, the new values
 * landed as points on the OLD series, under the old label, with no error
 * anywhere: a BGN price displayed as EUR, mixed into a EUR history, on one
 * axis. That is not hypothetical — it happened, and was remediated by
 * hand-written SQL (docs/implementation-notes/2026-07-15-…flat-series.md).
 *
 * Putting them in the key means a denomination change MINTS A NEW SERIES
 * instead. The old points keep their old currency and their old label, which
 * is what they are; the new ones start a clean line. The alternative —
 * updating the series in place — would relabel history as something it never
 * was, which is the same defect wearing a warning log.
 */
function seriesKey(
    source: string,
    commodity: string,
    region: string,
    stage: string | null,
    currency: string,
    unit: string,
): string {
    // A JSON array keeps a genuine null stage distinct from an empty string.
    return JSON.stringify([source, commodity, region, stage, currency, unit]);
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

// ── persistence ───────────────────────────────────────────────────────

/**
 * Idempotently upsert a batch of items. Pre-aggregates duplicate
 * (series, date) tuples by AVERAGING their prices so the write order never
 * changes the stored value. Series are resolved through a pre-loaded map so
 * there is no per-item read (N+1-free). Returns counts.
 */
async function persistItems(
    items: UpsertItem[],
    seriesMap: Map<string, string>,
    db: MarketDbClient,
): Promise<{ seriesTouched: number; pointsUpserted: number }> {
    // Aggregate by (series, date).
    interface Agg extends UpsertItem {
        prices: number[];
    }
    const byPoint = new Map<string, Agg>();
    for (const it of items) {
        const k = `${seriesKey(it.source, it.commodity, it.region, it.stage, it.currency, it.unit)}|${dayKey(it.date)}`;
        const existing = byPoint.get(k);
        if (existing) {
            existing.prices.push(it.price);
        } else {
            byPoint.set(k, { ...it, prices: [it.price] });
        }
    }

    const touchedSeries = new Set<string>();
    let pointsUpserted = 0;

    for (const agg of byPoint.values()) {
        const key = seriesKey(agg.source, agg.commodity, agg.region, agg.stage, agg.currency, agg.unit);
        let seriesId = seriesMap.get(key);
        if (!seriesId) {
            // Create the series (a WRITE — not a read-in-loop; N+1 rule is
            // about reads). The prefetched map means we never findFirst here.
            const created = await db.marketPriceSeries.create({
                data: {
                    source: agg.source,
                    commodity: agg.commodity,
                    region: agg.region,
                    stage: agg.stage,
                    label: agg.label,
                    unit: agg.unit,
                    currency: agg.currency,
                },
                select: { id: true },
            });
            seriesId = created.id;
            seriesMap.set(key, seriesId);
        }
        touchedSeries.add(seriesId);

        const mean = agg.prices.reduce((a, b) => a + b, 0) / agg.prices.length;
        const price = new Prisma.Decimal(Math.round(mean * 100) / 100);
        await db.marketPricePoint.upsert({
            where: { seriesId_date: { seriesId, date: agg.date } },
            create: { seriesId, date: agg.date, price, meta: agg.meta ?? Prisma.JsonNull },
            update: { price, meta: agg.meta ?? Prisma.JsonNull },
        });
        pointsUpserted += 1;
    }

    return { seriesTouched: touchedSeries.size, pointsUpserted };
}

// ── EC AGRI-food ──────────────────────────────────────────────────────

function ecFetchOpts(): EcFetchOptions {
    return env.EC_AGRIFOOD_BASE_URL ? { baseUrl: env.EC_AGRIFOOD_BASE_URL } : {};
}

function ecObservationsToItems(
    source: string,
    commodity: string,
    obs: EcObservation[],
): UpsertItem[] {
    const items: UpsertItem[] = [];
    for (const o of obs) {
        if (o.price == null) continue;
        const date = parseDdmmyyyy(o.beginDate);
        if (!date || !o.memberStateCode) continue;
        items.push({
            source,
            commodity,
            region: o.memberStateCode,
            stage: o.stage,
            unit: o.unit,
            currency: o.currency,
            label: o.productName || null,
            date,
            price: o.price,
        });
    }
    return items;
}

async function pullEc(
    years: number[],
    deps: MarketPricesPullDeps,
): Promise<UpsertItem[]> {
    const fetchCereal = deps.fetchCereal ?? fetchCerealPrices;
    const fetchOilseed = deps.fetchOilseed ?? fetchOilseedPrices;
    const opts = ecFetchOpts();
    const items: UpsertItem[] = [];

    // Cereals — one request per commodity so records map unambiguously to a
    // slug (the response carries productName, not a product code).
    for (const [slug, code] of Object.entries(CEREAL_PRODUCT_CODES)) {
        try {
            const obs = await fetchCereal(
                { memberStateCodes: EC_MEMBER_STATES, productCodes: [code], years },
                opts,
            );
            items.push(...ecObservationsToItems('ec-agrifood', slug, obs));
        } catch (err) {
            logger.warn('market-prices-pull: EC cereal fetch failed', {
                component: COMPONENT,
                commodity: slug,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Oilseeds — sunflower lives here (different record keys, dot decimals).
    try {
        const obs = await fetchOilseed({ memberStateCodes: EC_MEMBER_STATES, years }, opts);
        const sunflower = obs.filter((o) => o.productName === 'Sunflower seed');
        items.push(...ecObservationsToItems('ec-agrifood', 'sunflower', sunflower));
    } catch (err) {
        logger.warn('market-prices-pull: EC oilseed fetch failed', {
            component: COMPONENT,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return items;
}

// ── Alpha Vantage ─────────────────────────────────────────────────────

async function pullAlphaVantage(deps: MarketPricesPullDeps): Promise<UpsertItem[]> {
    const apiKey = env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
        logger.info('market-prices-pull: Alpha Vantage skipped (no API key)', {
            component: COMPONENT,
        });
        return [];
    }
    const fetchAv = deps.fetchAv ?? fetchAlphaVantageCommodity;
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const avOpts: AlphaVantageFetchOptions = {};
    const items: UpsertItem[] = [];

    for (const [func, slug] of Object.entries(ALPHA_VANTAGE_FUNCTIONS) as Array<
        ['WHEAT' | 'CORN', string]
    >) {
        let attempt = 0;
        // Linear backoff on a rate-limit signal, capped by the 25/day budget.
        for (;;) {
            attempt += 1;
            try {
                const series = await fetchAv(func, apiKey, avOpts);
                for (const o of series.observations) {
                    if (o.value == null) continue;
                    const date = parseIsoDate(o.date);
                    if (!date) continue;
                    items.push({
                        source: 'alpha-vantage',
                        commodity: slug,
                        region: 'GLOBAL',
                        stage: null,
                        unit: series.unit,
                        currency: series.currency,
                        label: 'Reference (Alpha Vantage)',
                        date,
                        price: o.value,
                    });
                }
                break;
            } catch (err) {
                if (err instanceof AlphaVantageRateLimitError && attempt < AV_MAX_ATTEMPTS) {
                    await sleep(attempt * 1000); // linear backoff 1s, 2s
                    continue;
                }
                logger.warn('market-prices-pull: Alpha Vantage fetch failed', {
                    component: COMPONENT,
                    commodity: slug,
                    error: err instanceof Error ? err.message : String(err),
                });
                break;
            }
        }
    }
    return items;
}

// ── Barchart OnDemand (delayed futures — MATIF benchmark) ─────────────

/** UTC midnight of a date — the day-key for a delayed intraday quote. */
function startOfUtcDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function pullBarchart(deps: MarketPricesPullDeps): Promise<UpsertItem[]> {
    const apiKey = env.BARCHART_API_KEY;
    if (!apiKey) {
        logger.info('market-prices-pull: Barchart skipped (no API key)', {
            component: COMPONENT,
        });
        return [];
    }
    const fetchBarchart = deps.fetchBarchart ?? fetchBarchartQuotes;
    const symbols = BARCHART_CONTRACTS.map((c) => c.symbol);
    // Match a resolved quote symbol (e.g. "MLU26") back to its contract by the
    // root the request used ("ML*0" → root "ML"); roots in the set are distinct.
    const contractsByRoot = BARCHART_CONTRACTS.map((c) => ({
        root: c.symbol.replace(/\*0$/, '').toUpperCase(),
        contract: c,
    }));

    const items: UpsertItem[] = [];
    try {
        const quotes = await fetchBarchart(symbols, apiKey, {});
        const day = startOfUtcDay(new Date());
        for (const q of quotes) {
            if (q.lastPrice == null) continue;
            const match = contractsByRoot.find(({ root }) => q.symbol.startsWith(root));
            if (!match) continue;
            const c = match.contract;
            items.push({
                source: 'barchart',
                commodity: c.commodity,
                region: c.region,
                stage: null,
                unit: c.unit,
                currency: c.currency,
                label: q.name ?? 'Futures (Barchart, delayed)',
                // A delayed intraday quote → today's point; a same-day re-pull
                // upserts on (seriesId, date), so the point holds the latest tick.
                date: day,
                price: q.lastPrice,
            });
        }
    } catch (err) {
        // Rate-limit and any other failure are non-fatal — the other sources
        // (and the last-good Barchart points) stand.
        const rateLimited = err instanceof BarchartRateLimitError;
        logger.warn('market-prices-pull: Barchart fetch failed', {
            component: COMPONENT,
            rateLimited,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return items;
}

// ── EC Weekly Oil Bulletin (road diesel) ──────────────────────────────

/**
 * Pull Bulgarian (+RO/EL/EU) road-diesel prices, both tax stages.
 *
 * There is NO API KEY to skip on — the bulletin is CC BY 4.0 and keyless — so
 * this follows the EC-AGRI-food shape (always on, optional base-URL override)
 * rather than the Alpha Vantage shape (`if (!env.X_API_KEY) return []`). The
 * roadmap asked for a "skip cleanly when unconfigured" path; there is nothing
 * to be unconfigured, and inventing a feature flag to satisfy the sentence
 * would add an operator switch that only ever hides a working feed.
 *
 * What CAN go wrong is upstream: a 429, or a 404 if a document node moves.
 * Both are caught here so one bad feed never takes down the other sources in
 * the same run — the same containment `pullAlphaVantage` uses — but they are
 * logged at WARN with the reason, never swallowed silently.
 */
async function pullOilBulletin(deps: MarketPricesPullDeps): Promise<UpsertItem[]> {
    const fetchDiesel = deps.fetchDiesel ?? fetchDieselPrices;
    let observations: DieselObservation[];
    try {
        observations = await fetchDiesel(
            env.EC_OIL_BULLETIN_WITH_TAX_URL || env.EC_OIL_BULLETIN_WITHOUT_TAX_URL
                ? {
                      ...(env.EC_OIL_BULLETIN_WITH_TAX_URL
                          ? { withTaxUrl: env.EC_OIL_BULLETIN_WITH_TAX_URL }
                          : {}),
                      ...(env.EC_OIL_BULLETIN_WITHOUT_TAX_URL
                          ? { withoutTaxUrl: env.EC_OIL_BULLETIN_WITHOUT_TAX_URL }
                          : {}),
                  }
                : {},
        );
    } catch (err) {
        const rateLimited = err instanceof OilBulletinRateLimitError;
        logger.warn('market_prices.oil_bulletin_failed', {
            component: 'market-prices-pull',
            rateLimited,
            retryAfterSeconds: rateLimited ? err.retryAfterSeconds : undefined,
            error: (err as Error).message,
        });
        return [];
    }

    return observations.map((o) => ({
        source: 'oil-bulletin',
        commodity: 'diesel',
        region: o.region,
        // with-tax / without-tax are the SAME series in every other respect,
        // so without this discriminator they collide on the natural key and
        // silently overwrite each other per date.
        stage: o.stage,
        // Stored exactly as reported. EUR/1000l deliberately does not match
        // the /\/t$/i filter in getMarketReferences, so diesel can never be
        // used to benchmark a grain contract.
        unit: o.unit,
        currency: o.currency,
        label: o.label,
        date: o.date,
        price: o.price,
    }));
}

// ── own-listings k-anon median ────────────────────────────────────────

async function pullListings(
    db: MarketDbClient,
): Promise<{ items: UpsertItem[]; scanned: number; suppressed: number }> {
    // Cross-tenant read: ExchangeListing is a GLOBAL table (no tenantId / no
    // RLS), so the ordinary superuser client sees every tenant's ACTIVE rows.
    //
    // The predicate is narrow on purpose. It used to be `status: 'ACTIVE'` plus
    // a non-null price and nothing else, which pooled three incompatible bases
    // into one "market price":
    //
    //   - side:  SELL and BUY share the model and the pricePerTonne column, so
    //            asks and BIDS were averaged together. They are opposite sides
    //            of a spread; their mean is a number describing nothing. Only
    //            asks are published, and the tile says "asking prices".
    //   - kind:  wheat SEED and feed wheat are both commodity 'Wheat'. Seed
    //            trades at a large multiple, so admitting non-CULTURE rows
    //            silently inflated the grain index.
    //   - expiry: the canonical browse read (repositories/exchange.ts) excludes
    //            past-expiry rows, so the index was computed from a SUPERSET of
    //            what the marketplace shows — a farmer could not reconcile the
    //            published median against any listing visible on the board.
    const listings = await db.exchangeListing.findMany({
        where: {
            status: 'ACTIVE',
            pricePerTonne: { not: null },
            side: 'SELL',
            kind: 'CULTURE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { commodity: true, pricePerTonne: true, priceCurrency: true, sellerTenantId: true },
        // Deterministic sample. With no orderBy, `take` handed back whatever
        // Postgres happened to scan first, so past MAX_LISTINGS the published
        // median was computed over an ARBITRARY sample that resampled week to
        // week — the index moved with nothing in the market changing. Ordering
        // by id makes the cut reproducible run-to-run.
        orderBy: { id: 'asc' },
        take: MAX_LISTINGS,
    });

    const rows: ListingPriceRow[] = listings.map((l) => ({
        commodity: l.commodity,
        pricePerTonne: Number(l.pricePerTonne),
        priceCurrency: l.priceCurrency,
        sellerTenantId: l.sellerTenantId,
    }));

    const groups = computeListingsMedianIndex(rows);
    // Suppressed = distinct (commodity,currency) groups that failed k-anon.
    // Counted over NORMALISED commodities so the figure matches what the
    // estimator actually grouped; counting raw spellings would report
    // 'Wheat' and 'wheat' as two suppressed groups that never existed.
    const totalGroups = new Set(
        rows
            .map((r) => {
                const c = normalizeCommodity(r.commodity);
                return c ? `${c}||${r.priceCurrency || 'BGN'}` : null;
            })
            .filter((k): k is string => k !== null),
    ).size;
    const suppressed = totalGroups - groups.length;

    // No silent caps: hitting MAX_LISTINGS means the median is computed over a
    // deterministic PREFIX of the market rather than all of it, and that has to
    // be visible rather than inferred from a suspiciously round scan count.
    if (listings.length === MAX_LISTINGS) {
        logger.warn('market-prices-pull: listings scan hit the cap', {
            component: COMPONENT,
            cap: MAX_LISTINGS,
            detail: 'index computed over the first MAX_LISTINGS rows by id — raise the cap or aggregate DB-side',
        });
    }

    const week = startOfIsoWeek(new Date());
    const items: UpsertItem[] = groups.map((g) => ({
        source: 'listings',
        commodity: g.commodity,
        region: 'BG',
        stage: null,
        unit: g.unit,
        currency: g.currency,
        label: 'Own-listings median',
        date: week,
        price: g.median,
        // Only the distinct-tenant count — never a listing id or tenant id.
        meta: { count: g.count } as Prisma.InputJsonValue,
    }));

    return { items, scanned: listings.length, suppressed };
}

// ── orchestration ─────────────────────────────────────────────────────

export async function runMarketPricesPull(
    payload: MarketPricesPullPayload = {},
    deps: MarketPricesPullDeps = {},
): Promise<MarketPricesPullResult> {
    const db = (deps.db ?? prisma) as MarketDbClient;
    const runAll = !payload.source;
    const sources: string[] = [];

    const now = new Date();
    const years = [now.getUTCFullYear() - 1, now.getUTCFullYear()];

    const items: UpsertItem[] = [];
    let listingsScanned = 0;
    let suppressed = 0;

    if (runAll || payload.source === 'ec') {
        sources.push('ec');
        items.push(...(await pullEc(years, deps)));
    }
    if (runAll || payload.source === 'av') {
        sources.push('av');
        items.push(...(await pullAlphaVantage(deps)));
    }
    if (runAll || payload.source === 'barchart') {
        sources.push('barchart');
        items.push(...(await pullBarchart(deps)));
    }
    if (runAll || payload.source === 'oil-bulletin') {
        sources.push('oil-bulletin');
        items.push(...(await pullOilBulletin(deps)));
    }
    if (runAll || payload.source === 'listings') {
        sources.push('listings');
        const r = await pullListings(db);
        items.push(...r.items);
        listingsScanned = r.scanned;
        suppressed = r.suppressed;
    }

    // Pre-load the series catalog ONCE (bounded) so persistItems never reads
    // per-item — keeps the write loop N+1-free.
    const existing = await db.marketPriceSeries.findMany({
        select: {
            id: true, source: true, commodity: true, region: true, stage: true,
            currency: true, unit: true,
        },
        take: MAX_SERIES,
    });
    const seriesMap = new Map<string, string>();
    for (const s of existing) {
        seriesMap.set(
            seriesKey(s.source, s.commodity, s.region, s.stage, s.currency, s.unit),
            s.id,
        );
    }

    const { seriesTouched, pointsUpserted } = await persistItems(items, seriesMap, db);

    // Drop the cached read payloads for whatever we just wrote. The 20-minute
    // Barchart cron was otherwise nullified by the 6h read cache: licensed
    // requests spent on rows no reader would see for hours.
    const touchedCommodities = [...new Set(items.map((i) => i.commodity))];
    const invalidated = await invalidatePriceTrendsCache(touchedCommodities);

    logger.info('market-prices-pull: complete', {
        component: COMPONENT,
        sources,
        seriesTouched,
        pointsUpserted,
        listingsScanned,
        suppressed,
        cacheKeysInvalidated: invalidated,
    });

    return { sources, seriesTouched, pointsUpserted, listingsScanned, suppressed };
}
