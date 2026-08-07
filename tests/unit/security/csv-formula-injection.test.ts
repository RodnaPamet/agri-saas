/**
 * A CSV handed to a certifier cannot execute when they open it.
 *
 * `escapeCSV` quoted correctly and guarded nothing. Quoting is about
 * PARSING; formula injection is about EVALUATION, and they are different
 * problems — `"=cmd|'/c calc'!A1"` is perfectly valid CSV, the quoting is
 * right, and Excel still runs it.
 *
 * It matters on these exports specifically because they are the
 * hand-this-to-your-certifier path. Control names and applicability
 * justifications are tenant-authored free text, and the file's entire purpose
 * is to be opened in a spreadsheet by someone outside the farm — a person who
 * has no reason to distrust a document their client sent them.
 *
 * Two call sites were affected: `soa-csv.ts` (the SoA export) and the two
 * hand-rolled `"${c.replace(/"/g,'""')}"` joins in `coverage.ts`, which now
 * route through the same escaper rather than reimplementing half of it.
 */
import { escapeCSV } from '@/lib/reports/csv-escape';

describe('escapeCSV neutralises formulas', () => {
    it.each([
        ['=', '=1+1'],
        ['plus', '+1+1'],
        ['minus', '-1+1'],
        ['at', '@SUM(A1:A9)'],
        ['tab', '\t=1+1'],
        ['carriage return', '\r=1+1'],
    ])('guards a cell leading with %s', (_label, value) => {
        const out = escapeCSV(value);
        // The guard is a leading apostrophe — spreadsheets read it as "the
        // rest is literal" and do not display it.
        expect(out.replace(/^"/, '').startsWith("'")).toBe(true);
    });

    it('guards the classic command-execution payload', () => {
        const payload = '=cmd|\'/c calc\'!A1';
        const out = escapeCSV(payload);
        expect(out).toContain("'=cmd");
    });

    it('guards a DDE payload that is also valid quoted CSV', () => {
        // The point of the test: correct quoting and safe-to-open are
        // independent properties. This value needs quoting AND guarding.
        const payload = '=HYPERLINK("http://evil","click me"),trailing';
        const out = escapeCSV(payload);
        expect(out.startsWith('"\'=')).toBe(true);
    });
});

describe('escapeCSV still escapes correctly', () => {
    it('leaves an ordinary value untouched', () => {
        expect(escapeCSV('Spray records kept')).toBe('Spray records kept');
    });

    it('does not guard a value that merely CONTAINS an operator', () => {
        // Only a LEADING operator is evaluated. Guarding mid-string values
        // would corrupt ordinary text like "pH 6.5-7.0".
        expect(escapeCSV('pH 6.5-7.0')).toBe('pH 6.5-7.0');
        expect(escapeCSV('N=180 kg/ha')).toBe('N=180 kg/ha');
    });

    it('quotes a value containing a comma', () => {
        expect(escapeCSV('Petrov, Ivan')).toBe('"Petrov, Ivan"');
    });

    it('doubles embedded quotes', () => {
        expect(escapeCSV('He said "yes"')).toBe('"He said ""yes"""');
    });

    it('quotes a value containing a newline', () => {
        expect(escapeCSV('line one\nline two')).toBe('"line one\nline two"');
    });

    it('renders null and undefined as empty', () => {
        expect(escapeCSV(null)).toBe('');
        expect(escapeCSV(undefined)).toBe('');
    });

    it('guards and quotes together, in that order', () => {
        // Guard first, then quote — otherwise the apostrophe lands outside
        // the quotes and the cell parses as `'` followed by a quoted string.
        expect(escapeCSV('=A1,B2')).toBe('"\'=A1,B2"');
    });
});
