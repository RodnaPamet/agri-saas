/**
 * Epic 58 — date-input rollout guardrail.
 *
 * After the final-hardening pass, no product surface in `src/app`
 * or `src/components` ships a native `<input type="date">` /
 * `<input type="datetime-local">` — every date field routes through
 * the shared `<DatePicker>` / `<DateRangePicker>` or (by explicit
 * exemption) a documented edge case.
 *
 * The guardrail scans source files for the JSX forms of:
 *   - `<input … type="date" …>`
 *   - `<Input … type="date" …>`   (shared form-field primitive)
 *   - `<input … type="datetime-local" …>`
 *   - `<Input … type="datetime-local" …>`
 *
 * Non-JSX occurrences (comments, docstring examples) are ignored so
 * the migration history can stay in the code.
 *
 * The allowlist is intentionally empty. A contributor adding a new
 * date field should read `docs/date-picker.md` and reach for the
 * shared picker. If you truly need an exemption, prove it and add
 * the file path below with a short justification comment.
 */

import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = [
    path.join(ROOT, 'src/app'),
    path.join(ROOT, 'src/components'),
];

/**
 * Files explicitly exempted from the ban. Empty on purpose. Adding
 * an entry requires a comment next to it explaining why the shared
 * DatePicker doesn't fit — e.g. the date field is rendered in a
 * stand-alone static HTML fragment (server-only), or it's part of a
 * print-only view that cannot mount React hooks.
 */
const ALLOWED_FILES = new Set<string>([
    // (none)
]);

/** Match the JSX form of a date-shaped input, tolerant of whitespace. */
const DATE_INPUT_RE =
    /<(?:input|Input)\b[^>]*\btype\s*=\s*["'](?:date|datetime-local)["'][^>]*>/g;

/**
 * The file set, via the shared collector rather than a hand-rolled walk.
 *
 * `selector-teeth` measured the old local `walk()` and it SURVIVED being
 * gutted to `return []`: the single assertion below iterates `allFiles`, so
 * an empty list satisfies it and the guard reports a clean repo having
 * opened nothing.
 *
 * The floor is teeth the local walk never had — but a floor alone is NOT
 * enough, which is the lesson from the sibling fix in
 * `date-display-consistency`: gutting this wrapper returns before
 * `collectSourceFiles` is ever called, so its floor never runs. The positive
 * control in the describe block is what actually fails on an empty set.
 */
function collectScannedFiles(): string[] {
    return collectSourceFiles({
        roots: SCAN_DIRS,
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
        floor: 200,
    });
}

/**
 * Strip JSX block comments, regular block comments, and line
 * comments so any migration note that mentions the old widget
 * literally doesn't trip the regex.
 */
function stripComments(src: string): string {
    return src
        // JSX block comments of the form `{` + `/` + `*` + ... + `*` + `/` + `}`
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        // Regular block comments
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // Line comments
        .replace(/^\s*\/\/.*$/gm, '');
}

describe('Epic 58 — no native date inputs in app code', () => {
    const allFiles = collectScannedFiles();

    it('the scan reaches app code (positive control)', () => {
        // The assertion below is satisfied by an EMPTY file set, so without
        // this the guard passes having opened nothing. `selector-teeth`
        // measured exactly that: `walk` survived `return []`.
        expect(allFiles.length).toBeGreaterThan(200);
        expect(allFiles.some((f) => f.includes(`${path.sep}src${path.sep}app${path.sep}`))).toBe(true);
    });

    it('stripComments removes comments and KEEPS code (positive control)', () => {
        // The second dead selector: `stripComments` survived being gutted to
        // `''`, which makes every file look empty so the regex never matches.
        // An assertion that it strips is not enough — `''` strips everything.
        // What fails on the gut is asserting what must SURVIVE.
        const src = [
            '{/* <input type="date" /> in a JSX comment */}',
            '/* <input type="date" /> in a block comment */',
            '// <input type="date" /> in a line comment',
            '<input type="date" name="sowing" />',
        ].join('\n');
        const out = stripComments(src);

        // Survives — this is the assertion the `''` gut fails.
        expect(out).toContain('name="sowing"');
        expect(out.match(DATE_INPUT_RE)).toHaveLength(1);

        // Removed — the behaviour the function exists for.
        expect(out).not.toContain('JSX comment');
        expect(out).not.toContain('block comment');
        expect(out).not.toContain('line comment');
    });

    it('no <input type="date" | datetime-local"> outside the allowlist', () => {
        const violations: { file: string; line: number; snippet: string }[] = [];

        for (const file of allFiles) {
            if (ALLOWED_FILES.has(file)) continue;
            const rawSrc = fs.readFileSync(file, 'utf-8');
            const stripped = stripComments(rawSrc);
            const matches = stripped.match(DATE_INPUT_RE);
            if (!matches) continue;

            // For the report, locate each match line number in the
            // ORIGINAL source so the pointer is accurate.
            for (const match of matches) {
                const idx = rawSrc.indexOf(match);
                const line = rawSrc.slice(0, idx).split('\n').length;
                violations.push({
                    file: path.relative(ROOT, file),
                    line,
                    snippet: match.slice(0, 160),
                });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
                .join('\n');
            fail(
                `Found ${violations.length} native date input(s). Use the ` +
                    `shared <DatePicker> / <DateRangePicker> from ` +
                    `@/components/ui/date-picker/ instead. See ` +
                    `docs/date-picker.md for the contributor guide.\n${report}`,
            );
        }
    });

    it('the contributor guide ships with the canonical components', () => {
        const docPath = path.join(ROOT, 'docs/date-picker.md');
        expect(fs.existsSync(docPath)).toBe(true);
        const doc = fs.readFileSync(docPath, 'utf-8');
        expect(doc).toMatch(/## Picking the right component/i);
        expect(doc).toMatch(/## Choosing presets/i);
        expect(doc).toMatch(/## Display formatters/i);
        expect(doc).toMatch(/## Filter-state integration/i);
    });
});
