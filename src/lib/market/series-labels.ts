/**
 * Bulgarian names for the market series a chart plots.
 *
 * A Trends line reads `България · Burgas - DEPPROD · Breadmaking common
 * wheat` — every part Bulgarian except the instrument, under a heading that
 * already says Пшеница. That makes the English read as an untranslated
 * string rather than as an instrument's proper name, which is why it is
 * translated here and delivery points are not: `Departure from farm or from
 * production area - on truck or other transport means` is a sentence, and a
 * table that tries to swallow sentences becomes a place strings rot.
 *
 * ── Three kinds of label arrive in this field, and only one is the feed's ──
 *
 * 1. **Feed prose** — `Breadmaking common wheat`, `Feed barley`. What the EC
 *    cereal endpoint puts in `productName`.
 * 2. **Feed CODES** — `BLTPAN|PAN`, `MAI|FEED`, `ORGFOUR|FEED`. The same
 *    endpoint returns a code in that field for some rows, so a farmer could
 *    be shown a machine identifier. These are decodable from our own
 *    constants: `EC_PRODUCT_CODES` in `ec-agrifood-client.ts` documents
 *    BLTPAN as common breadmaking wheat, MAI as feed maize, ORGFOUR as feed
 *    barley — so each code maps to the SAME key as its prose sibling rather
 *    than to a second name for one thing.
 * 3. **Ours** — `Reference (Alpha Vantage)`, `Own-listings median`,
 *    `Futures (Barchart, delayed)` are authored by `market-prices-pull.ts`,
 *    in English, and were never the feed's. They are the same class of
 *    defect as the journal titles in #1073: server-authored English on a
 *    Bulgarian screen.
 *
 * ── Why this resolves at READ and not at ingest ──
 *
 * Storing a Bulgarian label would repeat #1073's mistake on a row instead of
 * a projection. The distinction is not style: a journal title is PERSISTED,
 * so a language chosen at write time strands every row already written and
 * costs a backfill over a filed register to undo. A trends payload is a
 * read-time projection — re-rendering it is free, so the reader's language
 * can decide, every time.
 *
 * Unknown labels pass through unchanged. A new commodity or grade appearing
 * in the feed shows the feed's own words rather than a blank or a key, and
 * the same passthrough is why this cannot break when the EC vocabulary
 * grows.
 */
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';

/**
 * Exact label → message key. Keyed on the literal the feed sends, trimmed.
 *
 * Deliberately NOT fuzzy: a substring or prefix match would quietly
 * re-label a future `Feed barley, organic` as plain feed barley, which is a
 * different instrument at a different price.
 */
const LABEL_KEYS: Record<string, string> = {
    // Cereals — prose and the code form of the same instrument.
    'Breadmaking common wheat': 'trends.seriesLabel.breadmakingCommonWheat',
    'BLTPAN|PAN': 'trends.seriesLabel.breadmakingCommonWheat',
    'Feed maize': 'trends.seriesLabel.feedMaize',
    'MAI|FEED': 'trends.seriesLabel.feedMaize',
    'Feed barley': 'trends.seriesLabel.feedBarley',
    'ORGFOUR|FEED': 'trends.seriesLabel.feedBarley',
    // Oilseeds.
    'Sunflower seed': 'trends.seriesLabel.sunflowerSeed',
    // Fuel — the two tax bases are 639.68 EUR/1000l apart, so they must stay
    // distinguishable in Bulgarian too, not collapse to one "diesel".
    'Automotive gas oil (excluding duties and taxes)': 'trends.seriesLabel.dieselExclTax',
    'Automotive gas oil (with duties and taxes)': 'trends.seriesLabel.dieselInclTax',
    // Fertiliser inputs.
    'DAP (diammonium phosphate), spot, f.o.b. US Gulf': 'trends.seriesLabel.dap',
    'Urea, prill spot f.o.b. Middle East (f.o.b. Black Sea before March 2022)':
        'trends.seriesLabel.urea',
    // Ours, authored in market-prices-pull.ts.
    'Reference (Alpha Vantage)': 'trends.seriesLabel.referenceAlphaVantage',
    'Own-listings median': 'trends.seriesLabel.ownListingsMedian',
    'Futures (Barchart, delayed)': 'trends.seriesLabel.futuresBarchart',
};

/** The labels this module knows, for tests and for a coverage check. */
export const KNOWN_SERIES_LABELS = Object.keys(LABEL_KEYS);

/**
 * Localise one series label, passing through anything unrecognised.
 *
 * `null` in, `null` out — a series with no label is a real state and must
 * not become the string "null" on a chart.
 */
export async function localiseSeriesLabel(
    label: string | null | undefined,
    locale: Locale,
    /**
     * The translator, injectable ONLY so the miss branch below can be
     * exercised. `translateFor` falls back `locale → DEFAULT_LOCALE`, so a
     * key missing from `bg.json` alone still resolves via `en.json` — which
     * means the `rendered === key` guard fires only when BOTH locales lack
     * the message, a state no message-file mutation can produce. Without
     * this seam that branch is unreachable from a test, and an unreachable
     * branch that is wrong stays wrong.
     */
    translate: typeof translateFor = translateFor,
): Promise<string | null> {
    if (label == null) return null;
    const key = LABEL_KEYS[label.trim()];
    if (!key) return label;
    const rendered = await translate(locale, key, {});
    // `translateFor` returns the KEY when it finds no message, which is a
    // plausible-looking non-empty string — so a missing entry would ship a
    // dotted key onto a chart. Fall back to the feed's own words instead.
    return rendered === key ? label : rendered;
}
