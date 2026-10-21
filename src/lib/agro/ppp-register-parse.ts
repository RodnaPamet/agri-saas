/**
 * Parse an uploaded БАБХ register of approved plant-protection products (#2077).
 *
 * ── Header-driven, because I have never seen the file ────────────────────
 *
 * This parser was written against the register's PUBLISHED SHAPE, not against
 * a sample: БАБХ distributes the list as a spreadsheet whose exact column
 * order has changed before and is not a contract anybody owes us. So nothing
 * here is positional. Columns are bound by HEADER TEXT through an alias table,
 * and a missing required header is a loud refusal naming both what was found
 * and what was wanted — never a silent `undefined` that becomes a blank dose.
 *
 * That asymmetry is the whole design. On a figure a farmer may transcribe onto
 * a regulated document, a parse that fails LOUDLY costs an operator one
 * message; a parse that silently mis-binds a column prints wrong doses in a
 * shape indistinguishable from right ones.
 *
 * ── Two input formats ────────────────────────────────────────────────────
 *
 * XLSX via `@/lib/market/xlsx` (already in the tree, already bounded against
 * zip bombs), and delimited text. Both are reduced to the same row shape so
 * the column binding and the cell coercion are literally the same code —
 * two parsers for one format family is two places for the dose logic to drift.
 *
 * ── Bulgarian locale details that are NOT edge cases here ────────────────
 *
 * 1. **The decimal separator is a comma.** `0,15` is fifteen hundredths. Every
 *    numeric read goes through `bgDecimal`.
 * 2. **A CSV exported from a bg-BG Excel is SEMICOLON-delimited**, precisely
 *    because the comma is taken. The delimiter is therefore sniffed, not
 *    assumed — a comma-split of a semicolon file yields one column per row and
 *    would surface as "missing header", which is at least loud, but sniffing
 *    makes the common case just work.
 * 3. **The unit often lives in the HEADER**, as `Доза (мл/дка)`, with bare
 *    numbers in the cells. So a unit is taken from the cell when present and
 *    falls back to the header's parenthetical.
 *
 * @module lib/agro/ppp-register-parse
 */
import { readXlsxSheet, textCell, numericCell, type XlsxRow } from '@/lib/market/xlsx';

/** Refuse a register with more rows than this. The real list is ~4000 rows. */
export const MAX_REGISTER_ROWS = 50_000;

/** Refuse delimited text larger than this before splitting it. */
export const MAX_REGISTER_TEXT_BYTES = 16 * 1024 * 1024;

export class PppRegisterParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PppRegisterParseError';
    }
}

/** One parsed row, shaped for `PppRegisterEntry`. */
export interface ParsedPppEntry {
    crop: string;
    productName: string;
    pppRegistrationNo: string | null;
    pests: string[];
    doseMin: number | null;
    doseMax: number | null;
    doseUnit: string | null;
    quarantinePeriodDays: number | null;
    withdrawn: boolean;
}

export interface ParsedPppRegister {
    entries: ParsedPppEntry[];
    /**
     * Rows dropped for having no crop or no product name. Blank trailing rows
     * and sub-heading rows land here, which is why this is reported rather
     * than silently tolerated: a count far above a handful means the binding
     * found the wrong columns.
     */
    skippedRows: number;
    /**
     * Rows whose dose cell was non-empty but did not start with a number.
     * Kept as entries with a null dose — the crop × product × pest mapping and
     * the quarantine period are still true — but counted, because this is the
     * number that tells an operator the dose column needs a human.
     */
    unparsedDoses: number;
    /** Headers as found, in order. Echoed on refusal and on success. */
    headers: string[];
}

/**
 * Alias table. Compared against the header lowercased, whitespace-collapsed,
 * and with any trailing parenthetical removed — so `Доза (л/дка)` binds on
 * `доза`. The first matching column wins; a later duplicate header cannot
 * re-point an already-bound field.
 */
const ALIASES: Readonly<Record<keyof typeof REQUIRED | string, readonly string[]>> = {
    crop: ['култура', 'култури', 'crop', 'културa'],
    productName: [
        'продукт',
        'продукти',
        'прз',
        'продукт за растителна защита',
        'търговско име',
        'търговско наименование',
        'продукт/прз',
        'product',
    ],
    pppRegistrationNo: [
        'регистрационен номер',
        'рег. номер',
        'рег.номер',
        'рег. №',
        'рег.№',
        'номер на разрешението',
        'разрешение',
        'удостоверение',
    ],
    pests: [
        'вредител',
        'вредители',
        'неприятел',
        'неприятели',
        'болест',
        'болести',
        'срещу',
        'вредна причина',
        'вредни причини',
        'плевели',
    ],
    dose: ['доза', 'дози', 'дозировка', 'доза на приложение', 'разходна норма', 'dose'],
    quarantinePeriodDays: [
        'карантинен срок',
        'карантинен период',
        'срок на карантина',
        'карантина',
        'последно третиране преди прибиране',
    ],
    withdrawn: [
        'отнет',
        'заличен',
        'статус',
        'състояние',
        'прекратен',
        'оттеглен',
        'withdrawn',
        'status',
    ],
} as const;

/** Fields without which a row cannot be a register entry at all. */
const REQUIRED = { crop: true, productName: true } as const;

/** A row of either format: opaque cell key → value. Shared with XLSX's own shape. */
type RegisterRow = XlsxRow;

/** Lowercase, collapse whitespace, drop a trailing parenthetical. */
function normalizeHeader(raw: string): string {
    return raw
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s*\([^)]*\)\s*$/, '')
        .replace(/[:. ]+$/, '')
        .trim();
}

/** The parenthetical a header carries, e.g. `Доза (мл/дка)` → `мл/дка`. */
function headerParenthetical(raw: string): string | null {
    const m = /\(([^)]*)\)\s*$/.exec(raw.trim());
    const inner = m?.[1]?.trim();
    return inner ? inner : null;
}

interface Binding {
    /** Field name → cell key. */
    columns: Map<string, string>;
    /** Field name → unit taken from that column's header parenthetical. */
    headerUnits: Map<string, string>;
    headers: string[];
}

function bindHeaderRow(header: RegisterRow): Binding {
    const columns = new Map<string, string>();
    const headerUnits = new Map<string, string>();
    const headers: string[] = [];

    for (const [key, value] of header) {
        const raw = String(value);
        if (raw.trim()) headers.push(raw.trim());
        const norm = normalizeHeader(raw);
        if (!norm) continue;
        for (const [field, aliases] of Object.entries(ALIASES)) {
            if (columns.has(field)) continue;
            if (!aliases.includes(norm)) continue;
            columns.set(field, key);
            const unit = headerParenthetical(raw);
            if (unit) headerUnits.set(field, unit);
            break;
        }
    }

    return { columns, headerUnits, headers };
}

/** Does a binding have everything a row needs to be an entry? */
function isComplete(binding: Binding): boolean {
    return Object.keys(REQUIRED).every((f) => binding.columns.has(f));
}

/**
 * How many leading rows to try as the header.
 *
 * A real register export is not guaranteed to start with its header: a title,
 * an issuing-order reference and a blank row above it are all ordinary. So the
 * header is FOUND rather than assumed to be row 1.
 *
 * Bounded, and bounded low, because the alternative failure is worse than the
 * one it fixes: an unbounded scan down a file whose columns we cannot bind
 * would eventually hit a data row that happens to contain the word «култура»
 * and start reading from the middle, silently losing everything above it. Ten
 * rows is more preamble than any published version has carried.
 */
export const MAX_HEADER_SCAN_ROWS = 10;

/**
 * Find the header row, or refuse naming what was tried.
 *
 * The refusal is deliberately verbose — the headers it found, the fields it
 * could not bind, and every accepted spelling of each. An operator uploading a
 * new year's file is the only person who will ever read it, and the message is
 * the whole of their debugging.
 */
function findHeaderRow(rows: readonly RegisterRow[]): { at: number; binding: Binding } {
    const limit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
    for (let i = 0; i < limit; i += 1) {
        const binding = bindHeaderRow(rows[i]!);
        if (isComplete(binding)) return { at: i, binding };
    }

    const first = bindHeaderRow(rows[0]!);
    const missing = Object.keys(REQUIRED).filter((f) => !first.columns.has(f));
    throw new PppRegisterParseError(
        `Could not find ${missing.length === 1 ? 'a column' : 'columns'} for ` +
            `${missing.join(', ')} in the first ${limit} row(s). ` +
            `Row 1 reads: ${
                first.headers.length > 0 ? first.headers.join(' | ') : '(blank)'
            }. Accepted names: ${missing
                .map((f) => `${f} = ${ALIASES[f]!.join(' / ')}`)
                .join('; ')}.`,
    );
}

/**
 * A Bulgarian decimal: comma for the point, spaces tolerated.
 *
 * Returns null rather than NaN, because NaN survives arithmetic and lands in
 * the database as a number nobody wrote.
 */
export function bgDecimal(raw: string): number | null {
    const t = raw.replace(/[\s ]/g, '').replace(',', '.');
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

export interface ParsedDose {
    min: number | null;
    max: number | null;
    unit: string | null;
    /** True when the cell held text but no leading number. */
    unparsed: boolean;
}

/**
 * Parse a dose cell: a single value, a range, or an upper bound.
 *
 * Anchored at the START of the string on purpose. A dose reads
 * `0,1 л/100 л вода`, and a scan for "all the numbers" would take 100 as the
 * upper bound of the range — a thousandfold error, printed like any other
 * number. So the numeric part must be leading, and everything after it is the
 * unit, whatever it contains.
 */
export function parseDose(raw: string | null, headerUnit?: string | null): ParsedDose {
    const text = (raw ?? '').replace(/[–—−]/g, '-').replace(/÷/g, '-').trim();
    if (!text) return { min: null, max: null, unit: headerUnit ?? null, unparsed: false };

    const m =
        /^(до\s+)?(\d+(?:[.,]\d+)?)(?:\s*(?:-|до)\s*(\d+(?:[.,]\d+)?))?\s*(.*)$/iu.exec(text);
    if (!m) return { min: null, max: null, unit: headerUnit ?? null, unparsed: true };

    const upperBoundOnly = Boolean(m[1]);
    const first = bgDecimal(m[2] ?? '');
    const second = m[3] ? bgDecimal(m[3]) : null;
    const rest = (m[4] ?? '').replace(/\s+/g, ' ').trim();
    const unit = rest || headerUnit || null;

    if (first === null) return { min: null, max: null, unit, unparsed: true };

    // `до 200` is an upper bound with no stated floor. Storing 200 as both
    // bounds would assert a minimum dose the register does not give.
    if (upperBoundOnly && second === null) return { min: null, max: first, unit, unparsed: false };

    // A single value is stored as a degenerate range, so every read is a range
    // read and no consumer needs a "which field is set" branch.
    const lo = second === null ? first : Math.min(first, second);
    const hi = second === null ? first : Math.max(first, second);
    return { min: lo, max: hi, unit, unparsed: false };
}

/** Markers that mean "no longer approved", in a flag column or a status column. */
const WITHDRAWN_MARKERS = [
    'отнет',
    'заличен',
    'прекрат',
    'оттегл',
    'забран',
    'изтек',
    'withdraw',
    'revoked',
];
const TRUE_TOKENS = new Set(['да', 'yes', 'true', '1', 'x', '✓', '✔', 'y']);

/**
 * Read the withdrawal column, which comes in two shapes in the wild: a yes/no
 * flag, or a status word. One function covers both — a status of `разрешен`
 * matches no marker and is not a true-token, so it reads false, which is the
 * safe direction for the only value that matters.
 */
export function isWithdrawn(raw: string | null): boolean {
    const t = (raw ?? '').trim().toLowerCase();
    if (!t) return false;
    if (TRUE_TOKENS.has(t)) return true;
    return WITHDRAWN_MARKERS.some((marker) => t.includes(marker));
}

/** Split a pest cell into its listed causes. */
export function splitPests(raw: string | null): string[] {
    if (!raw) return [];
    const seen = new Set<string>();
    for (const part of raw.split(/[,;\n•]/u)) {
        const t = part.replace(/\s+/g, ' ').trim();
        if (t) seen.add(t);
    }
    return [...seen];
}

/** Turn rows into entries. Shared by both input formats. */
function readRows(rows: readonly RegisterRow[]): ParsedPppRegister {
    const { at, binding } = findHeaderRow(rows);
    const { columns, headerUnits, headers } = binding;
    const body = rows.slice(at + 1);
    const entries: ParsedPppEntry[] = [];
    let skippedRows = 0;
    let unparsedDoses = 0;

    for (const row of body) {
        const crop = textCell(row, columns.get('crop'));
        const productName = textCell(row, columns.get('productName'));
        if (!crop || !productName) {
            skippedRows += 1;
            continue;
        }

        const dose = parseDose(textCell(row, columns.get('dose')), headerUnits.get('dose') ?? null);
        if (dose.unparsed) unparsedDoses += 1;

        const quarantine = numericCell(row, columns.get('quarantinePeriodDays'));

        entries.push({
            crop,
            productName,
            pppRegistrationNo: textCell(row, columns.get('pppRegistrationNo')),
            pests: splitPests(textCell(row, columns.get('pests'))),
            doseMin: dose.min,
            doseMax: dose.max,
            doseUnit: dose.unit,
            // A quarantine period is a whole number of days. A fractional or
            // negative cell is not a shorter interval — it is a mis-bound
            // column — so it reads as absent rather than being rounded into a
            // figure that looks authoritative.
            quarantinePeriodDays:
                quarantine !== null && Number.isInteger(quarantine) && quarantine >= 0
                    ? quarantine
                    : null,
            withdrawn: isWithdrawn(textCell(row, columns.get('withdrawn'))),
        });
    }

    return { entries, skippedRows, unparsedDoses, headers };
}

/**
 * Split delimited text into rows, honouring quotes.
 *
 * Hand-rolled because the repo has no CSV dependency and adding one for this
 * is a worse trade than ~40 lines: quoted fields, doubled quotes inside them,
 * embedded newlines, a BOM, and CRLF are the whole specification a register
 * export can exercise.
 */
export function splitDelimited(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    // Strip a UTF-8 BOM: Excel writes one, and it would otherwise become part
    // of the FIRST header, which is the one header that must bind.
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else quoted = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') {
            quoted = true;
        } else if (ch === delimiter) {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i += 1;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += ch;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/**
 * Sniff the delimiter.
 *
 * A bg-BG Excel writes `;` because the comma is the decimal separator, an
 * en-US one writes `,`, and a copy-paste out of a web table arrives
 * tab-separated.
 *
 * **Sniffed across the leading rows, not from the first one.** Sniffing the
 * first line fails in exactly the case `findHeaderRow` exists to handle: a
 * title row (`РЕГИСТЪР НА РАЗРЕШЕНИТЕ ЗА УПОТРЕБА ПРЗ`) contains none of the
 * three candidates, so every count is zero, the comma wins by default, and a
 * semicolon-delimited file collapses to ONE column per row — which then
 * surfaces as "could not find a column for crop" and reads like a wrong file
 * rather than a wrong split. Found by the preamble test, which is the only
 * reason the two features work together.
 *
 * The score is the per-line MAXIMUM rather than the total, so one comma in a
 * title cannot outvote the header's six semicolons. Ties resolve to the comma.
 */
export function sniffDelimiter(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .slice(0, MAX_HEADER_SCAN_ROWS + 1);
    const candidates = [',', ';', '\t'];
    let best = ',';
    let bestScore = 0;
    for (const d of candidates) {
        const score = Math.max(0, ...lines.map((l) => l.split(d).length - 1));
        if (score > bestScore) {
            best = d;
            bestScore = score;
        }
    }
    return best;
}

/** Rows of strings → the shared row shape, keyed by column index. */
function toRows(cells: readonly string[][]): RegisterRow[] {
    return cells.map((cols) => {
        const row = new Map<string, string>();
        cols.forEach((value, i) => {
            if (value.trim() !== '') row.set(String(i), value);
        });
        return row;
    });
}

/** Parse a delimited register (CSV / semicolon / TSV). */
export function parsePppRegisterText(text: string): ParsedPppRegister {
    if (Buffer.byteLength(text, 'utf8') > MAX_REGISTER_TEXT_BYTES) {
        throw new PppRegisterParseError('The file is too large to parse.');
    }
    const cells = splitDelimited(text, sniffDelimiter(text));
    const nonEmpty = cells.filter((r) => r.some((c) => c.trim() !== ''));
    if (nonEmpty.length === 0) throw new PppRegisterParseError('The file is empty.');
    if (nonEmpty.length - 1 > MAX_REGISTER_ROWS) {
        throw new PppRegisterParseError(
            `The file has ${nonEmpty.length - 1} data rows; the limit is ${MAX_REGISTER_ROWS}.`,
        );
    }
    return readRows(toRows(nonEmpty));
}

/** Parse an XLSX register. `sheetName` defaults to the first sheet. */
export async function parsePppRegisterXlsx(
    bytes: Uint8Array | ArrayBuffer,
    sheetName?: string,
): Promise<ParsedPppRegister> {
    const sheet = await readXlsxSheet(bytes, sheetName, { maxRows: MAX_REGISTER_ROWS + 1 });
    const rows = sheet.rows.filter((r) => r.size > 0);
    if (rows.length === 0) throw new PppRegisterParseError('The sheet is empty.');
    return readRows(rows);
}
