/**
 * Shared CSV cell escaping — parsing AND formula-evaluation safety.
 *
 * This lived in `soa-csv.ts` until the compliance uproot removed the
 * Statement of Applicability. The escaper is not SoA-specific and losing it
 * would have left every remaining CSV export writing tenant free text into a
 * file whose whole purpose is to be opened in a spreadsheet, so it moved here
 * as the one shared implementation.
 */

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA.
 *
 * Excel, LibreOffice and Sheets all evaluate a cell beginning `=`, `+`, `-`
 * or `@` — and the tab / carriage-return variants, which some versions strip
 * before parsing.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Neutralise a cell that would otherwise execute when the file is opened.
 *
 * Quote-escaping is about PARSING; this is about EVALUATION, and they are
 * different problems. `"=cmd|'/c calc'!A1"` is perfectly valid CSV — the
 * quoting is correct — and Excel still runs it.
 *
 * A leading apostrophe is the conventional guard — spreadsheets read it as
 * "the rest is literal text" and do not display it.
 */
function neutraliseFormula(s: string): string {
    return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

/**
 * RFC-4180-ish field escaping: quote when the value contains a comma, quote,
 * or newline; double embedded quotes. Formula-guards first — see
 * `neutraliseFormula` for why quoting alone is not enough.
 */
export function escapeCSV(value: string | number | null | undefined): string {
    const s = neutraliseFormula(String(value ?? ''));
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}
