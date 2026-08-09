/**
 * Epic 54 — form-telemetry adoption ratchet.
 *
 * Every customer-observable CRUD surface should emit form-lifecycle
 * events via `useFormTelemetry`. This ratchet records the set of
 * surfaces that use the hook and fails when that set shrinks — so a
 * refactor can't quietly drop observability on an already-wired form.
 *
 * Adding a new form? Instrument it with `useFormTelemetry('Surface')`,
 * then add the module path to `EXPECTED_SURFACES` below.
 *
 * Removing an instrumented form? Remove it from the list in the same
 * commit — the ratchet forces the decision to be explicit.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Every CRUD surface that is required to carry `useFormTelemetry`.
 *
 * Modal-form P1 (2026-05-24) — the `/tasks/new` and `/policies/new`
 * pages were decomposed into page wrapper + extracted form hook +
 * extracted field component. The telemetry hook lives in the
 * extracted `_form/use<Entity>Form.ts` now. The structural assertion
 * resolves against the SURFACE (page + hook), not a single file.
 */
type TelemetrySurface = { label: string; files: string[] };

const EXPECTED_SURFACES: TelemetrySurface[] = [
    { label: 'controls/NewControlModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx'] },
    { label: 'evidence/UploadEvidenceModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx'] },
    { label: 'evidence/NewEvidenceTextModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx'] },
    {
        label: 'tasks create (modal + hook)',
        files: [
            'src/components/tasks/NewTaskModal.tsx',
            'src/components/tasks/_form/useNewTaskForm.ts',
        ],
    },
    {
        label: 'policies/new (shim + modal + hook)',
        files: [
            'src/app/t/[tenantSlug]/(app)/policies/new/page.tsx',
            'src/app/t/[tenantSlug]/(app)/policies/NewPolicyModal.tsx',
            'src/app/t/[tenantSlug]/(app)/policies/_form/useNewPolicyForm.ts',
        ],
    },
];

function readSurface(surface: TelemetrySurface): string {
    return surface.files
        .map((f) => {
            const full = path.join(REPO_ROOT, f);
            if (!fs.existsSync(full)) return '';
            return fs.readFileSync(full, 'utf-8');
        })
        .join('\n');
}

// Minimum number of CRUD surfaces that must be instrumented. The
// count can only go UP — drop the guard by removing an entry from
// `EXPECTED_SURFACES` in the same commit that un-wires a surface, so
// the removal is obvious in review.
const MIN_SURFACE_COUNT = EXPECTED_SURFACES.length;

describe('Epic 54 — useFormTelemetry adoption', () => {
    it.each(EXPECTED_SURFACES)(
        '$label imports and invokes useFormTelemetry',
        (surface) => {
            const src = readSurface(surface);
            expect(src.length).toBeGreaterThan(0);

            expect(src).toMatch(
                /from\s+['"]@\/lib\/telemetry\/form-telemetry['"]/,
            );
            expect(src).toMatch(/useFormTelemetry\(\s*['"][^'"]+['"]\s*\)/);
            // Success + error tracking must be wired — not just the hook
            // mounted. `trackSuccess` and `trackError` are the two
            // observable outcomes of a submit.
            expect(src).toMatch(/\.trackSuccess\(/);
            expect(src).toMatch(/\.trackError\(/);
        },
    );

    it(
        `at least ${MIN_SURFACE_COUNT} CRUD surfaces are instrumented ` +
            '(count can only grow)',
        () => {
            const instrumented = EXPECTED_SURFACES.filter((surface) =>
                readSurface(surface).includes('useFormTelemetry'),
            );
            expect(instrumented.length).toBeGreaterThanOrEqual(
                MIN_SURFACE_COUNT,
            );
        },
    );

    it('the global telemetry sink is registered in Providers', () => {
        const src = fs.readFileSync(
            path.join(REPO_ROOT, 'src/app/providers.tsx'),
            'utf-8',
        );
        expect(src).toMatch(/registerFormTelemetrySink/);
    });
});
