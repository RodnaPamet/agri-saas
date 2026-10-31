/**
 * Polish PR-7 — chart-token discipline ratchet.
 *
 * Bans hex literals (`#abc`, `#abcdef`) and `rgb(...)` calls in
 * chart, heatmap, and per-domain dashboard files. Charts MUST flow
 * through `@/lib/design/status-tone` (Tailwind class tokens) or
 * through CSS custom properties (`var(--brand-default)` etc.) so a
 * theme flip re-tones every chart automatically.
 *
 * Why
 *   Until this PR each chart shipped its own colour function — risk
 *   heatmap had hand-thresholded bg classes; CalendarHeatmap had a
 *   brand-alpha staircase; CalendarMonth + GanttTimeline had
 *   parallel category maps; CoverageClient hardcoded hex on the
 *   donut. The result was that dark↔light parity was brittle and
 *   chart vocabulary differed across the product.
 *
 * What this ratchet detects
 *   For files matching the SCAN_GLOBS below:
 *     - any `#[0-9a-fA-F]{3,8}` hex literal (3-, 6-, or 8-digit)
 *     - any `rgb(` or `rgba(` call
 *
 *   Files outside the glob (general components / one-offs) are
 *   intentionally not policed by this ratchet — keep the scope tight
 *   so it's actionable.
 *
 * Exempt
 *   - DonutChart's caller in coverage uses a single hex `#334155`
 *     for the inactive segment (SVG fill, not a Tailwind class).
 *     Allowlisted line-by-line below until DonutChart accepts a
 *     CSS-var resolver.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// Files scanned. Keep tight to the surfaces this PR governs.
const SCAN_FILES: string[] = [
    'src/components/ui/CalendarMonth.tsx',
    'src/components/ui/GanttTimeline.tsx',
    // Elevation PR-7 — DonutChart now uses CSS-var tokens directly
    // (SVG `stroke` / `fill` accept `var(...)`), so it joins the
    // ratchet net.
    'src/components/ui/DonutChart.tsx',
];

// Allowlisted (file, line-substring, reason) tuples for hex literals
// that are still acceptable. Keep small.
//
// Elevation PR-7 — DonutChart entry retired. SVG `stroke` and
// `fill` accept `var(...)` natively, so segment colours now use
// `var(--bg-success-emphasis)` etc. Theme flips re-tone the chart
// automatically without a JS resolver.
const ALLOWLIST: Array<{ file: string; substring: string; reason: string }> = [];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_RE = /\brgba?\s*\(/;

interface Hit {
    file: string;
    line: number;
    text: string;
    kind: string;
}

describe('Chart token discipline (Polish PR-7)', () => {
    it('zero hex / rgb literals in chart, heatmap, and dashboard files', () => {
        const offenders: Hit[] = [];
        const perFile: Record<string, number> = {};
        for (const rel of SCAN_FILES) {
            const abs = path.resolve(ROOT, rel);
            if (!fs.existsSync(abs)) continue;
            const content = fs.readFileSync(abs, 'utf8');
            const lines = content.split('\n');
            perFile[rel] = lines.length;
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (
                    trimmed.startsWith('//') ||
                    trimmed.startsWith('*') ||
                    trimmed.startsWith('/*')
                )
                    return;
                const allowed = ALLOWLIST.some(
                    (a) => a.file === rel && line.includes(a.substring),
                );
                if (allowed) return;
                if (HEX_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                        kind: 'hex',
                    });
                }
                if (RGB_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                        kind: 'rgb',
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line} [${o.kind}]\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} chart-discipline violation(s).\n\nCharts and dashboards MUST flow through '@/lib/design/status-tone' (Tailwind class tokens) or through CSS custom properties (var(--…)). Hex literals don't re-theme; the semantic tokens are tuned to WCAG AA in both themes.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
        // #2507. The loop `continue`s past a missing file and `toHaveLength(0)`
        // is satisfied by having scanned nothing, so the absence above needs a
        // denominator. The sibling `every scanned file exists` covers a MISSING
        // file; neither it nor a bare read covers an EMPTY one, and an empty
        // file contributes one line and zero offenders.
        //
        // PER FILE, not a total — and that is not a detail. A total floor was
        // written here first and the mutation proof passed: emptying
        // CalendarMonth.tsx left 681 of 1,280 lines, comfortably over a floor
        // of 200, so one gutted file was invisible. A total measures the wrong
        // axis when the defect is one member of a small population.
        console.log(
            `[chart-token-discipline] scanned ${Object.keys(perFile).length} of `
                + `${SCAN_FILES.length} file(s): `
                + Object.entries(perFile)
                    .map(([f, n]) => `${f.split('/').pop()}=${n}`)
                    .join(', '),
        );
        expect(Object.keys(perFile).sort()).toEqual([...SCAN_FILES].sort());
        // Smallest today is GanttTimeline.tsx at 264 lines; DonutChart.tsx is
        // the largest at 679. The floor is set well under the smallest so an
        // ordinary edit does not trip it, and well over 1 — which is what
        // `''.split('\n')` yields for an emptied file.
        // Two assertions, because each says something the other cannot: the
        // first NAMES the starved file in the failure, the second states the
        // floor as a comparison.
        expect(Object.entries(perFile).filter(([, n]) => n <= 100)).toEqual([]);
        expect(Math.min(...Object.values(perFile))).toBeGreaterThan(100);
    });

    it('every scanned file exists', () => {
        for (const rel of SCAN_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
    });
});
