/**
 * The XLSX reader.
 *
 * Two price feeds publish spreadsheets and nothing else, so this module is
 * the only thing standing between a remote workbook and a price a farmer
 * reads. The interesting failures are not "it threw" — they are the ones
 * that produce a plausible WRONG number: a two-day epoch shift, a column
 * bound by position after a country was added, a missing-value marker read
 * as zero.
 *
 * Most cases synthesise a workbook in-test, so the bytes under test are
 * visible in the diff. ONE case reads a real 14 KB EC Weekly Oil Bulletin,
 * because a synthesised workbook can only ever confirm my own assumptions
 * about the format.
 *
 * Each `it()` names the production break it catches.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import {
    DEFAULT_MAX_XLSX_BYTES,
    XlsxError,
    bindColumns,
    excelSerialToUtcDate,
    numericCell,
    readXlsxSheet,
    textCell,
} from '@/lib/market/xlsx';

// ── A minimal workbook writer, so the fixtures are readable ──────────

type Cell = string | number | null;

/** Build a real XLSX from rows. Strings go through the shared-string table. */
async function makeWorkbook(
    sheets: Array<{ name: string; rows: Cell[][] }>,
    opts: { inlineStrings?: boolean; omitRels?: boolean } = {},
): Promise<Uint8Array> {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    const shared: string[] = [];
    const sharedIndex = (s: string) => {
        const at = shared.indexOf(s);
        if (at >= 0) return at;
        shared.push(s);
        return shared.length - 1;
    };

    const colLetter = (i: number) => {
        let n = i;
        let out = '';
        do {
            out = String.fromCharCode(65 + (n % 26)) + out;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        return out;
    };

    const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    sheets.forEach((sheet, sIdx) => {
        const rowXml = sheet.rows
            .map((row, r) => {
                const cells = row
                    .map((value, c) => {
                        if (value === null || value === '') return '';
                        const ref = `${colLetter(c)}${r + 1}`;
                        if (typeof value === 'number') {
                            return `<c r="${ref}"><v>${value}</v></c>`;
                        }
                        if (opts.inlineStrings) {
                            return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
                        }
                        return `<c r="${ref}" t="s"><v>${sharedIndex(value)}</v></c>`;
                    })
                    .join('');
                return `<row r="${r + 1}">${cells}</row>`;
            })
            .join('');
        zip.file(
            `xl/worksheets/sheet${sIdx + 1}.xml`,
            `<?xml version="1.0"?><worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
        );
    });

    const sheetTags = sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('');
    zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook><sheets>${sheetTags}</sheets></workbook>`);

    if (!opts.omitRels) {
        const rels = sheets
            .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
            .join('');
        zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships>${rels}</Relationships>`);
    }

    if (shared.length && !opts.inlineStrings) {
        const si = shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('');
        zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst>${si}</sst>`);
    }

    return zip.generateAsync({ type: 'uint8array' });
}

// ── Cases ────────────────────────────────────────────────────────────

describe('reading a sheet', () => {
    it('reads shared strings and numbers into column-keyed rows', async () => {
        const wb = await makeWorkbook([
            { name: 'Data', rows: [['Country', 'Diesel'], ['Bulgaria', 1742.6]] },
        ]);
        const sheet = await readXlsxSheet(wb, 'Data');
        expect(sheet.name).toBe('Data');
        expect(sheet.rows).toHaveLength(2);
        expect(sheet.rows[0].get('A')).toBe('Country');
        expect(sheet.rows[1].get('A')).toBe('Bulgaria');
        expect(sheet.rows[1].get('B')).toBe(1742.6);
    });

    it('reads inline strings too — not every producer uses the shared table', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['Urea', 400]] }], { inlineStrings: true });
        const sheet = await readXlsxSheet(wb, 'Data');
        expect(sheet.rows[0].get('A')).toBe('Urea');
        expect(sheet.rows[0].get('B')).toBe(400);
    });

    // Break: a header that looks numeric being coerced to a number, so a
    // string comparison against it silently stops matching.
    it('keeps a numeric-looking header as text', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['2026', 'x']] }]);
        const sheet = await readXlsxSheet(wb, 'Data');
        expect(sheet.rows[0].get('A')).toBe('2026');
        expect(typeof sheet.rows[0].get('A')).toBe('string');
    });

    // Break: taking "the first sheet" on the Pink Sheet, whose first sheet
    // is a hidden AFOSHEET — not the one anybody means.
    it('selects a sheet by name, not by position', async () => {
        const wb = await makeWorkbook([
            { name: 'Hidden', rows: [['junk']] },
            { name: 'Monthly Prices', rows: [['DAP', 781.3]] },
        ]);
        const sheet = await readXlsxSheet(wb, 'Monthly Prices');
        expect(sheet.rows[0].get('A')).toBe('DAP');
    });

    it('names the sheets it does have when asked for one it does not', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['a']] }]);
        await expect(readXlsxSheet(wb, 'Nope')).rejects.toThrow(/Available: Data/);
    });

    it('falls back to positional worksheet naming when the rels part is absent', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['a', 1]] }], { omitRels: true });
        const sheet = await readXlsxSheet(wb, 'Data');
        expect(sheet.rows[0].get('B')).toBe(1);
    });

    it('leaves empty cells absent rather than storing a blank', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['a', null, 3]] }]);
        const sheet = await readXlsxSheet(wb, 'Data');
        expect(sheet.rows[0].has('B')).toBe(false);
        expect(sheet.rows[0].get('C')).toBe(3);
    });
});

describe('refusing bad input', () => {
    it('rejects bytes that are not a zip', async () => {
        await expect(readXlsxSheet(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(XlsxError);
    });

    it('rejects a zip that is not a workbook', async () => {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();
        zip.file('hello.txt', 'not a workbook');
        await expect(readXlsxSheet(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
            /Missing xl\/workbook.xml/,
        );
    });

    // Break: an unbounded loadAsync on an untrusted remote archive.
    it('refuses an oversized archive before decompressing it', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['a']] }]);
        await expect(readXlsxSheet(wb, 'Data', { maxBytes: 10 })).rejects.toThrow(/over the 10 limit/);
        expect(DEFAULT_MAX_XLSX_BYTES).toBeGreaterThan(4.4 * 1024 * 1024); // the biggest real file
    });

    it('refuses a sheet with more rows than the cap', async () => {
        const wb = await makeWorkbook([{ name: 'Data', rows: [['a'], ['b'], ['c']] }]);
        await expect(readXlsxSheet(wb, 'Data', { maxRows: 2 })).rejects.toThrow(/over the 2 limit/);
    });
});

describe('excel serial dates', () => {
    // Break: THE two-day shift. Excel's epoch is 1899-12-30 because it
    // reproduces Lotus 1-2-3's belief that 1900 was a leap year. Get it
    // wrong and a weekly series looks fine until it meets another source.
    it.each([
        [46237, '2026-08-03'],
        [1, '1900-01-01'],
        [59, '1900-02-28'],
        [61, '1900-03-01'],
        [44927, '2023-01-01'],
    ])('converts serial %p to %p', (serial, iso) => {
        expect(excelSerialToUtcDate(serial).toISOString().slice(0, 10)).toBe(iso);
    });

    // Excel's serial 60 is 29 Feb 1900, a day that never existed. There is
    // no right answer; the contract is that it collapses onto the 28th
    // rather than silently producing a date one day off for everything
    // before it.
    it('collapses the phantom 1900-02-29 rather than shifting its neighbours', () => {
        expect(excelSerialToUtcDate(60).toISOString().slice(0, 10)).toBe('1900-02-28');
        expect(excelSerialToUtcDate(59).toISOString().slice(0, 10)).toBe('1900-02-28');
        expect(excelSerialToUtcDate(61).toISOString().slice(0, 10)).toBe('1900-03-01');
    });

    it('truncates a fractional serial to its day', () => {
        expect(excelSerialToUtcDate(46237.75).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    });

    it('throws rather than returning an Invalid Date', () => {
        expect(() => excelSerialToUtcDate(Number.NaN)).toThrow(XlsxError);
    });
});

describe('binding columns by header', () => {
    // Break: binding by POSITION. Bulgaria's block sits at AE:AK in the Oil
    // Bulletin history and moves the moment a member state is added.
    it('is insensitive to case and to a trailing space', async () => {
        // The Pink Sheet's urea header really is 'Urea ' with a trailing space.
        const wb = await makeWorkbook([{ name: 'D', rows: [['Phosphate rock', 'DAP', 'Urea ']] }]);
        const sheet = await readXlsxSheet(wb, 'D');
        const cols = bindColumns(sheet.rows[0]);
        expect(cols.get('urea')).toBe('C');
        expect(cols.get('dap')).toBe('B');
    });

    it('keeps the FIRST column when a header repeats', async () => {
        const wb = await makeWorkbook([{ name: 'D', rows: [['DAP', 'DAP']] }]);
        const sheet = await readXlsxSheet(wb, 'D');
        expect(bindColumns(sheet.rows[0]).get('dap')).toBe('A');
    });
});

describe('cell accessors', () => {
    // Break: the Pink Sheet marks a missing observation with the literal
    // string '...'. Read as 0, that is a fertiliser priced at nothing.
    it.each(['...', '…', '..', '', '   ', 'n/a'])('reads the missing marker %p as null, never 0', async (marker) => {
        const wb = await makeWorkbook([{ name: 'D', rows: [[marker]] }]);
        const sheet = await readXlsxSheet(wb, 'D');
        expect(numericCell(sheet.rows[0], 'A')).toBeNull();
    });

    it('reads a real number', async () => {
        const wb = await makeWorkbook([{ name: 'D', rows: [[781.3]] }]);
        const sheet = await readXlsxSheet(wb, 'D');
        expect(numericCell(sheet.rows[0], 'A')).toBe(781.3);
    });

    it('returns null for an unbound column rather than throwing', async () => {
        const wb = await makeWorkbook([{ name: 'D', rows: [[1]] }]);
        const sheet = await readXlsxSheet(wb, 'D');
        expect(numericCell(sheet.rows[0], undefined)).toBeNull();
        expect(textCell(sheet.rows[0], undefined)).toBeNull();
    });

    it('trims text and reads a blank as null', async () => {
        const wb = await makeWorkbook([{ name: 'D', rows: [['  Bulgaria  ', '   ']] }]);
        const sheet = await readXlsxSheet(wb, 'D');
        expect(textCell(sheet.rows[0], 'A')).toBe('Bulgaria');
        expect(textCell(sheet.rows[0], 'B')).toBeNull();
    });
});

// ── The real thing ───────────────────────────────────────────────────

describe('a real EC Weekly Oil Bulletin', () => {
    // A synthesised workbook proves the reader matches MY model of the
    // format. Only a real file proves the model. This is the 14 KB weekly
    // bulletin, checked in unmodified.
    const load = () =>
        new Uint8Array(
            readFileSync(path.join(__dirname, '../../fixtures/market/oil-bulletin-weekly.xlsx')),
        );

    it('parses, and binds the diesel column by its (long, multilingual) header', async () => {
        const sheet = await readXlsxSheet(load());
        const cols = bindColumns(sheet.rows[0]);
        const diesel = [...cols.keys()].find((h) => h.includes('automotive gas oil'));
        expect(diesel).toBeDefined();
        expect(cols.get(diesel!)).toBe('C');
    });

    it('carries Bulgaria with a finite diesel price', async () => {
        const sheet = await readXlsxSheet(load());
        const bg = sheet.rows.find((r) => textCell(r, 'A') === 'Bulgaria');
        expect(bg).toBeDefined();
        const price = numericCell(bg!, 'C');
        expect(price).not.toBeNull();
        // Sanity band rather than an exact value: the file is replaced weekly
        // upstream, and pinning 1742.6 would make this test a calendar bomb.
        expect(price!).toBeGreaterThan(500);
        expect(price!).toBeLessThan(5000);
    });

    // Break: deriving the observation date from the URL or the
    // content-disposition filename — which, verified, says 2024-02-19 while
    // the file contains 2026-08-03 data.
    it('carries its own observation date as an Excel serial in A2', async () => {
        const sheet = await readXlsxSheet(load());
        const serial = numericCell(sheet.rows[1], 'A');
        expect(typeof serial).toBe('number');
        const date = excelSerialToUtcDate(serial!);
        expect(date.getUTCFullYear()).toBeGreaterThanOrEqual(2024);
        expect(Number.isNaN(date.getTime())).toBe(false);
    });

    it('states its unit row as per-1000-litres', async () => {
        const sheet = await readXlsxSheet(load());
        expect(textCell(sheet.rows[1], 'C')).toBe('1000 l');
    });
});
