/**
 * Pure, DOM-free helpers for the Trends "Prices" tab.
 *
 * The `/trends/prices` payload arrives as a flat list of series, each grouped
 * by (source, region) and carrying its OWN `unit` + `currency` (EC = EUR/t,
 * BG oilseeds = BGN/т, Alpha Vantage = USD, listings = BGN). A EUR cereal
 * price and a BGN listings median must NEVER share a Y axis — so the tab
 * renders ONE chart per unit-group. These helpers do that grouping + the
 * TimeSeriesChart data assembly + the stat-tile derivations, kept pure so
 * they're unit-testable without jsdom/visx layout.
 *
 * @module components/trends/trends-helpers
 */
import { normalizeCommodity } from '@/lib/market/commodity-vocabulary';
import { TrendCommodity } from '@/app-layer/schemas/trends.schemas';
import type {
    TrendPricesResponse,
    TrendSeries,
    TrendPoint,
} from '@/app-layer/usecases/trends';

export type { TrendPricesResponse, TrendSeries, TrendPoint };

/** Canonical source slugs the backend writes (see market-prices-pull.ts). */
export const SOURCE_EC = 'ec-agrifood';
export const SOURCE_AV = 'alpha-vantage';
export const SOURCE_LISTINGS = 'listings';
export const SOURCE_BARCHART = 'barchart';

/** Commodities that actually have a price series to open on. */
const TREND_COMMODITIES = TrendCommodity.options;

/**
 * Map a backend `source` slug to its i18n key under `trends.sources`. Unknown
 * sources fall back to `other` so a future backend source renders SOMETHING
 * rather than a blank legend.
 */
export type SourceLabelKey = 'official' | 'reference' | 'listings' | 'futures' | 'other';

export function sourceLabelKey(source: string): SourceLabelKey {
    switch (source) {
        case SOURCE_EC:
            return 'official';
        case SOURCE_AV:
            return 'reference';
        case SOURCE_LISTINGS:
            return 'listings';
        case SOURCE_BARCHART:
            return 'futures';
        default:
            return 'other';
    }
}

/**
 * Sources whose prices are legally required to be shown as DELAYED.
 *
 * Barchart redistributes exchange data; showing it to end users needs a
 * per-exchange licence (Euronext EMDA for MATIF — see barchart-client.ts),
 * and disclosing the delay is a standard term of those licences. It is also
 * simply true: the intraday pull runs every 20 minutes against a feed that is
 * itself 10-15 minutes behind, so this quote is never the live market.
 */
export function isDelayedSource(source: string): boolean {
    return source === SOURCE_BARCHART;
}

/**
 * Sources that are OUR OWN noticeboard rather than a market quote.
 *
 * The listings index is the median asking price of offers our own users
 * posted. It is not a transaction price, not an exchange quote, and not
 * independent of us — a farmer pricing a crop against it is reading other
 * farmers' hopes. The UI must never let it read as a market price.
 */
export function isOwnMarketplaceSource(source: string): boolean {
    return source === SOURCE_LISTINGS;
}

/** Stable per-series key within a group — source+region+stage is unique. */
export function seriesKey(s: Pick<TrendSeries, 'source' | 'region' | 'stage'>): string {
    return `${s.source}|${s.region}|${s.stage ?? ''}`;
}

export interface ChartGroup {
    /** `${region}|${currency}|${unit}` — the grouping key + a stable React key. */
    key: string;
    region: string;
    currency: string;
    unit: string;
    series: TrendSeries[];
}

/**
 * Partition the flat series list into chart-groups: ONE chart per
 * (region, currency, unit). Splitting by region — not just currency — keeps
 * each member state on its own chart even when two regions now share a
 * currency: Bulgaria adopted the euro in 2026, so BG and EL are both EUR/t yet
 * still render as separate charts. Within a group the series share a single Y
 * axis (a region's own stages at the same unit overlay cleanly); different
 * currencies never mix. Ordered by first appearance (the backend orders by
 * source asc then region asc, which keeps EC official prices first).
 */
export function groupSeriesByRegionUnit(series: TrendSeries[]): ChartGroup[] {
    const groups = new Map<string, ChartGroup>();
    for (const s of series) {
        if (s.points.length === 0) continue;
        const key = `${s.region}|${s.currency}|${s.unit}`;
        const existing = groups.get(key);
        if (existing) {
            existing.series.push(s);
        } else {
            groups.set(key, {
                key,
                region: s.region,
                currency: s.currency,
                unit: s.unit,
                series: [s],
            });
        }
    }
    return [...groups.values()];
}

export interface MergedDatum {
    date: Date;
    /** seriesKey → price for that date (sparse — a series may lack a date). */
    values: Record<string, number>;
}

/**
 * Merge every series in a group into one DENSE date-keyed row set for
 * `TimeSeriesChart`. Dates are the union across the group's series, ascending.
 * Every row carries EVERY series key: a date a series didn't report is
 * forward-filled from its last known price so overlaid lines never dip to zero
 * on a one-week miss. Within a unit-group the series usually share a cadence
 * (all EC member states pull on the same weekly dates), so fills are rare.
 *
 * The fill is bounded to each series' OWN reporting span. Leading gaps are NOT
 * back-filled — inventing pre-history draws a confident flat line across weeks
 * a series never reported — and trailing gaps are not forward-filled either,
 * so a series that stopped reporting visibly stops instead of running to today
 * at its last price.
 */
export function buildMergedData(group: ChartGroup): MergedDatum[] {
    const keys = group.series.map(seriesKey);
    const priceByKeyDate = new Map<string, Map<string, number>>();
    const dateSet = new Set<string>();
    // First and last date each series actually REPORTED. Outside that span the
    // series has nothing to say, and the chart must not speak for it.
    const firstDate: Record<string, string | undefined> = {};
    const lastDate: Record<string, string | undefined> = {};
    for (const s of group.series) {
        const k = seriesKey(s);
        const m = new Map<string, number>();
        for (const p of s.points) {
            m.set(p.date, p.price);
            dateSet.add(p.date);
            if (firstDate[k] == null || p.date < firstDate[k]!) firstDate[k] = p.date;
            if (lastDate[k] == null || p.date > lastDate[k]!) lastDate[k] = p.date;
        }
        priceByKeyDate.set(k, m);
    }
    const dates = [...dateSet].sort();
    const last: Record<string, number | undefined> = {};
    return dates.map((d) => {
        const values: Record<string, number> = {};
        for (const k of keys) {
            const v = priceByKeyDate.get(k)?.get(d);
            if (v != null) last[k] = v;
            // Forward-fill ONLY strictly inside the series' own reporting span.
            //
            // Before its first report there is nothing to carry, and after its
            // last there is nothing to carry FORWARD to: a series that stopped
            // reporting in March would otherwise be extended at its final price
            // all the way to the newest date any OTHER series in the group
            // reported, drawing a confident flat line that says "still trading
            // here" about a feed that went silent months ago. Leaving the key
            // absent ends the line at the last real observation, which is what
            // a dead series looks like.
            const withinSpan =
                firstDate[k] != null && lastDate[k] != null && d >= firstDate[k]! && d <= lastDate[k]!;
            if (withinSpan && last[k] != null) values[k] = last[k]!;
        }
        return { date: new Date(`${d}T00:00:00Z`), values };
    });
}

/** The latest (most recent) point of a series, or null when empty. */
export function latestPoint(s: TrendSeries): TrendPoint | null {
    if (s.points.length === 0) return null;
    return s.points[s.points.length - 1];
}

/**
 * Week-over-week delta: latest price minus the price ~7 days earlier (the
 * closest earlier point at least 5 days back; falls back to the immediately
 * prior point). Returns null when there aren't two comparable points.
 */
export function weekOverWeekDelta(s: TrendSeries): number | null {
    const pts = s.points;
    if (pts.length < 2) return null;
    const latest = pts[pts.length - 1];
    const latestMs = new Date(`${latest.date}T00:00:00Z`).getTime();
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    for (let i = pts.length - 2; i >= 0; i -= 1) {
        const ms = new Date(`${pts[i].date}T00:00:00Z`).getTime();
        if (latestMs - ms >= fiveDaysMs) return latest.price - pts[i].price;
    }
    return latest.price - pts[pts.length - 2].price;
}

/**
 * Preferred EC market stages, most-relevant first.
 *
 * EC publishes the same grain, same region, same week at several stages, and
 * they differ MATERIALLY — an ex-farm price and a delivered-to-port price are
 * separated by haulage. `readFromDb` orders by stage ascending, so picking
 * "the first EC series" previously resolved alphabetically: DEPPORT beat
 * FGATE purely on spelling, and the headline tile could switch stage without
 * warning the day EC added a stage whose name happened to sort earlier.
 *
 * Ex-farm/farm-gate is listed first because it is the number a farmer actually
 * receives. The stage is ALSO named in the UI (SeriesProvenance) — pinning
 * without naming would just make the wrong-stage reading stable.
 */
const EC_STAGE_PREFERENCE = ['FGATE', 'EXW', 'DEPSILO', 'DEPPORT'] as const;

/**
 * The EC (official) series for `region` (default BG), choosing deterministically
 * between stages via {@link EC_STAGE_PREFERENCE}. Falls back to the
 * lexicographically first stage so an unknown stage still renders something,
 * but never leaves the choice to result ordering.
 */
export function findEcSeries(series: TrendSeries[], region = 'BG'): TrendSeries | null {
    const candidates = series.filter((s) => s.source === SOURCE_EC && s.region === region);
    if (candidates.length === 0) return null;
    const rank = (s: TrendSeries): number => {
        const i = EC_STAGE_PREFERENCE.indexOf(
            (s.stage ?? '').toUpperCase() as (typeof EC_STAGE_PREFERENCE)[number],
        );
        return i === -1 ? EC_STAGE_PREFERENCE.length : i;
    };
    return (
        [...candidates].sort(
            (a, b) => rank(a) - rank(b) || (a.stage ?? '').localeCompare(b.stage ?? ''),
        )[0] ?? null
    );
}

/** The own-listings-index series (region BG), or null. */
export function findListingsSeries(series: TrendSeries[]): TrendSeries | null {
    return series.find((s) => s.source === SOURCE_LISTINGS) ?? null;
}

/** The Alpha Vantage reference series, or null. */
export function findReferenceSeries(series: TrendSeries[]): TrendSeries | null {
    return series.find((s) => s.source === SOURCE_AV) ?? null;
}

/**
 * True when the payload carries no plottable data at all. Drives the empty /
 * operator-unconfigured state (the endpoint degrades to empty series when the
 * EC / Alpha Vantage sources are unconfigured OR the window has no data).
 */
export function isEmptyPayload(payload: TrendPricesResponse | undefined): boolean {
    if (!payload) return false;
    return payload.series.every((s) => s.points.length === 0);
}

/**
 * How stale a series is, in whole days, measured against the payload's
 * SERVER-side `generatedAt` rather than the browser clock — a rural device can
 * be hours off, and the response is Redis-cached, so the client's own `now` is
 * not a sound reference. Returns null when the series never reported.
 *
 * A cached payload understates the age by at most the cache TTL, which is
 * immaterial against a weekly pull cadence.
 */
export function stalenessDays(
    series: Pick<TrendSeries, 'lastObservedAt'>,
    generatedAt: string,
): number | null {
    if (!series.lastObservedAt) return null;
    const observed = new Date(`${series.lastObservedAt}T00:00:00Z`).getTime();
    const generated = new Date(generatedAt).getTime();
    if (Number.isNaN(observed) || Number.isNaN(generated)) return null;
    return Math.max(0, Math.floor((generated - observed) / 86_400_000));
}

/**
 * Age past which a series is called out as stale in the UI.
 *
 * The all-sources pull runs WEEKLY (Monday 05:30 UTC — see schedules.ts), and
 * the EC and listings series publish weekly too, so a gap of one cadence is
 * routine and must not cry wolf. Two full cycles plus a day of slack means a
 * genuinely missed publication rather than a late one.
 */
export const STALE_AFTER_DAYS = 15;

/** True when a series has not reported within {@link STALE_AFTER_DAYS}. */
export function isStale(
    series: Pick<TrendSeries, 'lastObservedAt'>,
    generatedAt: string,
): boolean {
    const days = stalenessDays(series, generatedAt);
    return days != null && days > STALE_AFTER_DAYS;
}

/** Round-trip-safe display number: fixed to at most 2 decimals, trimmed. */
export function formatPrice(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Display price with its ISO currency suffix (e.g. `"512 EUR"`). */
export function formatPriceWithCurrency(value: number, currency: string): string {
    return currency ? `${formatPrice(value)} ${currency}` : formatPrice(value);
}

/** Signed, 2-decimal delta for the WoW tile (`+12.5` / `-3.2`). */
export function formatDelta(value: number): string {
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    return `${sign}${Math.abs(value).toFixed(2)}`;
}

/**
 * The first commodity a user's stated interests name, or null.
 *
 * `UserInterest` is free-text keywords typed for the news For-You filter, so
 * this reuses the canonical vocabulary rather than string-matching: a farmer
 * who typed "пшеница" or "Wheat" means the wheat price series either way.
 * Only commodities with an actual price series qualify — an interest in
 * "subsidies" is real but not something Prices can open on.
 */
export function firstInterestedCommodity(
    keywords: readonly string[] | undefined,
): TrendCommodity | null {
    if (!keywords?.length) return null;
    for (const kw of keywords) {
        const canonical = normalizeCommodity(kw);
        if (canonical && (TREND_COMMODITIES as readonly string[]).includes(canonical)) {
            return canonical as TrendCommodity;
        }
    }
    return null;
}
