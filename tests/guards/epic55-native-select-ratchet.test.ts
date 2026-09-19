/**
 * Epic 55 — native `<select>` ratchet guardrail.
 *
 * Epic 55 migrated the intended CRUD/edit forms onto the shared
 * `<Combobox>` + `<RadioGroup>` primitives. To keep the rollout durable,
 * this ratchet counts native `<select>` elements and fails CI if the
 * number grows.
 *
 * Rules:
 *   - The baseline is recorded below and may only go DOWN. Lowering it
 *     is the intended action when a new surface migrates; raising it
 *     would mean someone reached for native `<select>` where the shared
 *     Combobox is the canonical answer.
 *   - Scope: `src/app/t/**` AND `src/components/**`. The scope was
 *     WIDENED to include `src/components` during the dropdown-unification
 *     pass — that is how shared components (PrescriptionPanel, VersionDiff,
 *     WidgetPicker) had escaped the app-only scan.
 *   - Comments are stripped before counting, so a doc-comment that merely
 *     mentions `<select>` (e.g. in status-badge.tsx / combobox/index.tsx)
 *     is not a false positive.
 *
 * Baseline is 0. It was 2 until the practice-exoskeleton removal: both
 * remaining native `<select>`s lived in `TestPlansPanel`, which was
 * deleted along with the test-of-practice surface (and with it the
 * `page.selectOption('#test-plan-frequency-select', …)` interaction in
 * the since-removed `tests/e2e/practice-tests.spec.ts`). The budget
 * ratchets down with them, so a NEW native select now fails CI rather
 * than sliding into a two-slot allowance nothing occupies. Everything
 * else had already migrated:
 *   - PrescriptionPanel, VersionDiff, WidgetPicker → Combobox/RadioGroup.
 *   - access-reviews decision picker → ToggleGroup; its modal target-role
 *     picker → Combobox.
 *   - admin/members row-action menu → Popover (never a native select).
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');
const SCAN_ROOTS = [
    path.join(SRC_ROOT, 'app', 't'),
    path.join(SRC_ROOT, 'components'),
];

// Lower to 0 when TestPlansPanel migrates (and its E2E selectOption is
// ported); raise only with a written reason.
const BASELINE_NATIVE_SELECTS = 0;

/** Strip block + line comments so comment prose never counts as a select. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function walk(dir: string, out: string[]): string[] {
    if (!fs.existsSync(dir)) {
        // Deliberately a THROW, not `return out`. The early return was a
        // defensive line that made this guard unable to fail: a renamed root
        // yielded zero files, zero files yielded zero violations, and the
        // assertion passed over nothing. An empty selection is a PASS.
        throw new Error(
            `scan root does not exist: ${dir}. If a directory was renamed, update SCAN_ROOTS — ` +
                `do not let this guard scan nothing and report success.`,
        );
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            walk(full, out);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const SOURCES = SCAN_ROOTS.flatMap((root) => walk(root, [])).map((p) => ({
    // Keyed relative to src/ so the two roots never collide.
    file: path.relative(SRC_ROOT, p),
    src: fs.readFileSync(p, 'utf-8'),
}));

function countNativeSelects(): { total: number; byFile: Record<string, number> } {
    const byFile: Record<string, number> = {};
    let total = 0;
    const re = /<select\b/g;
    for (const { file, src } of SOURCES) {
        const matches = stripComments(src).match(re);
        if (matches) {
            byFile[file] = matches.length;
            total += matches.length;
        }
    }
    return { total, byFile };
}

describe('Epic 55 — native <select> ratchet', () => {
    // ── Controls (#971) ───────────────────────────────────────────────
    //
    // `selector-teeth` gutted this file's module-level selectors. Two guts
    // survive: `stripComments` -> '' (survives ALL 15 tests, including the
    // migrated-surface sentinels, which assert on stripComments(entry.src)
    // and not on entry.src) and `walk` -> [] (survives all three ratchet
    // tests; only the sentinel block catches it, incidentally). BASELINE is
    // 0 and src carries no live native <select>, so every assertion below
    // the controls is satisfied by an empty selection.

    it('control: stripComments removes comment prose and PRESERVES code', () => {
        // Over-stripping is the silent direction. A stripper returning ''
        // satisfies every other assertion in this file.
        const both = '/* <select> */ const keep = "<select>";';
        expect((both.match(/<select\b/g) || []).length).toBe(2);
        expect((stripComments(both).match(/<select\b/g) || []).length).toBe(1);
        expect(stripComments(both)).toMatch(/const keep/);
        // A line comment is stripped, the code on the next line is not.
        const lineCase = '// mentions <select>\nconst keep = "<select>";';
        expect((stripComments(lineCase).match(/<select\b/g) || []).length).toBe(1);
        // Near-miss: the `[^:]` in the line-comment arm is what stops a URL
        // being eaten as a comment, taking the rest of the line with it.
        expect(
            stripComments('const u = "https://example.com"; const s = "<select>";'),
        ).toMatch(/<select>/);
    });

    it('control: the comment exemption BITES on real product source', () => {
        // Derived, not hard-coded, so a rename cannot empty this control.
        // Measured 2026-09-19: 5 files under the scan roots mention <select>,
        // all of them in comments, none in code.
        const carriers = SOURCES.filter((s) => /<select\b/.test(s.src));
        expect(carriers.length).toBeGreaterThanOrEqual(3);
        for (const c of carriers) {
            expect(stripComments(c.src)).not.toMatch(/<select\b/);
            // …and the file did not strip to nothing, which is the only way
            // the line above can be green for the wrong reason.
            expect(stripComments(c.src).length).toBeGreaterThan(500);
        }
    });
    it('control: walk collects a real, recursive, extension-filtered population', () => {
        // Measured 2026-09-19: src/app/t = 190 files, src/components = 690.
        // Floors sit well below reality so ordinary churn never touches them.
        const appFiles = walk(path.join(SRC_ROOT, 'app', 't'), []);
        const componentFiles = walk(path.join(SRC_ROOT, 'components'), []);
        expect(appFiles.length).toBeGreaterThan(80);
        expect(componentFiles.length).toBeGreaterThan(300);
        // Its own extension filter must bite, or the population silently grows.
        expect(
            [...appFiles, ...componentFiles].every((f) => /\.tsx?$/.test(f)),
        ).toBe(true);
        // RECURSION — a constant return cannot produce a nested path.
        // Measured: 573 of the 690 component files live under components/ui/**.
        expect(
            componentFiles.filter((f) =>
                f.startsWith(path.join(SRC_ROOT, 'components', 'ui') + path.sep),
            ).length,
        ).toBeGreaterThan(200);
        // The out-parameter contract: walk APPENDS to the array it is given.
        expect(walk(path.join(SRC_ROOT, 'components'), ['SEED'])[0]).toBe('SEED');
    });

    it('control: walk throws on a missing scan root (#875) instead of scanning nothing', () => {
        // This throw lives INSIDE walk, so gutting walk deletes it along with
        // everything else. Assert it where a caller can actually see it.
        expect(() =>
            walk(path.join(SRC_ROOT, 'app', '__no_such_scan_root__'), []),
        ).toThrow(/scan root does not exist/);
    });

    it('count of native <select> elements does not grow beyond the baseline', () => {
        const { total, byFile } = countNativeSelects();
        if (total > BASELINE_NATIVE_SELECTS) {
            const formatted = Object.entries(byFile)
                .map(([file, count]) => `  ${count.toString().padStart(2)}× ${file}`)
                .join('\n');
            throw new Error(
                `Native <select> count ${total} exceeds Epic 55 baseline ${BASELINE_NATIVE_SELECTS}. ` +
                    `Use <Combobox> or <RadioGroup> for CRUD/edit forms; see ` +
                    `docs/combobox-form-strategy.md.\n\n` +
                    `Current distribution:\n${formatted}`,
            );
        }
        expect(total).toBeLessThanOrEqual(BASELINE_NATIVE_SELECTS);
    });

    it('control: SOURCES is a real population that BOTH scan roots contribute to', () => {
        // The value every test in this file consumes. `for (… of SOURCES)`
        // makes an empty population a silent PASS, and nothing else floors it.
        // Measured 2026-09-19: 880 entries — 190 under app/t, 690 under components.
        expect(SCAN_ROOTS.length).toBe(2);
        expect(SOURCES.length).toBeGreaterThan(400);
        expect(
            SOURCES.filter((s) => s.file.startsWith(path.join('app', 't') + path.sep))
                .length,
        ).toBeGreaterThan(80);
        // The src/components half is the WIDENING this guard's docblock records.
        // Losing it narrows the scan by 78% with every assertion still green.
        expect(
            SOURCES.filter((s) => s.file.startsWith('components' + path.sep)).length,
        ).toBeGreaterThan(300);
        // Keying relative to src/ is what keeps the two roots from colliding.
        expect(new Set(SOURCES.map((s) => s.file)).size).toBe(SOURCES.length);
        // A file with no text cannot hold a <select>, so an all-empty read
        // would be an empty selection wearing a full population's clothes.
        expect(SOURCES.every((s) => s.src.length > 0)).toBe(true);
    });

    it('baseline constant is a plausible non-negative integer', () => {
        expect(Number.isInteger(BASELINE_NATIVE_SELECTS)).toBe(true);
        expect(BASELINE_NATIVE_SELECTS).toBeGreaterThanOrEqual(0);
    });

    it('control: the counter agrees with an independent recount of SOURCES', () => {
        const { total, byFile } = countNativeSelects();
        expect(typeof total).toBe('number');
        let expected = 0;
        for (const s of SOURCES) {
            expected += (stripComments(s.src).match(/<select\b/g) || []).length;
        }
        expect(total).toBe(expected);
        // The per-file map must account for the whole total, not a subset.
        expect(Object.values(byFile).reduce((a, b) => a + b, 0)).toBe(total);
    });

    it('control: the detector finds a planted <select> and ignores near-misses', () => {
        // BASELINE is 0 and src carries no live native <select>, so nothing
        // else here ever proves the pattern can MATCH. Manufacture the
        // positive out of real file text so it cannot go stale.
        const carrier = SOURCES.find((s) => /<select\b/.test(s.src));
        if (!carrier) {
            throw new Error(
                'No file under the scan roots mentions <select> — this control ' +
                    'has no subject, and the comment-exemption claim is untestable.',
            );
        }
        const before = (stripComments(carrier.src).match(/<select\b/g) || []).length;
        const planted =
            carrier.src + '\nexport const planted = <select id="planted" />;\n';
        const after = (stripComments(planted).match(/<select\b/g) || []).length;
        expect(after - before).toBe(1);
        // Near-misses that must NOT count — the last one is a string this
        // codebase really contains (decision-select-${d.id}).
        const misses = [
            '<Select id="x" />',
            '<selectable />',
            '< select />',
            'data-testid="decision-select-1"',
        ];
        for (const miss of misses) {
            expect(stripComments(miss)).not.toMatch(/<select\b/);
        }
    });

    it('the baseline is not stale — no file holds an unaccounted select', () => {
        // This test previously destructured `byFile` and asserted nothing,
        // so it passed no matter what the scan found — it was green about
        // a budget whose only occupant (TestPlansPanel) had been deleted.
        // With the baseline at 0 the invariant is exact: the per-file map
        // must be empty, and any file that reintroduces a native select is
        // named in the failure.
        const { total, byFile } = countNativeSelects();
        expect(Object.keys(byFile)).toEqual([]);
        expect(total).toBe(BASELINE_NATIVE_SELECTS);
    });
});

// ─── Explicit drift sentinels — surfaces that MUST stay migrated ──

describe('Epic 55 — migrated surfaces must not regress to native <select>', () => {
    // GRC teardown phase 2 dropped the twelve sentinels whose pages were
    // deleted (audits/*, practices/*, policies/*, vendors/*, findings/*,
    // clauses/*). The surviving sentinels below are unchanged — the
    // baseline of 0 is what actually stops a new native <select>; these
    // are the belt-and-braces "this specific surface stays migrated"
    // checks for the surfaces that still exist.
    const APP_MIGRATED = [
        'evidence/UploadEvidenceModal.tsx',
        'evidence/NewEvidenceTextModal.tsx',
        // Session 2 — Batch 1 migrated files
        'assets/[id]/page.tsx',
        'assets/AssetsClient.tsx',
        'admin/members/page.tsx',
        'admin/roles/page.tsx',
        'admin/api-keys/page.tsx',
        'admin/integrations/page.tsx',
        // Dropdown-unification pass — access-reviews decision + target-role
        'access-reviews/[reviewId]/AccessReviewDetailClient.tsx',
    ].map((rel) => `app/t/[tenantSlug]/(app)/${rel}`);

    // Shared components migrated when the scan scope was widened to
    // src/components in the dropdown-unification pass.
    const COMPONENT_MIGRATED = [
        'components/ui/map/PrescriptionPanel.tsx',
        'components/ui/VersionDiff.tsx',
        'components/ui/dashboard-widgets/WidgetPicker.tsx',
    ];

    const MIGRATED_FILES = [...APP_MIGRATED, ...COMPONENT_MIGRATED];

    it.each(MIGRATED_FILES)(
        '%s contains no native <select> (Epic 55 migrated)',
        (relFile) => {
            const entry = SOURCES.find((s) => s.file === relFile);
            if (!entry) {
                // File moved/renamed — surface a clear failure.
                throw new Error(
                    `Migrated file not found at expected path: ${relFile}`,
                );
            }
            expect(stripComments(entry.src)).not.toMatch(/<select\b/);
        },
    );
});
