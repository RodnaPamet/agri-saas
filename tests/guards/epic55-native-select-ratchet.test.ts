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
 * Baseline is 0. It was 2 until the control-exoskeleton removal: both
 * remaining native `<select>`s lived in `TestPlansPanel`, which was
 * deleted along with the test-of-control surface (and with it the
 * `page.selectOption('#test-plan-frequency-select', …)` interaction in
 * the since-removed `tests/e2e/control-tests.spec.ts`). The budget
 * ratchets down with them, so a NEW native select now fails CI rather
 * than sliding into a two-slot allowance nothing occupies. Everything
 * else had already migrated:
 *   - PrescriptionPanel, VersionDiff, WidgetPicker → Combobox/RadioGroup.
 *   - access-reviews decision picker → ToggleGroup; its modal target-role
 *     picker → Combobox.
 *   - admin/members row-action menu → Popover (never a native select).
 * Note: ControlsClient's dense inline pickers, referenced by earlier
 * versions of this comment as "4 native selects", are now button-based
 * StatusBadge triggers — they contribute ZERO native selects today.
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
    if (!fs.existsSync(dir)) return out;
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

    it('baseline constant is a plausible non-negative integer', () => {
        expect(Number.isInteger(BASELINE_NATIVE_SELECTS)).toBe(true);
        expect(BASELINE_NATIVE_SELECTS).toBeGreaterThanOrEqual(0);
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
    const APP_MIGRATED = [
        'audits/cycles/page.tsx',
        'controls/NewControlModal.tsx',
        'controls/ControlDetailSheet.tsx',
        'evidence/UploadEvidenceModal.tsx',
        'evidence/NewEvidenceTextModal.tsx',
        'vendors/new/page.tsx',
        'findings/FindingsClient.tsx',
        'clauses/ClausesBrowser.tsx',
        'policies/new/page.tsx',
        // Session 2 — Batch 1 migrated files
        'assets/[id]/page.tsx',
        'assets/AssetsClient.tsx',
        'controls/[controlId]/page.tsx',
        'admin/members/page.tsx',
        'admin/roles/page.tsx',
        'admin/api-keys/page.tsx',
        'admin/integrations/page.tsx',
        'vendors/[vendorId]/page.tsx',
        'vendors/[vendorId]/assessment/[assessmentId]/page.tsx',
        'policies/templates/page.tsx',
        // Session 3 — final native-select closeouts (baseline → 0)
        'audits/AuditsClient.tsx',
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
