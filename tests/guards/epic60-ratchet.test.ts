/**
 * Epic 60 — rollout ratchet.
 *
 * Caps the count of known legacy interaction patterns in app-layer
 * code (`src/app/**` + select spots in `src/components/**`) at the
 * post-rollout floor, so they can only go DOWN over time. Adding a
 * new raw `<input type="number">`, inline `onKeyDown={(e) => e.key ===
 * 'Enter' && ...}`, or raw `localStorage.*Item` call in app code
 * fails CI and points at the shared primitive that replaces it.
 *
 * Why ratchet rather than "ban outright":
 *   - The MFA OTP page's Enter handler has a precondition
 *     (`code.length === 6`) that's cleaner as an inline check than as
 *     an `onSubmit` callback with a guard — kept as-is until someone
 *     has a good reason to migrate.
 *   - Two admin/vendor forms still use `<input type="number">` for
 *     large unbounded numeric fields where NumberStepper's +/- UX
 *     would hurt more than help. Ratchet, don't delete.
 *   - Deep-cleanup is a follow-up; the ratchet keeps the surface
 *     from regressing while we live with the known exceptions.
 *
 * Every count increment message includes a pointer at
 * `docs/epic-60-shared-hooks-and-polish.md` so a new contributor
 * reading the failure knows what to reach for.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_DIR = path.resolve(__dirname, '../../src/app');
const COMPONENTS_DIR = path.resolve(__dirname, '../../src/components');

function walk(dir: string, match: RegExp): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip node_modules-like subtrees just in case.
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            out.push(...walk(full, match));
        } else if (match.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function countMatches(files: string[], pattern: RegExp): { file: string; matches: number }[] {
    const results: { file: string; matches: number }[] = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf-8');
        const matches = (src.match(pattern) ?? []).length;
        if (matches > 0) results.push({ file, matches });
    }
    return results;
}

const TSX_PATTERN = /\.tsx?$/;

describe('Epic 60 — legacy pattern ratchet', () => {
    const appFiles = walk(APP_DIR, TSX_PATTERN);
    const componentFiles = walk(COMPONENTS_DIR, TSX_PATTERN);

    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `walk` and `countMatches` are a CHAIN, and both survived being gutted
    // to a constant. `walk` → `[]` makes `countMatches`'s
    // `for (const file of files)` run zero times, so every `total` is 0 and
    // all four caps (3 / 1 / 0 / 0) pass over a population of nothing.
    // "584 app files scanned, 2 raw number inputs" and "no file was ever
    // opened" were the same green.
    //
    // Only `[]` is silent all the way through. `''` / `new Set()` /
    // `new Map()` also empty the for-of; they die later on
    // `componentFiles.find(...)` in the barrel smoke — incidental, not
    // coverage. The non-iterables (`0` / `null` / `undefined` / `false` /
    // `{}`) throw at the for-of.
    //
    // There is no `fs.existsSync` floor inside `walk` to lose — a renamed
    // root throws ENOENT out of `fs.readdirSync` — but a gutted `walk`
    // cannot throw either, which is why the missing-root probe below is
    // part of the control and not a nicety.

    it('control: walk returns the real .ts/.tsx population under both scan roots', () => {
        expect(Array.isArray(appFiles)).toBe(true);
        expect(Array.isArray(componentFiles)).toBe(true);
        // Measured 2026-09-19: 584 files under src/app (214 .tsx + 370 .ts)
        // and 690 under src/components. The floors sit far below, so
        // ordinary feature PRs never move them.
        expect(appFiles.length).toBeGreaterThan(300);
        expect(componentFiles.length).toBeGreaterThan(300);
        expect(appFiles.every((f) => TSX_PATTERN.test(path.basename(f)))).toBe(true);

        // The extension filter is the ONLY exclusion `walk` has, and it must
        // BITE. Derived, not named: the non-TS files sit at the scan root
        // itself (4 measured — favicon.ico, icon.svg, globals.css,
        // global-error.module.css).
        const rootNonTs = fs
            .readdirSync(APP_DIR, { withFileTypes: true })
            .filter((e) => e.isFile() && !TSX_PATTERN.test(e.name))
            .map((e) => path.join(APP_DIR, e.name));
        expect(rootNonTs.length).toBeGreaterThanOrEqual(3);
        expect(appFiles.filter((f) => rootNonTs.includes(f))).toEqual([]);

        // The `match` parameter is a live seam: a narrower pattern must
        // return a strictly smaller, strictly non-empty SUBSET. A constant
        // return honours no argument. (Measured: 214 .tsx of 584.)
        const tsxOnly = walk(APP_DIR, /\.tsx$/);
        expect(tsxOnly.length).toBeGreaterThan(0);
        expect(tsxOnly.length).toBeLessThan(appFiles.length);
        expect(tsxOnly.every((f) => appFiles.includes(f))).toBe(true);

        // RECURSION — the one behaviour a constant return cannot express.
        // Deepest measured: 10 segments
        // (api/t/[tenantSlug]/locations/[id]/tiles/[z]/[x]/[y]/route.ts).
        const depths = appFiles.map(
            (f) => path.relative(APP_DIR, f).split(path.sep).length,
        );
        expect(Math.max(...depths)).toBeGreaterThanOrEqual(5);
    });

    it('control: walk reads the filesystem — a renamed scan root throws', () => {
        // This file's #875 floor is fs.readdirSync's own ENOENT, and it lives
        // INSIDE the gutted function: asserted from outside, or it vanishes
        // with the guts and a renamed root scans zero files and passes.
        expect(() =>
            walk(path.join(APP_DIR, '__renamed_scan_root__'), TSX_PATTERN),
        ).toThrow();
    });

    // ── Raw <input type="number"> ─────────────────────────────────────

    // ── Controls (#971) — the detector half ──────────────────────────
    //
    // `countMatches` is consumed as `const hits = countMatches(…)` then
    // `hits.reduce((s, h) => s + h.matches, 0)`. Only `Array.prototype` has
    // `.reduce`, so 8 of the 9 guts throw and exactly one survives — `[]`,
    // the one that matters: `total` is 0, and 0 clears all four caps
    // (3 / 1 / 0 / 0) at once. The `hits.map(...)` that names offending
    // files lives inside the `total > CAP` throw, so under the gut it is
    // unreachable: no message, no failure, no scan.
    //
    // Two arms are worse than a hole: for them `[]` is ALREADY today's true
    // answer (localStorage in src/app is 0 over 584 files; the legacy
    // tab-bar shape has no live instance in src/ at all), so gutting
    // mutates nothing observable. Those need the MECHANISM exercised
    // against a population that does match — not today's emptiness.

    it('control: countMatches finds the live instances of the patterns it caps', () => {
        // POSITIVE CONTROLS FROM REAL PRODUCT SOURCE. Each banned app-layer
        // spelling is the SHARED PRIMITIVE's own spelling — the thing each
        // failure message points at — so these have live subjects for as
        // long as that advice is true.
        const numberHits = countMatches(componentFiles, /type=["']number["']/g);
        const enterHits = countMatches(componentFiles, /e\.key === ['"]Enter['"]/g);
        const storageHits = countMatches(
            componentFiles,
            /localStorage\.(getItem|setItem)/g,
        );

        // Measured 2026-09-19 over the 690 files in src/components:
        // 7 matches / 6 files, 13 / 11, and 10 / 5 respectively.
        expect(numberHits.length).toBeGreaterThan(0);
        expect(enterHits.length).toBeGreaterThan(0);
        expect(storageHits.length).toBeGreaterThan(0);

        // The row shape the callers consume: one entry per FILE, keyed by
        // the path `walk` handed in, carrying a positive count.
        for (const h of [...numberHits, ...enterHits, ...storageHits]) {
            expect(componentFiles).toContain(h.file);
            expect(h.matches).toBeGreaterThan(0);
        }

        // A COUNT, not a boolean — ProcessInspector.tsx spells the Enter
        // comparison three times (measured), and the caps are SUMS. A lost
        // /g flag or a per-file 1 would still look non-empty here.
        expect(Math.max(...enterHits.map((h) => h.matches))).toBeGreaterThan(1);

        // And `if (matches > 0)` must BITE: clean files are dropped, not
        // listed at zero. 11 of 690 match; the rest are clean negatives.
        expect(enterHits.length).toBeLessThan(componentFiles.length);
    });

    it('control: the src/app localStorage zero is a measured zero, not an empty scan', () => {
        // The CAP-0 arm below passes identically on "clean" and on "never
        // looked". The only thing separating them is the second number: the
        // SAME pattern through the SAME function over a population that does
        // match.
        const inApp = countMatches(appFiles, /localStorage\.(getItem|setItem)/g);
        const inComponents = countMatches(
            componentFiles,
            /localStorage\.(getItem|setItem)/g,
        );
        expect(inApp).toEqual([]);
        // The approved direct-localStorage modules the CAP-0 docblock names —
        // use-local-storage.ts, ThemeProvider.tsx, column-visibility-utils.ts —
        // all live here (5 files / 10 matches, measured).
        expect(inComponents.length).toBeGreaterThan(0);
    });

    it('control: the tab-bar heuristic catches the legacy shape and not its near-misses', () => {
        // CAP 0 over a pattern with NO live instance (both migrated tab bars
        // are gone), so the positive has to be planted. The near-misses are
        // the shapes that docblock says it deliberately does not match: a
        // plain-string className, and the primitive it asks for instead.
        const LEGACY =
            "onClick={() => setTab('overview')} className={`btn ${active ? 'btn-primary' : 'btn-ghost'}`}";
        const NEAR_MISSES = [
            "onClick={() => setTab('overview')} className=\"btn btn-primary\"",
            '<TabSelect value={tab} onChange={setTab} options={tabs} />',
        ].join('\n');

        const probeRoot = fs.mkdtempSync(
            path.join(
                fs.realpathSync(process.env.TMPDIR || '/tmp'),
                'epic60-tabbar-probe-',
            ),
        );
        try {
            const offender = path.join(probeRoot, 'LegacyTabs.tsx');
            const clean = path.join(probeRoot, 'CleanTabs.tsx');
            fs.writeFileSync(offender, LEGACY, 'utf-8');
            fs.writeFileSync(clean, NEAR_MISSES, 'utf-8');
            expect(
                countMatches(
                    [offender, clean],
                    /onClick=\{\(\) => setTab\([^)]+\)\}\s+className=\{`btn[\s\S]{0,60}btn-(primary|secondary|ghost)/g,
                ),
            ).toEqual([{ file: offender, matches: 1 }]);
        } finally {
            fs.rmSync(probeRoot, { recursive: true, force: true });
        }
    });

    it('caps raw `<input type="number">` in src/app/**', () => {
        const hits = countMatches(appFiles, /type=["']number["']/g);
        const total = hits.reduce((s, h) => s + h.matches, 0);
        // Post-rollout floor. Known legit exceptions:
        //   - src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/assessment/[assessmentId]/page.tsx
        //     (assessment-score field, variable range by question type)
        //   - src/app/t/[tenantSlug]/(app)/admin/security/page.tsx
        //     (sessionMaxAgeMinutes — unbounded max, large range)
        //   - src/app/t/[tenantSlug]/(app)/rent/RentClient.tsx
        //     (lease rent amount — an unbounded decimal price in лв/дка;
        //     NumberStepper's +/- step UX is meaningless for a free-entry
        //     price, same rationale as the two fields above. Mirrors the
        //     sibling ParcelLeasePanel's rent input.)
        const CAP = 3;
        if (total > CAP) {
            throw new Error(
                `Raw \`<input type="number">\` count in src/app/** rose to ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use <NumberStepper> from @/components/ui/number-stepper. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Inline onKeyDown Enter handlers ────────────────────────────────

    it('caps inline `e.key === "Enter"` handlers in src/app/**', () => {
        const hits = countMatches(appFiles, /e\.key === ['"]Enter['"]/g);
        const total = hits.reduce((s, h) => s + h.matches, 0);
        // Post-rollout floor: 1 (MFA OTP page, precondition-guarded).
        const CAP = 1;
        if (total > CAP) {
            throw new Error(
                `Inline \`e.key === "Enter"\` handler count in src/app/** rose to ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use useEnterSubmit from @/components/ui/hooks. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Raw localStorage calls in src/app/** ───────────────────────────

    it('bans raw localStorage.getItem / setItem in src/app/**', () => {
        const hits = countMatches(appFiles, /localStorage\.(getItem|setItem)/g);
        const total = hits.reduce((s, h) => s + h.matches, 0);
        // Post-rollout floor: 0. The approved direct-localStorage
        // modules (theme provider, filter presets, column-visibility
        // utils) all live in src/components or src/lib, not src/app.
        const CAP = 0;
        if (total > CAP) {
            throw new Error(
                `Raw localStorage.*Item call count in src/app/** is ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use useLocalStorage from @/components/ui/hooks. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Hand-rolled tab bars (heuristic) ───────────────────────────────

    it('caps hand-rolled tab bars (heuristic) in src/app/**', () => {
        // Heuristic: `<button onClick={() => setTab(…)} className={\`btn …\`}>`
        // appears in the two pre-Epic-60 tab-bar patterns we migrated
        // plus the practice-detail page (7 tabs, deliberately deferred).
        // The match pattern is deliberately narrow — we grep for
        // `className={\`btn ${…}\`}` on a setTab/setFilter onClick,
        // which was the legacy pattern. Post-rollout floor: 0 (the
        // practice-detail page uses a different structure that doesn't
        // match this pattern).
        const hits = countMatches(
            appFiles,
            /onClick=\{\(\) => setTab\([^)]+\)\}\s+className=\{`btn[\s\S]{0,60}btn-(primary|secondary|ghost)/g,
        );
        const total = hits.reduce((s, h) => s + h.matches, 0);
        const CAP = 0;
        if (total > CAP) {
            throw new Error(
                `Hand-rolled setTab tab bar pattern count in src/app/** is ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use <TabSelect> (section nav) or <ToggleGroup> (filter/mode) from @/components/ui. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Barrel completeness smoke ──────────────────────────────────────

    it('ui/hooks barrel re-exports every hook file', () => {
        // Epic 60 hook discoverability depends on consumers importing
        // from @/components/ui/hooks. A missing barrel entry silently
        // allows deep-path imports to proliferate — this smoke catches
        // the miss at the ratchet layer so the failure shows up in a
        // CI run that's scoped to Epic 60.
        const hooksDir = path.resolve(__dirname, '../../src/components/ui/hooks');
        const barrel = fs.readFileSync(path.join(hooksDir, 'index.ts'), 'utf-8');
        const files = fs
            .readdirSync(hooksDir)
            .filter((f) => /^use-.+\.tsx?$/.test(f));
        for (const f of files) {
            const stem = f.replace(/\.tsx?$/, '');
            expect(barrel).toContain(`./${stem}`);
        }
        // And prove the barrel was used by at least one primitive rollout.
        const testsClient = componentFiles.find((f) =>
            f.endsWith('src/components/onboarding/OnboardingWizard.tsx'),
        );
        if (testsClient) {
            const src = fs.readFileSync(testsClient, 'utf-8');
            expect(src).toMatch(/from ['"]@\/components\/ui\/hooks['"]/);
        }
    });
});
