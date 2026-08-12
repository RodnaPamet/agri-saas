/**
 * EC Weekly Oil Bulletin client — road DIESEL prices. PURE HTTP, no DB.
 *
 * ── "нафта" means diesel fuel, not crude ─────────────────────────────────
 *
 * This is the trap the whole module exists to avoid. Alpha Vantage is already
 * wired into this repo and offers WTI and BRENT, which are CRUDE. Crude tracks
 * diesel loosely and is the wrong number for a farmer budgeting fuel: pump
 * diesel carries refining margin, excise and VAT, and moves on a different
 * curve. `нафта` / `дизелово гориво` is what the operator means, and this feed
 * is what publishes it.
 *
 * ── The source, verified rather than assumed ─────────────────────────────
 *
 * DG ENER's Weekly Oil Bulletin. Bulgaria has been present since 2008-01-07
 * (930 weekly observations), the licence is CC BY 4.0 via Decision
 * 2011/833/EU, and there is no key, login or clickwrap. Prices are surveyed
 * each Monday and published Thursday.
 *
 * Format is XLSX only — no CSV, no JSON, no API. The `data.europa.eu` dataset
 * entry is metadata whose every distribution points back at the HTML landing
 * page. Hence `./xlsx`.
 *
 * ── Two prices, both real ────────────────────────────────────────────────
 *
 * The bulletin publishes WITH taxes and WITHOUT taxes as separate files, and
 * for Bulgaria they differ by ~55% (1742.6 vs 1121.87 EUR/1000 l). Both are
 * fetched and stored, distinguished by `stage`, because they answer different
 * questions: with-tax is what leaves the bank account, without-tax is what
 * compares across member states and approximates the burden after VAT
 * reclaim. Same region/currency/unit means they overlay as two labelled lines
 * on ONE chart. Storing them without a stage discriminator would collide on
 * the series key and silently overwrite each other per date.
 *
 * ── Three traps, each observed in the real file ──────────────────────────
 *
 *  1. THE FILENAME LIES. `content-disposition` says
 *     "…Weekly prices with Taxes - 2024-02-19.xlsx" on a file containing
 *     2026-08-03 data. The observation date is read from cell A2 and from
 *     nowhere else.
 *  2. Columns move. Bind the diesel column by its (long, multilingual)
 *     header, never by position.
 *  3. Rate limiting is real: three rapid requests produced HTTP 429 with
 *     `retry-after: 10`.
 *
 * @module lib/market/oil-bulletin-client
 */
import { bindColumns, excelSerialToUtcDate, numericCell, readXlsxSheet, textCell } from './xlsx';

/**
 * Live document URLs, scraped from the landing page and cross-checked against
 * the links inside bulletin #2319. The document nodes are permanent and their
 * CONTENT is replaced weekly.
 *
 * Permanence is not formally guaranteed by the Commission, so a 404 here must
 * fail loudly rather than skip — in this UI a silent skip is indistinguishable
 * from "no data", and a fuel chart that quietly stops updating is worse than
 * one that visibly breaks.
 */
export const OIL_BULLETIN_WITH_TAX_URL =
    'https://energy.ec.europa.eu/document/download/264c2d0f-f161-4ea3-a777-78faae59bea0_en';
export const OIL_BULLETIN_WITHOUT_TAX_URL =
    'https://energy.ec.europa.eu/document/download/78311f92-68f8-4b82-b5cf-1293beeaae77_en';

const FETCH_TIMEOUT_MS = 60_000;

/** Stored unit, verbatim from the bulletin's own units row. */
export const OIL_BULLETIN_UNIT = 'EUR/1000l';
export const OIL_BULLETIN_CURRENCY = 'EUR';

/**
 * Country name → our region code.
 *
 * Deliberately a SHORT list. The bulletin carries all 27 member states, and
 * one chart is rendered per region — ingesting every country would render 27
 * charts on a Bulgarian farm's Trends tab. This mirrors the cereal feed's
 * `EC_MEMBER_STATES` (BG/RO/EL/EU) so the two agree on scope.
 */
export const OIL_BULLETIN_REGIONS: Readonly<Record<string, string>> = {
    Bulgaria: 'BG',
    Romania: 'RO',
    Greece: 'EL',
};

/**
 * The EU aggregate row. Its label is multi-line and multilingual
 * ("CE/EC/EG EUR27_2020 (IV)\nMoyenne pondérée\nWeighted average\n…"), so it
 * is matched by prefix rather than by equality.
 */
const EU_ROW_PREFIX = 'CE/EC/EG EUR27_2020';

/** Thrown when the bulletin host rate-limits (HTTP 429). */
export class OilBulletinRateLimitError extends Error {
    constructor(
        message: string,
        /** Seconds from the `retry-after` header, when present. */
        public readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'OilBulletinRateLimitError';
    }
}

type FetchFn = typeof fetch;

export interface OilBulletinFetchOptions {
    withTaxUrl?: string;
    withoutTaxUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchFn;
}

export type DieselStage = 'with-tax' | 'without-tax';

export interface DieselObservation {
    /** 'BG' | 'RO' | 'EL' | 'EU'. */
    region: string;
    /** Observation date, read from the workbook — never from the filename. */
    date: Date;
    price: number;
    unit: string;
    currency: string;
    stage: DieselStage;
    /** Human label, e.g. 'Automotive gas oil (with taxes)'. */
    label: string;
}

async function getWorkbook(url: string, opts: OilBulletinFetchOptions): Promise<Uint8Array> {
    const doFetch = opts.fetchImpl ?? fetch;
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
        throw new OilBulletinRateLimitError(
            'EC Oil Bulletin rate-limited (429)',
            Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
    }
    if (!response.ok) {
        // Loud on purpose, 404 included. The document URLs carry no published
        // permanence guarantee, and a silent skip would read as "no data".
        throw new Error(`EC Oil Bulletin error ${response.status} for ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * Parse one weekly workbook into diesel observations.
 *
 * Exported for testing against a recorded fixture — the network half is
 * `fetchDieselPrices`, and keeping the parse separate is what lets the format
 * be tested without a live request.
 */
export async function parseDieselWorkbook(
    bytes: Uint8Array,
    stage: DieselStage,
): Promise<DieselObservation[]> {
    const sheet = await readXlsxSheet(bytes);
    if (sheet.rows.length < 3) {
        throw new Error('EC Oil Bulletin: workbook has no data rows');
    }

    // Row 1 is the header. The diesel column is titled in three languages —
    // "Gas oil automobile Automotive gas oil Dieselkraftstoff (I)" — so match
    // on the English fragment rather than the whole string.
    const headers = bindColumns(sheet.rows[0]);
    let dieselCol: string | undefined;
    for (const [header, col] of headers) {
        if (header.includes('automotive gas oil')) {
            dieselCol = col;
            break;
        }
    }
    if (!dieselCol) {
        throw new Error(
            `EC Oil Bulletin: no automotive-gas-oil column. Headers: ${[...headers.keys()].join(' | ')}`,
        );
    }

    // Row 2 carries the observation date (an Excel serial in A2) and the unit
    // per column. Both are read rather than assumed: the filename is known to
    // be stale, and a unit change upstream must break loudly rather than store
    // per-litre numbers under a per-1000-litre label.
    const serial = numericCell(sheet.rows[1], 'A');
    if (serial === null) {
        throw new Error('EC Oil Bulletin: no observation date in A2');
    }
    const date = excelSerialToUtcDate(serial);

    const unitCell = textCell(sheet.rows[1], dieselCol);
    if (unitCell !== '1000 l') {
        throw new Error(
            `EC Oil Bulletin: expected diesel unit '1000 l', got ${JSON.stringify(unitCell)} — ` +
                'refusing to store a price under a unit it is not quoted in',
        );
    }

    const out: DieselObservation[] = [];
    for (const row of sheet.rows.slice(2)) {
        const name = textCell(row, 'A');
        if (!name) continue;

        const region = name.startsWith(EU_ROW_PREFIX) ? 'EU' : OIL_BULLETIN_REGIONS[name];
        if (!region) continue;

        const price = numericCell(row, dieselCol);
        // A member state that did not report this week has a blank cell. Skip
        // it; do not write a zero.
        if (price === null || price <= 0) continue;

        out.push({
            region,
            date,
            price,
            unit: OIL_BULLETIN_UNIT,
            currency: OIL_BULLETIN_CURRENCY,
            stage,
            label: stage === 'with-tax'
                ? 'Automotive gas oil (with duties and taxes)'
                : 'Automotive gas oil (excluding duties and taxes)',
        });
    }
    return out;
}

/**
 * Fetch this week's Bulgarian (+RO/EL/EU) diesel prices, both tax stages.
 *
 * Uses the 14 KB weekly files rather than the 4.4 MB history file: the job
 * runs weekly, so the incremental file is all it needs, and pulling 4.4 MB
 * every Monday to extract one new row would be indefensible on a feed whose
 * whole point is a cheap number.
 */
export async function fetchDieselPrices(
    opts: OilBulletinFetchOptions = {},
): Promise<DieselObservation[]> {
    const withTax = await getWorkbook(opts.withTaxUrl ?? OIL_BULLETIN_WITH_TAX_URL, opts);
    const withoutTax = await getWorkbook(opts.withoutTaxUrl ?? OIL_BULLETIN_WITHOUT_TAX_URL, opts);
    return [
        ...(await parseDieselWorkbook(withTax, 'with-tax')),
        ...(await parseDieselWorkbook(withoutTax, 'without-tax')),
    ];
}
