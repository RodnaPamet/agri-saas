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

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = [
    path.join(ROOT, 'src/app'),
    path.join(ROOT, 'src/components'),
];

/**
 * Files we explicitly exempt from the `toLocaleDateString` rule:
 *   - The formatter module is the canonical call site.
 *   - The table pagination helpers + KpiCard format integer row counts
 *     with `Number.prototype.toLocaleString()` — that's a numeric
 *     thousands-separator, not a date cast.
 *
 * NOTE: `src/components/ui/charts/layout.ts` was dropped from this
 * allowlist on 2026-04-22 — its `formatShortDate` now delegates to
 * the canonical `formatDateCompact` and no longer carries a raw
 * `toLocaleDateString` call. Re-add only if a contributor
 * reintroduces a date-locale call there with a justification.
 */
const ALLOWED_LOCALE_FILES = new Set<string>([
    path.join(ROOT, 'src/lib/format-date.ts'),
    path.join(ROOT, 'src/components/ui/table/pagination-controls.tsx'),
    path.join(ROOT, 'src/components/ui/table/pagination-utils.ts'),
    path.join(ROOT, 'src/components/ui/table/table.tsx'),
    path.join(ROOT, 'src/components/ui/KpiCard.tsx'),
]);

function walk(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, acc);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
}

describe('Date display consistency', () => {
    const allFiles = SCAN_DIRS.flatMap((d) => walk(d));

    it('no ad-hoc toLocaleDateString / toLocaleString / toLocaleTimeString in app code', () => {
        const pattern =
            /\.\s*toLocale(?:Date|Time)?String\s*\(/;
        const violations: { file: string; line: number; snippet: string }[] = [];
        for (const file of allFiles) {
            if (ALLOWED_LOCALE_FILES.has(file)) continue;
            const src = fs.readFileSync(file, 'utf-8');
            const lines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i];
                const trimmed = raw.trim();
                // Skip comments.
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                if (pattern.test(raw)) {
                    // Formatting integers via `.toLocaleString()` (row
                    // counts, currency) is legitimate. Only flag
                    // date-shaped calls.
                    const isDateShaped =
                        /\.\s*toLocaleDateString\s*\(/.test(raw) ||
                        /\.\s*toLocaleTimeString\s*\(/.test(raw) ||
                        /new\s+Date\s*\(/.test(raw);
                    if (!isDateShaped) continue;
                    violations.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                        snippet: trimmed.slice(0, 140),
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
