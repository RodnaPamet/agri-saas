/**
 * World Bank "Pink Sheet" client — FERTILIZER prices. PURE HTTP, no DB.
 *
 * ── What this feed covers, and what it does not ──────────────────────────
 *
 * Four fertilisers were wanted: Уреа, ДАП, МАП, Амониев нитрат. Coverage was
 * verified per item against the actual workbook — a full 72-column
 * enumeration plus an exhaustive string search, cross-checked against an
 * independent mirror — not by keyword-grepping the documentation:
 *
 *   urea              COVERED — `Urea ` (note the trailing space), $/mt
 *   dap               COVERED — `DAP`, $/mt
 *   map               NOT COVERED — zero hits for `monoammonium` / `\bMAP\b`
 *                     anywhere in the workbook. No free machine-readable
 *                     source publishes it: the EC agri-food API is
 *                     nutrient-only (N/P/K) and Eurostat has no MAP series.
 *                     → admin-entered (`source: 'manual'`).
 *   ammonium-nitrate  NOT COVERED by the Pink Sheet. Eurostat `apri_ap_ina`
 *                     has a Bulgarian series, but it is ANNUAL, gap-ridden
 *                     (2023 missing) and priced per 100 kg of NUTRIENT
 *                     rather than per tonne of product — a different
 *                     quantity wearing a similar name. → admin-entered.
 *
 * MAP is not DAP and must never be proxied by it. A farmer pricing a
 * purchase off the wrong compound is worse served than by an honest gap,
 * which is why the two uncovered items route to manual entry instead.
 *
 * ── The stale-URL trap ───────────────────────────────────────────────────
 *
 * The doc-id segment of the URL rolls over annually, and — verified — the
 * PREVIOUS generation still returns HTTP 200 with a frozen file: last period
 * 2025M12, seven months stale, no redirect and no 404. A hardcoded URL
 * therefore degrades to serving old prices indefinitely rather than failing.
 * So freshness is asserted from the DATA, not from the response: if the
 * newest period is further behind than `maxStalenessMonths`, this throws.
 *
 * ── Monthly, and honestly so ─────────────────────────────────────────────
 *
 * Cadence is monthly with a ~1-month publication lag, so a point is 30-60
 * days old at all times. That is a property of the source, not a fault, and
 * the UI must not draw it as though it were daily.
 *
 * @module lib/market/world-bank-client
 */
import { bindColumns, numericCell, readXlsxSheet, textCell } from './xlsx';
import { normalizeAnyCommodity } from './commodity-vocabulary';

/**
 * The monthly historical workbook.
 *
 * The `-0050012026` generation segment is the 2026 one. When it rolls, the
 * freshness check below is what turns "silently serving last year's prices"
 * into a loud failure — see the module docblock.
 */
export const PINK_SHEET_MONTHLY_URL =
    'https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx';

export const PINK_SHEET_SHEET_NAME = 'Monthly Prices';

/** As reported. Never converted — conversion belongs at display, with the rate named. */
export const PINK_SHEET_UNIT = 'USD/mt';
export const PINK_SHEET_CURRENCY = 'USD';

/**
 * Prices are global benchmarks (f.o.b. US Gulf for DAP, f.o.b. Middle East
 * for urea), not a Bulgarian domestic quote — so the region says so.
 */
export const PINK_SHEET_REGION = 'GLOBAL';

/**
 * The fertiliser slugs this feed may produce.
 *
 * An explicit allowlist rather than "whatever the header normalises to": the
 * Pink Sheet also carries maize, wheat, barley and soybeans, and accepting
 * anything the vocabulary recognises would quietly start a second, parallel
 * cereal series alongside the EC one.
 */
export const PINK_SHEET_FERTILIZERS: ReadonlySet<string> = new Set(['urea', 'dap']);

/**
 * Price basis per slug, recorded because it is part of what the number MEANS.
 * The urea basis changed in March 2022 (Black Sea → Middle East), which is a
 * break in the series rather than a price move.
 */
const BASIS_LABEL: Readonly<Record<string, string>> = {
    dap: 'DAP (diammonium phosphate), spot, f.o.b. US Gulf',
    urea: 'Urea, prill spot f.o.b. Middle East (f.o.b. Black Sea before March 2022)',
};

const FETCH_TIMEOUT_MS = 60_000;

/** Thrown when the World Bank host rate-limits (HTTP 429). */
export class WorldBankRateLimitError extends Error {
    constructor(message: string, public readonly retryAfterSeconds?: number) {
        super(message);
        this.name = 'WorldBankRateLimitError';
    }
}

/** Thrown when the workbook parses but its newest observation is too old to trust. */
export class PinkSheetStaleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PinkSheetStaleError';
    }
}

type FetchFn = typeof fetch;

export interface WorldBankFetchOptions {
    url?: string;
    timeoutMs?: number;
    fetchImpl?: FetchFn;
    /** Months of history to ingest. Default 60 — five years covers every UI range. */
    maxMonths?: number;
    /** Refuse a workbook whose newest period is older than this. Default 4. */
    maxStalenessMonths?: number;
    /** Injectable clock, so a fixture-based test is not a calendar bomb. */
    now?: Date;
}

export interface FertilizerObservation {
    commodity: string;
    region: string;
    date: Date;
    price: number;
    unit: string;
    currency: string;
    label: string;
}

/** `'2026M07'` → 2026-07-01 UTC, or null. */
export function parsePinkSheetPeriod(raw: string | null): Date | null {
    if (!raw) return null;
    const m = /^(\d{4})M(\d{1,2})$/.exec(raw.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    // First of the month: a monthly observation is not a day, and pinning it
    // to the 1st keeps (seriesId, date) stable across re-runs.
    return new Date(Date.UTC(year, month - 1, 1));
}

function monthsBetween(a: Date, b: Date): number {
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/**
 * Parse the monthly workbook into urea + DAP observations.
 *
 * Exported so the format can be tested against a recorded fixture with no
 * network involved.
 */
export async function parsePinkSheetWorkbook(
    bytes: Uint8Array,
    opts: WorldBankFetchOptions = {},
): Promise<FertilizerObservation[]> {
    const sheet = await readXlsxSheet(bytes, PINK_SHEET_SHEET_NAME, { maxBytes: 40 * 1024 * 1024 });
    const now = opts.now ?? new Date();
    const maxMonths = opts.maxMonths ?? 60;
    const maxStaleness = opts.maxStalenessMonths ?? 4;

    // The header row is FOUND, not assumed: four title rows sit above it
    // today, and a fifth would silently shift every column binding.
    let headerIdx = -1;
    let columns = new Map<string, string>();
    for (let i = 0; i < Math.min(15, sheet.rows.length); i++) {
        const bound = bindColumns(sheet.rows[i]);
        const hits = [...bound.keys()].filter((h) => PINK_SHEET_FERTILIZERS.has(normalizeAnyCommodity(h) ?? ''));
        if (hits.length > 0) {
            headerIdx = i;
            columns = bound;
            break;
        }
    }
    if (headerIdx < 0) {
        throw new Error('Pink Sheet: no fertiliser column found in the first 15 rows');
    }

    // Every header goes through normalizeAnyCommodity so a spelling variant
    // ('Urea ' with its trailing space) cannot silently split one series into
    // two — then the allowlist keeps the cereals out.
    const wanted: Array<{ col: string; slug: string }> = [];
    for (const [header, col] of columns) {
        const slug = normalizeAnyCommodity(header);
        if (slug && PINK_SHEET_FERTILIZERS.has(slug)) wanted.push({ col, slug });
    }
    if (wanted.length === 0) {
        throw new Error('Pink Sheet: fertiliser columns present but none resolved to a known slug');
    }

    // The units row sits directly under the header. Checked rather than
    // assumed: a change from $/mt would otherwise store a different quantity
    // under an unchanged label.
    const unitsRow = sheet.rows[headerIdx + 1];
    for (const { col, slug } of wanted) {
        const unit = textCell(unitsRow, col);
        if (unit !== '($/mt)') {
            throw new Error(
                `Pink Sheet: expected ${slug} in ($/mt), got ${JSON.stringify(unit)} — ` +
                    'refusing to store a price under a unit it is not quoted in',
            );
        }
    }

    const out: FertilizerObservation[] = [];
    let newest: Date | null = null;

    for (const row of sheet.rows.slice(headerIdx + 2)) {
        const date = parsePinkSheetPeriod(textCell(row, 'A'));
        if (!date) continue;
        if (!newest || date > newest) newest = date;
        // Only recent history — the file goes back to 1960M01 and re-upserting
        // 66 years of monthly points every run is write amplification for data
        // no range selector shows.
        if (monthsBetween(date, now) > maxMonths) continue;

        for (const { col, slug } of wanted) {
            // The missing marker is the literal '...'; `numericCell` maps it
            // to null. A zero here would be a fertiliser priced at nothing.
            const price = numericCell(row, col);
            if (price === null || price <= 0) continue;
            out.push({
                commodity: slug,
                region: PINK_SHEET_REGION,
                date,
                price,
                unit: PINK_SHEET_UNIT,
                currency: PINK_SHEET_CURRENCY,
                label: BASIS_LABEL[slug] ?? slug,
            });
        }
    }

    if (!newest) {
        throw new Error('Pink Sheet: no parseable period labels — the layout has changed');
    }
    const staleBy = monthsBetween(newest, now);
    if (staleBy > maxStaleness) {
        throw new PinkSheetStaleError(
            `Pink Sheet newest period is ${staleBy} months old (${newest.toISOString().slice(0, 7)}). ` +
                'The doc-id URL segment rolls annually and the previous generation still returns HTTP 200 ' +
                'with a frozen file — this is almost certainly a stale URL, not a publication gap.',
        );
    }

    return out;
}

export async function fetchFertilizerPrices(
    opts: WorldBankFetchOptions = {},
): Promise<FertilizerObservation[]> {
    const doFetch = opts.fetchImpl ?? fetch;
    const url = opts.url ?? PINK_SHEET_MONTHLY_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    let response: Response;
    try {
        response = await doFetch(url, { method: 'GET', signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }

    if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.('retry-after') ?? '');
        throw new WorldBankRateLimitError(
            'World Bank Pink Sheet rate-limited (429)',
            Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
    }
    if (!response.ok) {
        throw new Error(`World Bank Pink Sheet error ${response.status} for ${url}`);
    }
    return parsePinkSheetWorkbook(new Uint8Array(await response.arrayBuffer()), opts);
}
