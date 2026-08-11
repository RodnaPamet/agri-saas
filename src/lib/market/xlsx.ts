/**
 * A minimal XLSX reader, for price feeds that publish spreadsheets.
 *
 * ── Why this exists at all ───────────────────────────────────────────────
 *
 * Both remaining price sources are XLSX-only. Verified, not assumed: the EC
 * Weekly Oil Bulletin offers no CSV, no JSON and no API — its `data.europa.eu`
 * entry is metadata whose every distribution points back at an HTML landing
 * page — and the World Bank Pink Sheet publishes XLSX and PDF. Every existing
 * market client is `await response.json()`, so there was nothing to reuse.
 *
 * ── Why not SheetJS ──────────────────────────────────────────────────────
 *
 * The npm-registry copy is pinned at 0.18.5 with unfixed HIGH advisories, and
 * `tests/guardrails/security-gate-strictness.test.ts` locks `npm audit` at
 * MODERATE+ for production dependencies. Adding it would either fail CI or
 * force the gate down, and the gate is worth more than the convenience.
 *
 * An XLSX is a ZIP of XML, and this repo already ships both halves: `jszip`
 * (used by the spatial importer) and `fast-xml-parser` (used by the cadastre
 * client). So this is ~200 lines of glue rather than a dependency decision.
 *
 * ── Deliberately not a spreadsheet library ───────────────────────────────
 *
 * No formulas, no styles, no dates-as-dates, no streaming. It reads a named
 * sheet into rows of cell values, and it converts Excel serials on request.
 * Everything else is the caller's problem, because everything else is where a
 * general-purpose implementation would spend its bugs.
 *
 * @module lib/market/xlsx
 */
import { XMLParser } from 'fast-xml-parser';

/**
 * Refuse an archive larger than this before decompressing it.
 *
 * The Pink Sheet is ~580 KB and the Oil Bulletin history ~4.4 MB, so 32 MB is
 * generous. It exists because a ZIP is an untrusted remote input and an
 * unbounded `loadAsync` on a zip bomb is a memory exhaustion, not an error.
 * Mirrors `DEFAULT_MAX_ARCHIVE_BYTES` in the cadastre client.
 */
export const DEFAULT_MAX_XLSX_BYTES = 32 * 1024 * 1024;

/** Refuse a sheet with more rows than this. Both feeds are ~1000 rows. */
export const DEFAULT_MAX_ROWS = 50_000;

export class XlsxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'XlsxError';
    }
}

/** One row: column letter (`'A'`, `'AE'`) → cell value. Empty cells are absent. */
export type XlsxRow = ReadonlyMap<string, string | number>;

export interface XlsxSheet {
    name: string;
    rows: XlsxRow[];
}

export interface ReadXlsxOptions {
    maxBytes?: number;
    maxRows?: number;
}

/**
 * `parseTagValue: false` is load-bearing.
 *
 * Left on, the parser coerces `<t>2026</t>` in the shared-string table to the
 * NUMBER 2026, and a column header that happens to look numeric stops matching
 * a string comparison. Every value arrives as text and is converted here, per
 * cell, from the cell's declared type — which is the only thing that actually
 * knows whether it is a number.
 */
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => name === 'sheet' || name === 'row' || name === 'c' || name === 'si' || name === 'r',
});

/**
 * A parsed XML element. `unknown` rather than `any` deliberately — the shape
 * is genuinely not known at compile time, and `any` would let a typo like
 * `sheetData.rows` compile and silently read undefined.
 */
type XmlNode = Record<string, unknown>;

/** Child element/attribute by name, or undefined. Never throws on a missing parent. */
function node(parent: XmlNode | undefined, key: string): unknown {
    return parent === undefined || parent === null ? undefined : parent[key];
}

/** Coerce a possibly-single, possibly-absent element to an array. */
function asArray<T>(v: unknown): T[] {
    if (v === undefined || v === null) return [];
    return (Array.isArray(v) ? v : [v]) as T[];
}

/** Text of a shared-string `<si>`, concatenating rich-text runs. */
function siText(si: XmlNode): string {
    const direct = si.t as unknown;
    if (typeof direct === 'string') return direct;
    if (direct && typeof direct === 'object') {
        const t = (direct as Record<string, unknown>)['#text'];
        if (typeof t === 'string') return t;
    }
    // Rich text: <si><r><t>a</t></r><r><t>b</t></r></si>
    const runs = asArray<XmlNode>(si.r);
    if (runs.length) {
        return runs
            .map((run) => {
                const t = run.t as unknown;
                if (typeof t === 'string') return t;
                if (t && typeof t === 'object') {
                    const inner = (t as Record<string, unknown>)['#text'];
                    return typeof inner === 'string' ? inner : '';
                }
                return '';
            })
            .join('');
    }
    return '';
}

/** Column letters from a cell ref: `'AE12'` → `'AE'`. */
function columnOf(ref: string): string {
    const m = /^([A-Z]+)/.exec(ref);
    return m ? m[1] : '';
}

async function loadZip(bytes: Uint8Array | ArrayBuffer, maxBytes: number) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.byteLength > maxBytes) {
        throw new XlsxError(`Workbook is ${buf.byteLength} bytes, over the ${maxBytes} limit`);
    }
    // Dynamic import mirrors src/lib/spatial/parse.ts — keeps jszip off the
    // cold-start path of everything that merely imports this module.
    const JSZip = (await import('jszip')).default;
    try {
        return await JSZip.loadAsync(buf);
    } catch (err) {
        throw new XlsxError(`Not a readable workbook: ${(err as Error).message}`);
    }
}

/**
 * Read one worksheet into rows.
 *
 * `sheetName` is matched exactly. Omit it to take the first sheet in workbook
 * order — but naming it is strongly preferred: the Pink Sheet's first sheet is
 * a hidden `AFOSHEET`, so "the first one" is not the one anybody means.
 */
export async function readXlsxSheet(
    bytes: Uint8Array | ArrayBuffer,
    sheetName?: string,
    opts: ReadXlsxOptions = {},
): Promise<XlsxSheet> {
    const zip = await loadZip(bytes, opts.maxBytes ?? DEFAULT_MAX_XLSX_BYTES);
    const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

    const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
    if (!workbookXml) throw new XlsxError('Missing xl/workbook.xml — not an XLSX');

    const workbook = parser.parse(workbookXml) as XmlNode;
    const sheets = asArray<Record<string, string>>(
        node(node(node(workbook, 'workbook') as XmlNode, 'sheets') as XmlNode, 'sheet'),
    );
    if (sheets.length === 0) throw new XlsxError('Workbook declares no sheets');

    const wanted = sheetName
        ? sheets.find((s) => s['@_name'] === sheetName)
        : sheets[0];
    if (!wanted) {
        throw new XlsxError(
            `No sheet named ${JSON.stringify(sheetName)}. Available: ${sheets
                .map((s) => s['@_name'])
                .join(', ')}`,
        );
    }

    // Resolve r:id → worksheet part through the workbook rels.
    const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    let target: string | undefined;
    if (relsXml) {
        const rels = parser.parse(relsXml) as XmlNode;
        const rel = asArray<Record<string, string>>(node(node(rels, 'Relationships') as XmlNode, 'Relationship'));
        const match = rel.find(
            (r) => r['@_Id'] === wanted['@_r:id'],
        );
        target = match?.['@_Target'];
    }
    // Fall back to positional naming when the rels part is absent or partial —
    // a workbook written by a minimal producer still has xl/worksheets/sheetN.xml.
    const index = sheets.indexOf(wanted) + 1;
    const path = target
        ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
        : `xl/worksheets/sheet${index}.xml`;

    const sheetXml = await zip.file(path)?.async('string');
    if (!sheetXml) throw new XlsxError(`Worksheet part not found: ${path}`);

    // Shared strings are optional — a workbook with only inline strings has none.
    const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
    const shared: string[] = sharedXml
        ? asArray<XmlNode>(node(node(parser.parse(sharedXml) as XmlNode, 'sst') as XmlNode, 'si')).map(siText)
        : [];

    const parsed = parser.parse(sheetXml) as XmlNode;
    const rawRows = asArray<XmlNode>(
        node(node(node(parsed, 'worksheet') as XmlNode, 'sheetData') as XmlNode, 'row'),
    );
    if (rawRows.length > maxRows) {
        throw new XlsxError(`Sheet has ${rawRows.length} rows, over the ${maxRows} limit`);
    }

    const rows: XlsxRow[] = [];
    for (const rawRow of rawRows) {
        const cells = new Map<string, string | number>();
        for (const c of asArray<XmlNode>(node(rawRow, 'c'))) {
            const ref = String(c['@_r'] ?? '');
            const col = columnOf(ref);
            if (!col) continue;

            const type = c['@_t'] as string | undefined;
            const rawV = c.v;
            const v =
                typeof rawV === 'object' && rawV !== null
                    ? (rawV as XmlNode)['#text']
                    : rawV;

            if (type === 's') {
                const idx = Number(v);
                const text = Number.isInteger(idx) ? shared[idx] : undefined;
                if (text !== undefined && text !== '') cells.set(col, text);
            } else if (type === 'inlineStr') {
                const t = node(c.is as XmlNode, 't');
                const text =
                    typeof t === 'string' ? t : String(node(t as XmlNode, '#text') ?? '');
                if (text !== '') cells.set(col, String(text));
            } else if (type === 'str' || type === 'e') {
                // `str` is a formula's cached string; `e` is an error like #N/A,
                // kept as text so a caller can see it rather than reading 0.
                if (v !== undefined && v !== '') cells.set(col, String(v));
            } else if (v !== undefined && v !== '') {
                const n = Number(v);
                // A numeric cell that will not parse is data, not a number —
                // surface it as text rather than silently storing NaN.
                cells.set(col, Number.isFinite(n) ? n : String(v));
            }
        }
        rows.push(cells);
    }

    return { name: String(wanted['@_name'] ?? ''), rows };
}

/**
 * Excel serial date → UTC `Date`.
 *
 * Excel deliberately reproduces Lotus 1-2-3's belief that 1900 was a leap
 * year, so serial 60 is a 29 February that never existed. The consequence is
 * that there is no single epoch: dates BEFORE the phantom day count from
 * 1899-12-31, dates after it from 1899-12-30.
 *
 * Using the post-1900 epoch throughout — the usual shortcut — is correct for
 * every real observation these feeds carry and wrong by one day for anything
 * in Jan/Feb 1900. That is a latent trap rather than a live bug, and it costs
 * two lines to not have.
 *
 * Serial 60 itself has no valid answer; it collapses onto 1900-02-28.
 */
export function excelSerialToUtcDate(serial: number): Date {
    if (!Number.isFinite(serial)) {
        throw new XlsxError(`Not an Excel serial date: ${serial}`);
    }
    const days = Math.floor(serial);
    const epoch = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    return new Date(epoch + days * 86_400_000);
}

/**
 * Map header text → column letter for one header row.
 *
 * Bind by HEADER, never by position. Verified reason: Bulgaria's diesel block
 * sits at `AE:AK` in today's Oil Bulletin and moves the moment a member state
 * is added or removed, and the Pink Sheet's urea column is headed `'Urea '`
 * WITH a trailing space. Comparison is trimmed and case-insensitive so neither
 * detail becomes a silent mismatch.
 *
 * Later duplicates do not overwrite earlier ones — the first column wins, so a
 * repeated header cannot quietly re-point an already-bound field.
 */
export function bindColumns(headerRow: XlsxRow): Map<string, string> {
    const byHeader = new Map<string, string>();
    for (const [col, value] of headerRow) {
        const key = String(value).trim().toLowerCase();
        if (key && !byHeader.has(key)) byHeader.set(key, col);
    }
    return byHeader;
}

/** Cell value as a finite number, or null. Never NaN. */
export function numericCell(row: XlsxRow, col: string | undefined): number | null {
    if (!col) return null;
    const v = row.get(col);
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        // The Pink Sheet marks a missing observation with the literal string
        // '...' (and other columns with the '…' ellipsis). Both must read as
        // "no observation" — never as 0, which is a price.
        const t = v.trim();
        if (t === '' || t === '...' || t === '…' || t === '..') return null;
        const n = Number(t.replace(/\s/g, ''));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Cell value as trimmed text, or null. */
export function textCell(row: XlsxRow, col: string | undefined): string | null {
    if (!col) return null;
    const v = row.get(col);
    if (v === undefined) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
}
