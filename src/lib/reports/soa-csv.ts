/**
 * Shared SoA / applicability CSV builder.
 *
 * The Statement of Applicability and the per-scheme "applicability
 * statement" are the same artefact (requirement → control → evidence
 * rollup), so both the `reports/soa/export.csv` route and the
 * `schemes/:key/applicability.csv` route render the SAME column shape
 * through this one builder. No internal IDs are exposed — control codes
 * and titles only.
 *
 * Columns (stable, documented):
 *   AnnexAKey | Title | Section | Applicable | Justification |
 *   ImplementationStatus | ControlRefs | Owner | Frequency |
 *   EvidenceCount | OpenTasks | LastTestResult
 */
import type { SoAReportDTO } from '@/lib/dto/soa';

export const SOA_CSV_HEADERS = [
    'AnnexAKey',
    'Title',
    'Section',
    'Applicable',
    'Justification',
    'ImplementationStatus',
    'ControlRefs',
    'Owner',
    'Frequency',
    'EvidenceCount',
    'OpenTasks',
    'LastTestResult',
] as const;

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
 * That matters here specifically because these exports are the
 * hand-this-to-your-certifier path: control names and applicability
 * justifications are tenant-authored free text, and the file's whole purpose
 * is to be opened in a spreadsheet by someone outside the farm.
 *
 * A leading apostrophe is the conventional guard — spreadsheets read it as
 * "the rest is literal text" and do not display it.
 */
function neutraliseFormula(s: string): string {
    return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

/** RFC-4180-ish field escaping: quote when the value contains a comma,
 *  quote, or newline; double embedded quotes. Formula-guards first — see
 *  `neutraliseFormula` for why quoting alone is not enough. */
export function escapeCSV(value: string | null | undefined): string {
    const s = neutraliseFormula(String(value ?? ''));
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

/** Build the full CSV document (header + one row per requirement) for a
 *  SoA report. CRLF line endings (Excel-friendly), matching the original
 *  export route. */
export function buildSoACsv(report: SoAReportDTO): string {
    const rows = report.entries.map((entry) => {
        const controlRefs = entry.mappedControls
            .map((c) => `${c.code || '—'} ${c.title}`)
            .join('; ');

        const owners = [
            ...new Set(entry.mappedControls.map((c) => c.owner).filter(Boolean)),
        ].join('; ');

        const frequencies = [
            ...new Set(entry.mappedControls.map((c) => c.frequency).filter(Boolean)),
        ].join('; ');

        const applicable =
            entry.applicable === true
                ? 'Yes'
                : entry.applicable === false
                  ? 'No'
                  : 'Unmapped';

        return [
            escapeCSV(entry.requirementCode),
            escapeCSV(entry.requirementTitle),
            escapeCSV(entry.section),
            escapeCSV(applicable),
            escapeCSV(entry.justification),
            escapeCSV(entry.implementationStatus?.replace(/_/g, ' ')),
            escapeCSV(controlRefs),
            escapeCSV(owners),
            escapeCSV(frequencies),
            String(entry.evidenceCount),
            String(entry.openTaskCount),
            escapeCSV(entry.lastTestResult),
        ].join(',');
    });

    return [SOA_CSV_HEADERS.join(','), ...rows].join('\r\n');
}
