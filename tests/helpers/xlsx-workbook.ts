/**
 * A minimal XLSX writer, so spreadsheet fixtures are readable as source.
 *
 * Extracted from `tests/unit/market/xlsx.test.ts` when a second suite
 * (`ppp-register-parse`) needed the same thing. It writes only what
 * `@/lib/market/xlsx` reads: a workbook part, per-sheet worksheet parts, the
 * rels that map one to the other, and a shared-string table. No styles, no
 * dates, no formulas.
 *
 * `opts` exists for the reader's own negative cases: `inlineStrings` exercises
 * the `t="inlineStr"` branch, `omitRels` the positional fallback for a
 * workbook written by a minimal producer.
 *
 * @module tests/helpers/xlsx-workbook
 */

export type Cell = string | number | null;

/** Build a real XLSX from rows. Strings go through the shared-string table. */
export async function makeWorkbook(
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
