/**
 * Barchart OnDemand quotes client — PURE HTTP, no DB.
 *
 * Fetches DELAYED (10–15 min) futures quotes from Barchart OnDemand
 * (https://ondemand.websol.barchart.com/getQuote.json) for the exchange
 * contracts that back the EU/Bulgaria grain complex — primarily Euronext
 * MATIF (Paris): milling wheat, corn, rapeseed — the European benchmark that
 * the weekly EC AGRI-food feed can't deliver near-real-time. Mirrors the
 * Alpha Vantage client's contract: one GET, an AbortController timeout, a
 * throw on any non-2xx (or a non-200 API status), a base-URL override for
 * tests, and an injectable `fetch`.
 *
 * NOT LIVE-VERIFIED — there is no Barchart key in this environment, so this is
 * built to the DOCUMENTED getQuote response shape
 * `{ status: { code }, results: [{ symbol, name, lastPrice, tradeTimestamp, mode }] }`.
 * It is isolated fully behind this module so the futures feed can be swapped
 * or extended without touching the pull job.
 *
 * Licensing note (see docs): showing DELAYED exchange prices to end users is
 * "redistribution" and needs a per-exchange licence. Two bills, not one, and
 * the second is not Barchart's to grant: EMDA clause 13.2 makes a Sub Vendor's
 * use governed by ITS OWN agreement, reported and invoiced directly by
 * Euronext, and clause 6.8 obliges Barchart to verify that agreement exists
 * first — so paying Barchart alone does not make the display lawful. As of the
 * fee schedule effective 2026-01-01 (v18.0): Euronext Commodity Derivatives
 * delayed Last Price is €167.55/mo, and Barchart OnDemand starts at $500/mo.
 * ~€650/mo all-in for delayed MATIF; CBOT is far dearer ($21,840/yr plus a
 * $250/mo sub-vendor fee, which is why those contracts stay commented out).
 * This client is the technical seam; the operator enables it with a key ONLY
 * once both agreements are in place.
 *
 * @module lib/market/barchart-client
 */

/** Default Barchart OnDemand base (overridable for tests). */
export const BARCHART_DEFAULT_BASE_URL = 'https://ondemand.websol.barchart.com';

const FETCH_TIMEOUT_MS = 30_000;

/**
 * A futures contract we pull, and how it maps into our price model. Kept as a
 * curated constant (NOT env-driven) so the mapping is reviewable in one place.
 *
 * `symbol` is a Barchart symbol; `*0` requests the front/nearest month. Roots
 * marked "verify" are our best-known values — confirm them against the live
 * Barchart account before relying on the series (an unknown symbol simply
 * returns no result and is skipped, never a crash).
 *
 * Units are per-CONTRACT and NOT normalised: MATIF quotes in EUR/tonne (clean,
 * no conversion), CBOT in US-cents/bushel, MDEX palm oil in MYR/tonne. The
 * Trends UI groups charts by (region, currency, unit), so each exchange lands
 * on its own chart — mixed units never share an axis.
 */
export interface BarchartContract {
    /** Barchart symbol; `*0` = front month. */
    symbol: string;
    /** Our commodity slug (must match the Trends picker to be visible today). */
    commodity: string;
    /** Region tag = the exchange (own chart per exchange). */
    region: string;
    /** ISO currency of the quote. */
    currency: string;
    /** Reported unit, verbatim (no cross-source normalisation). */
    unit: string;
}

/**
 * Default contract set. Only the two that OVERLAP the existing Trends
 * commodities (wheat, maize) are active, so they render immediately as a new
 * "MATIF" chart beside the EC BG/RO/EL lines with no UI change. The rest are
 * one line away — uncomment after (a) confirming the Barchart root and (b)
 * adding the commodity to the Trends picker (`COMMODITIES` in PricesTab).
 */
export const BARCHART_CONTRACTS: readonly BarchartContract[] = [
    // ── Euronext MATIF (Paris) — the EU/Bulgaria benchmark, EUR/tonne ──
    { symbol: 'ML*0', commodity: 'wheat', region: 'MATIF', currency: 'EUR', unit: 'EUR/t' }, // Milling wheat
    { symbol: 'EMA*0', commodity: 'maize', region: 'MATIF', currency: 'EUR', unit: 'EUR/t' }, // Corn — verify root
    // { symbol: 'IJ*0',  commodity: 'rapeseed', region: 'MATIF', currency: 'EUR', unit: 'EUR/t' }, // Rapeseed — verify root
    // ── CBOT (Chicago) — US-cents/bushel, licence is far dearer ──
    // { symbol: 'ZW*0', commodity: 'wheat',   region: 'CBOT', currency: 'USD', unit: 'USd/bu' },
    // { symbol: 'ZC*0', commodity: 'maize',   region: 'CBOT', currency: 'USD', unit: 'USd/bu' },
    // { symbol: 'ZS*0', commodity: 'soybean', region: 'CBOT', currency: 'USD', unit: 'USd/bu' },
    // ── Bursa Malaysia (MDEX) — crude palm oil, MYR/tonne (KO confirmed) ──
    // { symbol: 'KO*0', commodity: 'palm-oil', region: 'MDEX', currency: 'MYR', unit: 'MYR/t' },
];

/** Thrown when Barchart rate-limits (HTTP 429 or an API status 429/509). */
export class BarchartRateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BarchartRateLimitError';
    }
}

type FetchFn = typeof fetch;

export interface BarchartFetchOptions {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchFn;
}

/** One normalised delayed quote. */
export interface BarchartQuote {
    /** Resolved contract symbol, e.g. "MLU26". */
    symbol: string;
    /** Human label, e.g. "Milling Wheat Sep '26" (may be null). */
    name: string | null;
    /** Last traded price, or null when the source value is non-numeric. */
    lastPrice: number | null;
    /** ISO trade timestamp as reported (may be null). */
    tradeTimestamp: string | null;
    /**
     * Barchart feed mode, per their getQuote documentation: `R` real-time,
     * `I` DELAYED, `D` end-of-day.
     *
     * Spelled out because the obvious reading is wrong and the cost of the
     * mistake is licensing, not cosmetics. `d` looks like "delayed" and is
     * end-of-day; delayed is `I`. Nothing filters on this today, but the
     * natural future use is proving a quote is delayed before displaying it —
     * and `mode === 'd'` would select exactly the quotes that are not.
     */
    mode: string | null;
}

interface RawBarchartResponse {
    status?: { code?: number; message?: string };
    results?: Array<{
        symbol?: string;
        name?: string;
        lastPrice?: number | string;
        tradeTimestamp?: string;
        mode?: string;
    }>;
}

function toNumber(v: number | string | undefined | null): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Fetch delayed quotes for a batch of Barchart symbols in ONE getQuote call.
 * Returns the normalised quotes; a symbol Barchart doesn't resolve is simply
 * absent from `results` (never an error). Throws `BarchartRateLimitError` on a
 * throttle and a plain `Error` on any other non-2xx / non-200-status.
 */
export async function fetchBarchartQuotes(
    symbols: string[],
    apiKey: string,
    opts: BarchartFetchOptions = {},
): Promise<BarchartQuote[]> {
    if (symbols.length === 0) return [];
    const base = (opts.baseUrl ?? BARCHART_DEFAULT_BASE_URL).replace(/\/$/, '');
    const doFetch = opts.fetchImpl ?? fetch;
    const params = new URLSearchParams();
    params.set('apikey', apiKey);
    params.set('symbols', symbols.join(','));
    const url = `${base}/getQuote.json?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    let res: Response;
    try {
        res = await doFetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 429) {
        throw new BarchartRateLimitError('Barchart rate limit (HTTP 429)');
    }
    if (!res.ok) {
        throw new Error(`Barchart getQuote failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as RawBarchartResponse;
    const code = body.status?.code;
    if (code === 429 || code === 509) {
        throw new BarchartRateLimitError(`Barchart rate limit (status ${code})`);
    }
    // getQuote returns 200 + status.code 204 when NO symbols resolved — treat
    // as an empty result, not an error.
    if (code != null && code !== 200 && code !== 204) {
        throw new Error(`Barchart getQuote status ${code}: ${body.status?.message ?? ''}`.trim());
    }

    return (body.results ?? []).map((r) => ({
        symbol: (r.symbol ?? '').toUpperCase(),
        name: r.name ?? null,
        lastPrice: toNumber(r.lastPrice),
        tradeTimestamp: r.tradeTimestamp ?? null,
        mode: r.mode ?? null,
    }));
}
