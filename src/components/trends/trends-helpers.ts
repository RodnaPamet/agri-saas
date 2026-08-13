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
/** Hand-entered by a platform admin (see market-manual-prices.ts). */
export const SOURCE_MANUAL = 'manual';
/** EC Weekly Oil Bulletin — road diesel. */
export const SOURCE_OIL_BULLETIN = 'oil-bulletin';
/** World Bank Pink Sheet — urea + DAP. */
export const SOURCE_WORLD_BANK = 'world-bank';

/** Commodities that actually have a price series to open on. */
const TREND_COMMODITIES = TrendCommodity.options;

/**
 * Map a backend `source` slug to its i18n key under `trends.sources`. Unknown
 * sources fall back to `other` so a future backend source renders SOMETHING
 * rather than a blank legend.
 */
export type SourceLabelKey =
    | 'official'
    | 'reference'
    | 'listings'
    | 'futures'
    | 'manual'
    | 'oilBulletin'
    | 'worldBank'
    | 'other';

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
        case SOURCE_MANUAL:
            return 'manual';
        case SOURCE_OIL_BULLETIN:
            return 'oilBulletin';
        case SOURCE_WORLD_BANK:
            return 'worldBank';
        default:
            return 'other';
    }
}

/**
 * A hand-typed price must never be presented as a live quote.
 *
 * The manual path exists because MAP and ammonium nitrate have no free feed,
 * so those series are somebody's typing. A farmer deciding when to buy is
 * entitled to know which is which, and "Other source" — where `manual` landed
 * before this — does not tell them.
 */
export function isManualSeries(series: Pick<TrendSeries, 'source'>): boolean {
    return series.source === SOURCE_MANUAL;
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

/**
 * Staleness is a property of the SOURCE'S CADENCE, not a constant.
 *
 * 15 days is two weekly cycles plus slack, which is right for the weekly EC
 * and listings feeds. Applied to the World Bank Pink Sheet it is simply
 * wrong: that feed is MONTHLY with a ~1-month publication lag, so a urea
 * point is 30-60 days old at all times and would render permanently orange
 * with a "not reported recently" warning — a false alarm on every single
 * view, which is how a warning stops being read at all.
 *
 * A manual series gets a wide bound for a different reason: it is somebody's
 * typing and its age is already stated explicitly next to it, so a staleness
 * warning would be both redundant and unactionable. Only a year of silence
 * says something the provenance line does not.
 */
export const STALE_AFTER_DAYS_BY_SOURCE: Readonly<Record<string, number>> = {
    [SOURCE_WORLD_BANK]: 75,
    [SOURCE_MANUAL]: 400,
};

export function staleAfterDaysForSource(source: string): number {
    return STALE_AFTER_DAYS_BY_SOURCE[source] ?? STALE_AFTER_DAYS;
}

/** True when a series has not reported within its source's own bound. */
export function isStale(
    series: Pick<TrendSeries, 'lastObservedAt' | 'source'>,
    generatedAt: string,
): boolean {
    const days = stalenessDays(series, generatedAt);
    return days != null && days > staleAfterDaysForSource(series.source);
}

/**
 * The series a stat tile should lead with, for a commodity whose feeds are
 * not the crop trio.
 *
 * The existing tiles look for EC / listings / Alpha Vantage by name, which
 * for diesel or urea means three "no data" tiles sitting above a perfectly
 * good chart. This picks the series with the most recent observation instead,
 * breaking ties by point count so a one-point series never outranks a
 * populated one.
 */
export function primarySeries(series: TrendSeries[]): TrendSeries | null {
    const withPoints = series.filter((s) => s.points.length > 0);
    if (withPoints.length === 0) return null;
    return [...withPoints].sort(
        (a, b) =>
            (b.lastObservedAt ?? '').localeCompare(a.lastObservedAt ?? '') ||
            b.points.length - a.points.length,
    )[0];
}

/**
 * Regions worth leading with, most-relevant-first for a Bulgarian operator.
 *
 * BG is the market a farmer here is actually paid in. EU is an average across
 * the union — a reasonable benchmark when BG has not reported, and wrong to
 * present as the local price when it has.
 */
const REGION_PREFERENCE = ['BG', 'EU'] as const;

/**
 * The ONE chart-group the Prices tab draws.
 *
 * The tab used to render every group {@link groupSeriesByRegionUnit} returned,
 * and the pull job fetches EC prices for BG, RO, EL and EU — all EUR/t since
 * Bulgaria's euro adoption, so region is the only thing separating them. Wheat
 * therefore drew four cards with the same title, the same source label and the
 * same unit, three of them about countries the reader is not paid in. The
 * grouping is still right (those series must not share a Y axis); showing all
 * of it was not.
 *
 * The third arm is what makes this ONE rule rather than a crop rule with
 * exceptions. Fertilizer is World Bank region `GLOBAL` and nothing else, and a
 * future commodity may arrive in a region nobody listed here — both fall
 * through to whichever group reported most recently and draw a chart, rather
 * than matching no preference and drawing nothing.
 *
 * Series WITHIN the chosen group are untouched: narrowing to one card must not
 * narrow to one line, or diesel would lose either its with-tax or its
 * without-tax series, which are different numbers and both wanted.
 */
export function selectPrimaryGroup(groups: ChartGroup[]): ChartGroup | null {
    if (groups.length === 0) return null;
    // A region can hold more than one group — EC in EUR/t and the own-listings
    // median in BGN/t are BOTH region BG. Picking "the first BG group" would
    // resolve on backend result ordering, and the losing outcome is this page
    // presenting the median of our own users' ASKING prices as the official
    // one. The noticeboard is a last resort, never a default.
    const quotes = groups.filter(
        (g) => !g.series.every((s) => isOwnMarketplaceSource(s.source)),
    );
    const candidates = quotes.length > 0 ? quotes : groups;
    for (const region of REGION_PREFERENCE) {
        const preferred = candidates.find((g) => g.region === region);
        if (preferred) return preferred;
    }
    const lead = primarySeries(candidates.flatMap((g) => g.series));
    if (!lead) return null;
    return candidates.find((g) => g.series.includes(lead)) ?? candidates[0];
}

/**
 * How EC names its country-wide series, loosely matched.
 *
 * The text is EC's and they have already renamed it once — the market moved
 * out of `stageName` (`'Burgas - DEPPROD'` → `'Departure from farm…'` plus a
 * separate `marketName`) some time before 2026-08-10, which changed our series
 * key and orphaned ten Bulgarian wheat series mid-chart. Matching a literal
 * would break on the next rename; matching a substring, case- and
 * whitespace-insensitively, survives one.
 */
function isNationalAverage(s: TrendSeries): boolean {
    return (s.stage ?? '').trim().toLowerCase().includes('national average');
}

/**
 * The lines the one chart draws, out of the group {@link selectPrimaryGroup}
 * chose.
 *
 * Narrowing to one CARD was not the whole job. EC publishes wheat per market —
 * Burgas, Plovdiv, Varna, Ruse, Dobrich… — and the pull keys a series on
 * `stageName` while dropping `marketName`, so production held TWELVE series in
 * a single (BG, EUR, EUR/t) group. The card count was 1 and the line count was
 * 12, ten of them dead ends flatlining weeks back because EC's rename changed
 * their key.
 *
 * The collapse is decided by SOURCE, not by count. Those per-market rows are
 * ALTERNATIVES — the same quantity measured in different places, for which the
 * national average is the answer to "what is wheat worth in Bulgaria". Diesel's
 * with-tax and without-tax are COMPLEMENTS: different quantities, both wanted,
 * on the same axis. No property of the group distinguishes those two cases, so
 * a count- or freshness-based rule would silently drop one of the diesel lines.
 * Only the EC feed collapses; every other source keeps every line it has.
 */
export function chartSeriesFor(group: ChartGroup): TrendSeries[] {
    if (group.series.length <= 1) return group.series;
    if (!group.series.every((s) => s.source === SOURCE_EC)) return group.series;
    const national = group.series.find(isNationalAverage);
    if (national) return [national];
    // No national average — EC restructures, and it just did. One live line
    // beats a dozen overlapping ones, and among series measuring the same
    // thing the freshest is the only defensible pick.
    const freshest = primarySeries(group.series);
    return freshest ? [freshest] : group.series;
}

/**
 * The series a group's headline tile should quote.
 *
 * The tile used to call `findEcSeries(series, 'BG')` with the region spelled
 * out, so the moment {@link selectPrimaryGroup} fell back to EU the tile read
 * "no data" directly above a populated chart. Reading the group the chart drew
 * makes the two incapable of disagreeing.
 *
 * EC stage preference applies first because it encodes a material distinction
 * — ex-farm and delivered-to-port are separated by haulage — and only then the
 * most-recent rule, which is all a non-EC group (oil bulletin, World Bank,
 * hand-typed) has to go on.
 */
export function leadSeriesOf(group: ChartGroup): TrendSeries {
    return (
        findEcSeries(group.series, group.region) ??
        primarySeries(group.series) ??
        group.series[0]
    );
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
