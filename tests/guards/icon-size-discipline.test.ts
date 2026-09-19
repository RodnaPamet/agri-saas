/**
 * Roadmap-3 PR-2 — icon-size discipline.
 *
 * Repo audit found five competing "small icon" sizes in the
 * codebase:
 *
 *   w-3 h-3     (29 sites — 12 px — OFF TOKEN)
 *   w-3.5 h-3.5 (59 sites — 14 px — canonical "sm")
 *   w-4 h-4     (48 sites — 16 px — canonical "md")
 *   w-5 h-5     (21 sites — 20 px — canonical "lg")
 *   w-6 h-6     (17 sites — 24 px — page-title hero icons)
 *
 * Three competing scales (12 / 14 / 16 px) doing the "small inline
 * icon" job. The user reads inconsistency without knowing why.
 *
 * Canonical icon-size vocabulary (locked by this PR)
 *
 *   • sm   → w-3.5 h-3.5 (14 px) — inline-with-text contexts
 *            (tags, status badges, button glyph prefixes,
 *            table-row affordances).
 *   • md   → w-4 h-4 (16 px) — buttons, list-row affordances,
 *            card-header titles.
 *   • lg   → w-5 h-5 (20 px) — empty-state hero icons,
 *            top-of-section indicators.
 *   • title→ w-6 h-6 (24 px) — page-title icons (next to
 *            <Heading level={1}>). Sanctioned, scoped to that
 *            single context, not policed by this ratchet.
 *
 * What this ratchet bans in app pages
 *   • `w-3 h-3` — 12 px is below sm; round up to 14 (sm).
 *
 * What this ratchet does NOT police
 *   • `w-6 h-6` — page-title hero icons; sanctioned, scoped.
 *   • `src/components/` primitives — primitives sometimes need
 *     pixel-precise practice (e.g. shimmer dots, decorative
 *     accents).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');

// Roadmap-7 PR-10 (subtraction sweep) — extend to also catch the
// modern Tailwind `size-N` shorthand. Zero offenders today;
// forward enforcement guarantees the shorthand never drifts to
// the off-token 12px rung. Lookahead `(?!\.)` excludes
// `size-3.5` which IS the canonical sm rung.
const OFF_TOKEN_RE = /\bw-3\s+h-3\b|\bsize-3(?!\.)\b/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Icon-size discipline (Roadmap-3 PR-2)', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and NOT ONE test failed. Its only
    // call site is the `for (const file of walk(SCAN_ROOT))` loop below,
    // so the one gut that TYPECHECKS against the declared `: string[]` —
    // `[]` — makes that loop run zero times: `offenders` stays empty, the
    // throw never fires, `expect(offenders).toHaveLength(0)` passes. "214
    // app pages scanned, none off-token" and "no file was ever opened"
    // were the same green.
    //
    // The other eight guts ('' / 0 / null / undefined / false / Set / Map
    // / {}) are killed by the RETURN TYPE under `strict`, not by anything
    // this file asserts — they never compile, so the tool skips rather
    // than scores them, and the for-of seam kills nothing the annotation
    // had not already removed. The annotation narrows the probe to the one
    // realistic dead-selector shape; it does not protect the guard.
    //
    // The `fs.existsSync` throw INSIDE `walk` (#875) does not cover this:
    // gutting replaces the whole body, so that floor never runs. A check
    // one layer down cannot protect a caller that stops calling it — which
    // is why it is asserted from outside, below.

    it('control: walk returns the real app-page population under SCAN_ROOT', () => {
        const files = walk(SCAN_ROOT);
        expect(Array.isArray(files)).toBe(true);
        // Measured 2026-09-19: 214 `.tsx` files under `src/app` (zero
        // `.jsx`). The floor sits far below that, so ordinary feature PRs
        // never move it — but `[]` cannot reach it.
        expect(files.length).toBeGreaterThan(120);

        const rels = files.map((f) =>
            path.relative(SCAN_ROOT, f).split(path.sep).join('/'),
        );
        // Nothing escaped the root this ratchet claims to police, and the
        // extension filter held.
        expect(rels.filter((r) => r.startsWith('..'))).toEqual([]);
        expect(rels.filter((r) => !/\.(tsx|jsx)$/.test(r))).toEqual([]);

        // That filter is the ONLY exclusion `walk` has with anything to
        // bite — there is no `node_modules` or `__tests__` directory under
        // `src/app`, so those two skips are inert and are deliberately not
        // asserted. Derived rather than named: 370 `.ts` siblings live
        // under this root (measured). A filter that stopped filtering
        // would surface here instead of as a quietly larger population.
        const dirs = [SCAN_ROOT];
        const tsSiblings: string[] = [];
        for (let i = 0; i < dirs.length; i++) {
            for (const entry of fs.readdirSync(dirs[i], { withFileTypes: true })) {
                const full = path.join(dirs[i], entry.name);
                if (entry.isDirectory()) dirs.push(full);
                else if (entry.name.endsWith('.ts')) tsSiblings.push(full);
            }
        }
        expect(tsSiblings.length).toBeGreaterThan(100);
        expect(files.filter((f) => tsSiblings.includes(f))).toEqual([]);

        // RECURSION is the one behaviour a constant return cannot express,
        // and real product source proves it: the deepest page sits seven
        // segments below `src/app`
        // (`t/[tenantSlug]/(app)/grain/bins/[binId]/page.tsx`, measured).
        // `Math.max(...[])` is -Infinity, so an empty population fails here
        // too.
        expect(
            Math.max(...rels.map((r) => r.split('/').length)),
        ).toBeGreaterThanOrEqual(4);
    });

    it('control: walk refuses a scan root that does not exist (#875)', () => {
        // Asserted at the CALL SITE, because the floor lives INSIDE the
        // body the mutation replaces — gut `walk` and this throw goes with
        // it. Both halves matter: the refusal fires on a renamed root, and
        // the root this file actually scans is not the renamed one.
        expect(() =>
            walk(path.join(ROOT, 'src/app-renamed-by-a-refactor')),
        ).toThrow(/scan root does not exist/);
        expect(fs.existsSync(SCAN_ROOT)).toBe(true);
    });
    it('control: OFF_TOKEN_RE fires on the banned rung and spares the canonical ones', () => {
        // POSITIVE CONTROL, MANUFACTURED FROM REAL SCANNED SOURCE so it
        // cannot go stale. Take the lines the scan actually reads that
        // carry the canonical sm rung — 50 lines across 9 files, measured
        // 2026-09-19 — and demote `w-3.5 h-3.5` to `w-3 h-3`. The original
        // must be SPARED and the demoted one CAUGHT: both directions, on
        // text the product really ships. (This also fails on a gutted
        // `walk`, independently of the population control above.)
        const canonical = walk(SCAN_ROOT)
            .flatMap((f) => fs.readFileSync(f, 'utf-8').split('\n'))
            .filter((line) => /\bw-3\.5\s+h-3\.5\b/.test(line));
        expect(canonical.length).toBeGreaterThan(10);
        for (const line of canonical.slice(0, 5)) {
            expect(OFF_TOKEN_RE.test(line)).toBe(false);
            expect(
                OFF_TOKEN_RE.test(line.replace('w-3.5 h-3.5', 'w-3 h-3')),
            ).toBe(true);
        }

        // Both banned spellings, including the `size-N` shorthand the
        // Roadmap-7 sweep added with zero offenders to point at — the one
        // arm of this regex no live line has ever exercised.
        expect(OFF_TOKEN_RE.test('<Lock className="w-3 h-3" />')).toBe(true);
        expect(OFF_TOKEN_RE.test('<Lock className="size-3" />')).toBe(true);

        // …and the near-misses the `(?!\.)` lookahead exists for. A regex
        // that matched these would flag every sm icon in the product;
        // one that matched neither them nor the rung above would report
        // zero offenders forever, which is the silent direction the gut
        // set cannot reach.
        expect(OFF_TOKEN_RE.test('<Plus className="w-3.5 h-3.5" />')).toBe(false);
        expect(OFF_TOKEN_RE.test('<Plus className="size-3.5" />')).toBe(false);
        expect(OFF_TOKEN_RE.test('<Plus className="w-4 h-4" />')).toBe(false);
        expect(OFF_TOKEN_RE.test('<Plus className="w-3 h-4" />')).toBe(false);
    });

    it('control: the off-token rung exists in the product, outside the scan root', () => {
        // POSITIVE CONTROL FROM REAL PRODUCT SOURCE. `src/components/`
        // genuinely ships the banned rung — 6 non-comment lines across 5
        // files, measured 2026-09-19 (UpgradeGate ×2, SharePointFilePicker,
        // nav-section, checkbox, filter-range-panel) — and the docblock
        // exempts that tree on purpose. So "zero offenders" is a fact about
        // WHERE this ratchet looks, not about a pattern nothing in the repo
        // matches, and the primitives carve-out is the scan root doing the
        // work rather than luck. If a cleanup ever takes that count to
        // zero, DELETE this test: the manufactured control above is the
        // stale-proof half.
        const dirs = [path.join(ROOT, 'src/components')];
        const offending: string[] = [];
        for (let i = 0; i < dirs.length; i++) {
            for (const entry of fs.readdirSync(dirs[i], { withFileTypes: true })) {
                const full = path.join(dirs[i], entry.name);
                if (entry.isDirectory()) {
                    dirs.push(full);
                    continue;
                }
                if (!/\.(tsx|jsx)$/.test(entry.name)) continue;
                const hit = fs
                    .readFileSync(full, 'utf-8')
                    .split('\n')
                    .some((line) => {
                        const trimmed = line.trim();
                        if (
                            trimmed.startsWith('//') ||
                            trimmed.startsWith('*') ||
                            trimmed.startsWith('/*')
                        )
                            return false;
                        return OFF_TOKEN_RE.test(line);
                    });
                if (hit) offending.push(full);
            }
        }
        expect(offending.length).toBeGreaterThanOrEqual(3);
        // …and every one of them sits OUTSIDE the scanned root, which is
        // the only reason this ratchet does not fire on them.
        for (const f of offending) {
            expect(path.relative(SCAN_ROOT, f).startsWith('..')).toBe(true);
        }
    });

    it('app pages do not use w-3 h-3 (12 px — below sm token)', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (
                    trimmed.startsWith('//') ||
                    trimmed.startsWith('*') ||
                    trimmed.startsWith('/*')
                )
                    return;
                if (OFF_TOKEN_RE.test(line)) {
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} off-token icon size in app pages.\n\nThe canonical icon scale is sm=14 (w-3.5 h-3.5) / md=16 (w-4 h-4) / lg=20 (w-5 h-5). 12 px (w-3 h-3) is below sm and reads as a different scale; round up to w-3.5 h-3.5 (sm).\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});
