/**
 * Epic 51 — raw Tailwind color ratchet.
 *
 * Complements the "migrated page" anti-drift guardrail
 * (`design-system-drift.test.ts`) which strictly forbids raw colors
 * on the 4 pages that were migrated in the first pass. This ratchet
 * runs across the whole `src/app/` tree and caps the count at the
 * recorded baseline so the migration can only go in one direction.
 *
 * Lower `BASELINE` when you migrate a file; never raise it. If you
 * genuinely need a raw color (e.g. inside a print-only view where
 * tokens don't apply), carry that in the allowlist below and leave
 * the ratchet count alone.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(__dirname, '../../src/app');

// Matches `bg-slate-800`, `text-neutral-400`, `border-gray-100`, etc.
// Same regex used by `design-system-drift.test.ts` so the two guards
// stay consistent.
const RAW_COLOR_RE = /\b(?:text|bg|border)-(?:slate|gray|neutral|zinc)-\d{2,3}\b/g;

// Baseline recorded at Epic 51 close-out. Lower only.
//
// Remaining hotspots are either deliberately out of theme scope or
// rendering literal colors that can't be token-backed:
//     don't apply under @media print)
//   - login/page.tsx                      (unauthenticated route,
//     tenant context not yet active)
//   - audit/shared/[token]/page.tsx       (public audit pack viewer)
//   - error.tsx / not-found.tsx           (global error boundaries,
//     render before ThemeProvider mounts)
//   - security/mfa/page.tsx QR glyph      (QR code lives on a white
//     surface and must render dark ink regardless of theme)
//
// Baseline raised from 92 → 95 on 2026-04-22 to absorb pre-existing
// drift in the allowlisted render-before-theme paths (error.tsx,
// login/page.tsx, audit/shared/[token]) that landed across the
// fix(login) + fix(auth) cluster of commits between 2026-04-20 and
// 2026-04-22. CI had been red for weeks against the stale 92 baseline;
// these occurrences are defensible for their paths but should have
// bumped the baseline at merge-time. Lower again when those files
// get a future theme-aware re-render pass.
//
// Lowered 95 → 14 on 2026-07-30 (Bulgarian-tricolour dark theme). The
// navy→green re-ground swept the last route-level components that were
// painting raw slate/navy instead of reading a token, and the 95 had
// carried ~81 of stale slack since April — a ratchet with that much
// give is not a ratchet.
//
// Lowered 14 → 0 on 2026-09-30, and the sentence this replaces is why it
// matters. It read: "14 is the exact current count, and every one of them is
// in the ONE file the cheatsheet says should keep raw colours:
// `audit/shared/[token]/page.tsx`". That file NO LONGER EXISTS — GRC teardown
// phase 2 deleted the public audit-pack viewer — so the entire justification
// for the 14 went with it. Measured over the live tree: 612 files walked,
// **0 occurrences**. The same slack the paragraph above calls "not a ratchet"
// had returned at a smaller size, and its own docblock was the thing hiding
// it, because a ceiling of 14 over a real count of 0 reports green either way.
//
// At 0 the ceiling is exact: ANY raw colour in src/app fails. Do not raise it
// to absorb drift in an authenticated route — those owe semantic tokens. A
// genuinely theme-free public surface goes in EXEMPT_DIRS with a reason, which
// is the carve-out that does not weaken the count for everything else.
const BASELINE = 0;

// Directories that are intentionally outside the internal design
// system. Adding entries here is allowed when the surface is a
// public, unauthenticated page that doesn't share the app's dark
// theme tokens.
const EXEMPT_DIRS = new Set<string>([
    // Epic G-3 — public vendor questionnaire respondent page. Lives
    // at /vendor-assessment/[id], does NOT mount the app shell, and
    // intentionally uses a light, neutral palette so external
    // recipients (likely on a corporate-branded mail client) see a
    // clean independent surface rather than the in-app dark theme.
    'vendor-assessment',
]);

function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            if (EXEMPT_DIRS.has(entry.name)) continue;
            walk(full, out);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Read one file. A seam, so a control can prove the COUNTING works without
 * depending on the tree containing a violation — which it must not, since the
 * baseline is 0. See the controls at the bottom of this file.
 */
type SourceReader = (file: string) => string;

const readFromDisk: SourceReader = (file) => fs.readFileSync(file, 'utf-8');

function countRawColors(
    files: readonly string[] = walk(APP_ROOT, []),
    readSource: SourceReader = readFromDisk,
): { total: number; byFile: Record<string, number> } {
    const byFile: Record<string, number> = {};
    let total = 0;
    for (const file of files) {
        const src = readSource(file);
        const matches = src.match(RAW_COLOR_RE);
        if (matches && matches.length > 0) {
            byFile[path.relative(APP_ROOT, file)] = matches.length;
            total += matches.length;
        }
    }
    return { total, byFile };
}

describe('Epic 51 — raw Tailwind color ratchet', () => {
    it(`count of bg-/text-/border-(slate|gray|neutral|zinc)-NN in src/app is ≤ ${BASELINE}`, () => {
        const { total, byFile } = countRawColors();
        if (total > BASELINE) {
            const top = Object.entries(byFile)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10)
                .map(([f, n]) => `  ${n}\t${f}`)
                .join('\n');
            throw new Error(
                `Epic 51 ratchet: raw color usage grew from baseline ${BASELINE} to ${total}.\n` +
                `Migrate to semantic tokens (see docs/token-cheatsheet.md) or lower the baseline when you do.\n` +
                `Top hotspots:\n${top}`,
            );
        }
        expect(total).toBeLessThanOrEqual(BASELINE);
    });

    // ── Controls (#971) ─────────────────────────────────────────────
    //
    // The assertion above is a CEILING, and a ceiling is satisfied by finding
    // nothing. With BASELINE at 0 that is doubly true: `expect(total)
    // .toBeLessThanOrEqual(0)` passes if the walk returns no files, AND if the
    // regex matches nothing it should. `selector-teeth` measured the first
    // one — gutting `walk` to `[]` survived this entire file (#971).
    //
    // The test this replaced was called "baseline is plausible and matches the
    // current tree" and asserted only `total <= BASELINE`, so it could not see
    // either failure — nor the 14-vs-0 drift it was named for. Both axes are
    // covered below, separately, because neither implies the other.

    it('control: the walk finds a real population of app sources', () => {
        // Kills the gutted-`walk` mutation: no files means no count, and no
        // count reads as a clean ratchet.
        const files = walk(APP_ROOT, []);
        expect(files.length).toBeGreaterThan(400); // 612 today
        expect(files.every((f) => f.startsWith(APP_ROOT))).toBe(true);
        expect(files.every((f) => /\.tsx?$/.test(f))).toBe(true);

        // The exemption is honoured rather than just declared.
        expect(files.some((f) => f.includes(`${path.sep}vendor-assessment${path.sep}`))).toBe(
            false,
        );
    });

    it('control: the counter DETECTS a raw colour, and ignores a semantic one', () => {
        // Kills a broken regex or a broken accumulator. This cannot be proved
        // against the real tree, because the tree must contain ZERO matches for
        // the ratchet to pass — "found none" and "cannot see any" are the same
        // observation there. So feed it synthetic sources.
        const raw = path.join(APP_ROOT, 'synthetic-raw.tsx');
        const clean = path.join(APP_ROOT, 'synthetic-clean.tsx');
        const sources: Record<string, string> = {
            // Two raw colours, one of them repeated, plus a semantic class
            // that must NOT be counted.
            [raw]:
                '<div className="bg-slate-800 text-content-muted" />' +
                '<span className="border-gray-100 bg-slate-800" />',
            [clean]: '<div className="bg-bg-default text-content-muted border-border-subtle" />',
        };
        const { total, byFile } = countRawColors([raw, clean], (f) => sources[f] ?? '');

        expect(total).toBe(3);
        expect(byFile['synthetic-raw.tsx']).toBe(3);
        // A file with only semantic tokens must not appear in the report at
        // all — an entry with 0 would make the hotspot list meaningless.
        expect(byFile).not.toHaveProperty('synthetic-clean.tsx');
    });

    it('control: a raw colour in the real tree WOULD breach the ceiling', () => {
        // Ties the two controls above together: the detector works, the
        // population is real, and one occurrence is enough to fail. Without
        // this, a BASELINE that had drifted upward again would leave the other
        // two green while the ratchet absorbed live drift — which is exactly
        // what the 14-vs-0 gap did.
        const one = path.join(APP_ROOT, 'synthetic-one.tsx');
        const { total } = countRawColors([one], () => '<div className="text-zinc-500" />');
        expect(total).toBe(1);
        expect(total).toBeGreaterThan(BASELINE);
    });
});
