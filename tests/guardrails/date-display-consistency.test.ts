/**
 * Epic 58 — date-display consistency guardrail.
 *
 * The canonical date-formatting surface is `src/lib/format-date.ts`:
 *   - `formatDate`       → "16 Apr 2026"
 *   - `formatDateTime`   → "16 Apr 2026, 08:00"
 *   - `formatDateShort`  → "16/04/2026"
 *   - `formatDateLong`   → "16 April 2026"
 *   - `formatDateCompact`→ "16 Apr"
 *   - `formatDateRange`  → "16 – 30 Apr 2026" (adaptive)
 *
 * Every product-facing surface must go through these helpers so the
 * app reads in one date dialect — UTC, en-GB, em-dash fallback. This
 * guardrail blocks three common drift patterns from ever creeping
 * back in:
 *
 *   1. Ad-hoc `toLocaleDateString` / `toLocaleString` / `toLocaleTimeString`
 *      in `src/app` or `src/components` (outside the formatter module
 *      itself and the allowlisted UI-chart / pagination utilities).
 *
 *   2. A `new Date(…).toISOString().split('T')[0]` YMD cast in app
 *      code — the canonical path is `toYMD(date)` from the date-picker
 *      foundation. This specific pattern has been the source of subtle
 *      timezone bugs in prior epics.
 *
 *   3. A literal `" - "` or ` – ` separator concatenated onto dates
 *      in the app, which sidesteps `formatDateRange`'s adaptive
 *      "same-month / same-year / different-years" logic.
 *
 * Runs under the node Jest project — pure file scans, no DOM.
 */

import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';
import { assertAllowlistIsLive } from '../helpers/assert-allowlist-is-live';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = [
    path.join(ROOT, 'src/app'),
    path.join(ROOT, 'src/components'),
];

/**
 * Files exempt from the date-locale rule because they still make a DATE-SHAPED
 * `toLocale…String` call in executable code.
 *
 * EMPTY, and all five former entries were measured dead (#2414). Emptying the
 * whole list changes no verdict — 3 passed before, 3 after — which is the
 * definition of an allowlist that excuses nothing.
 *
 * Why each one looked necessary, because the reasons were plausible and are
 * the useful part:
 *
 *   · `format-date.ts` — the canonical formatter. Its only `toLocale…`
 *     mentions are in its own DOCBLOCK, describing the very rule this guard
 *     enforces, and it formats through shared `Intl.DateTimeFormat` instances.
 *     The scan already skips comment lines, so the exemption was suppressing a
 *     false positive that could not fire.
 *   · the three table helpers and `KpiCard` — their calls are
 *     `.toLocaleString()` on ROW COUNTS, and the scan's own `isDateShaped`
 *     condition deliberately does not flag integer formatting. The exemption
 *     duplicated a narrowing the predicate already made.
 *
 * So both halves of the stated reason were already handled by the predicate —
 * once by the comment skip, once by `isDateShaped`. An allowlist written
 * against the BAN rather than against the predicate is how that happens, and
 * it is the same shape as the four found on primitive files in #2983/#2988:
 * `format-date.ts` and `KpiCard` are canonical modules, which collect
 * defensive entries nobody retires.
 *
 * The 2026-04-22 note about `charts/layout.ts` is kept — it records that this
 * list HAS been pruned by hand before, which is why the liveness assertion
 * below now does it automatically.
 *
 * Kept as a mechanism rather than deleted, the `FLAG_EXEMPT` precedent, with
 * discrimination controls because an empty list makes the assertion vacuous.
 */
const ALLOWED_LOCALE_FILES = new Set<string>([]);

/**
 * The ban, as ONE predicate, so the scan and the exemption-liveness check
 * cannot disagree.
 *
 * It carries BOTH narrowings the scan applies, and leaving either out would
 * make the liveness check call a live exemption dead:
 *   · comments are blanked — a docblock naming the banned call is not a call;
 *   · `.toLocaleString()` on a non-date is legitimate integer formatting.
 */
function violatesDateLocaleLine(line: string): boolean {
    const pattern = /\.\s*toLocale(?:Date|Time)?String\s*\(/;
    if (!pattern.test(line)) return false;
    return (
        /\.\s*toLocaleDateString\s*\(/.test(line)
        || /\.\s*toLocaleTimeString\s*\(/.test(line)
        || /new\s+Date\s*\(/.test(line)
    );
}

function violatesDateLocaleBan(code: string): boolean {
    return code.split('\n').some(violatesDateLocaleLine);
}

/**
 * The file set, via the SHARED collector rather than a hand-rolled walk.
 *
 * `selector-teeth` measured the old local `walk()` on 2026-09-29 and it
 * SURVIVED being gutted to `return []`: every assertion below iterates
 * `allFiles`, so an empty list satisfies all of them and the guard reports a
 * clean repo having opened nothing. That is the exact defect this guard
 * family exists to find, in the guard itself.
 *
 * `collectSourceFiles` refuses to return an empty list — `floor` is the teeth
 * the local walk never had — which is also why `file-collection-is-not-
 * silently-empty` forbids a new hand-rolled collector.
 */
function collectScannedFiles(): string[] {
    return collectSourceFiles({
        roots: SCAN_DIRS,
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
        // src/app + src/components is thousands of files. 200 is far below
        // the real population and far above the zero a broken walk returns,
        // so it fails on a collapse without being brittle to real churn.
        floor: 200,
    });
}

describe('Date display consistency', () => {
    const allFiles = collectScannedFiles();

    it('the scan actually reaches app code (positive control)', () => {
        // WITHOUT THIS THE GUARD IS VACUOUS, and moving to a floored
        // collector did not fix that — `selector-teeth` measured it twice on
        // 2026-09-29. Gutting `collectScannedFiles` to `[]` returns before
        // `collectSourceFiles` is ever called, so its `floor` never runs; and
        // every assertion below is a `for...of` over `allFiles`, which an
        // empty array satisfies silently. That is the four-container seam
        // signature (`[] | '' | new Set() | new Map()`) #971 names.
        //
        // This is the assertion that has to redden, because it is the only
        // one that fails on an EMPTY selection rather than passing on it.
        expect(allFiles.length).toBeGreaterThan(200);
        expect(allFiles.some((f) => f.includes(`${path.sep}src${path.sep}app${path.sep}`))).toBe(true);
        expect(
            allFiles.some((f) => f.includes(`${path.sep}src${path.sep}components${path.sep}`)),
        ).toBe(true);
    });

    it('every exempt file still exists AND still violates — #2414', () => {
        // Strictly stronger than an existence check: a deleted file cannot
        // violate, so it fails this too. What existence could not see is an
        // entry whose file is PRESENT and CLEAN — it reads as an accepted
        // violation over a file nothing would flag, and removing it changes no
        // verdict, which is why nothing notices.
        const entries = [...ALLOWED_LOCALE_FILES].map((abs) => path.relative(ROOT, abs));
        const report = assertAllowlistIsLive({
            label: 'date-display-consistency ALLOWED_LOCALE_FILES',
            entries,
            // The SAME transform the scan applies.
            blankOptions: {},
            violates: violatesDateLocaleBan,
        });
        console.log(
            `[date-display-consistency] ${report.live.length} of ${entries.length} `
                + 'exempt file(s) still make a date-shaped toLocale call',
        );
        expect(report.live).toHaveLength(entries.length);
    });

    it('control: the liveness check reports the five former entries as irrelevant', () => {
        // ALLOWED_LOCALE_FILES is empty, so the assertion above ranges over
        // nothing and would pass however broken the helper or the predicate
        // were. The subjects are the five files the dead entries named, so if
        // any of them ever legitimately needs exempting again this fails and
        // says which.
        for (const clean of [
            'src/lib/format-date.ts',
            'src/components/ui/table/pagination-controls.tsx',
            'src/components/ui/table/pagination-utils.ts',
            'src/components/ui/table/table.tsx',
            'src/components/ui/KpiCard.tsx',
        ]) {
            expect(fs.existsSync(path.resolve(ROOT, clean))).toBe(true);
            expect(() =>
                assertAllowlistIsLive({
                    label: 'date-display-consistency control',
                    entries: [clean],
                    blankOptions: {},
                    violates: violatesDateLocaleBan,
                }),
            ).toThrow(/IRRELEVANT/);
        }
    });

    it('control: the predicate fires on a date call and NOT on a row count', () => {
        // The other direction, so the control above cannot pass by refusing
        // everything — and it pins both narrowings, because either going dead
        // would make this guard silently useless in one of two ways.
        expect(violatesDateLocaleBan('const s = d.toLocaleDateString("bg-BG");')).toBe(true);
        expect(violatesDateLocaleBan('const s = d.toLocaleTimeString();')).toBe(true);
        expect(violatesDateLocaleBan('const s = new Date(x).toLocaleString();')).toBe(true);
        // Integer formatting is legitimate — this is what the table helpers do.
        expect(violatesDateLocaleBan('{table.getRowCount().toLocaleString()}')).toBe(false);
        // And a docblock naming the banned call is not a call. `format-date.ts`
        // is the real instance: its own rule description is why it was exempt.
        //
        // The fixture is a COMPLETE block comment, opener included, because
        // `blankNonCode` is state-aware and starts in CODE state — a lone
        // ` * …` line is parsed as code and the call survives. My first
        // version of this control omitted the `/**` and failed for that
        // reason, which is worth keeping: a control needs a fixture the
        // transform can actually act on, or it tests the fixture.
        const docblock = ['/**', ' *   - Call `.toLocaleDateString()` on a Date', ' */'].join('\n');
        expect(violatesDateLocaleBan(docblock)).toBe(true); // raw: the call is there
        expect(violatesDateLocaleBan(blankNonCode(docblock))).toBe(false); // blanked: it is prose
    });

    it('no ad-hoc toLocaleDateString / toLocaleString / toLocaleTimeString in app code', () => {
        const violations: { file: string; line: number; snippet: string }[] = [];
        for (const file of allFiles) {
            if (ALLOWED_LOCALE_FILES.has(file)) continue;
            const src = fs.readFileSync(file, 'utf-8');
            // Blanked through the shared state-aware pass rather than the
            // per-line `//` / `*` heuristic this carried. Stronger in both
            // directions — that heuristic missed a block-comment line not
            // starting with `*` and a TRAILING comment entirely, while
            // over-skipping a code line beginning with `*` — and it makes this
            // scan and the liveness check below judge the SAME text, which is
            // the one way that adoption fails.
            const lines = blankNonCode(src).split('\n');
            const rawLines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                // Formatting integers via `.toLocaleString()` (row counts,
                // currency) is legitimate; only date-shaped calls are flagged.
                // Both narrowings live in the shared predicate.
                if (violatesDateLocaleLine(lines[i])) {
                    violations.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                        // The RAW line, so the message shows real source.
                        snippet: (rawLines[i] ?? lines[i]).trim().slice(0, 140),
                    });
                }
            }
        }
        if (violations.length > 0) {
            const report = violations
                .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
                .join('\n');
            fail(
                `Found ${violations.length} ad-hoc date formatter(s). Use ` +
                    `@/lib/format-date helpers (formatDate / formatDateTime / ` +
                    `formatDateCompact / formatDateRange) instead:\n${report}`,
            );
        }
    });

    it('no `new Date(...).toISOString().split("T")[0]` YMD casts — use toYMD() from the date-picker foundation', () => {
        const pattern =
            /new\s+Date\s*\(\s*\)\s*\.\s*toISOString\s*\(\s*\)\s*\.\s*split\s*\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/;
        const violations: { file: string; line: number }[] = [];
        for (const file of allFiles) {
            const src = fs.readFileSync(file, 'utf-8');
            const lines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i];
                const trimmed = raw.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                if (pattern.test(raw)) {
                    violations.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                    });
                }
            }
        }
        if (violations.length > 0) {
            const report = violations
                .map((v) => `  ${v.file}:${v.line}`)
                .join('\n');
            fail(
                `Found ${violations.length} ad-hoc YMD cast(s). Use toYMD() ` +
                    `from @/components/ui/date-picker/date-utils instead:\n${report}`,
            );
        }
    });
});
