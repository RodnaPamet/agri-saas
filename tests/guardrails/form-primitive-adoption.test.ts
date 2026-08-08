/**
 * Epic 55 — form primitive adoption ratchet.
 *
 * Epic 55 ships `<FormField>` and `<FormError>` as the canonical
 * composables for labelled form inputs and field-level error
 * messaging. This ratchet records the app-pages that must carry the
 * primitives and fails when coverage shrinks, so a refactor can't
 * silently drop a labelled control back to ad-hoc `<label>` + raw
 * `<input>`.
 *
 * Adding a new form surface?
 *   - Wrap labelled inputs with `<FormField>`; surface field-level
 *     validation via `<FormError>` or `<FormField error>`.
 *   - Append the repo-root-relative module path to the lists below.
 *
 * Removing instrumentation from an existing surface?
 *   - Remove it from the list in the same commit so the deletion is
 *     visible in review.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

// Modal-form P1 (2026-05-24) — policies/tasks/vendors create flows
// were decomposed into page wrapper + extracted `_form/<Entity>Fields.tsx`.
// FormField lives in the extracted fields component now. The
// structural assertion below reads the SURFACE — a tuple of related
// files — and resolves when ANY of them imports / uses the primitive.
type FormSurface = { label: string; files: string[] };

const FORM_FIELD_SURFACES: FormSurface[] = [
    { label: 'audits/cycles/page.tsx', files: ['src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx'] },
    { label: 'controls/ControlDetailSheet.tsx', files: ['src/app/t/[tenantSlug]/(app)/controls/ControlDetailSheet.tsx'] },
    { label: 'controls/NewControlModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx'] },
    { label: 'evidence/NewEvidenceTextModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx'] },
    { label: 'evidence/UploadEvidenceModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx'] },
    {
        label: 'policies/new (shim + modal + fields)',
        files: [
            'src/app/t/[tenantSlug]/(app)/policies/new/page.tsx',
            'src/app/t/[tenantSlug]/(app)/policies/NewPolicyModal.tsx',
            'src/app/t/[tenantSlug]/(app)/policies/_form/NewPolicyFields.tsx',
        ],
    },
    {
        label: 'tasks create (modal + fields)',
        files: [
            'src/components/tasks/NewTaskModal.tsx',
            'src/components/tasks/_form/NewTaskFields.tsx',
        ],
    },
    {
        label: 'vendors/new (shim + modal + fields)',
        files: [
            'src/app/t/[tenantSlug]/(app)/vendors/new/page.tsx',
            'src/app/t/[tenantSlug]/(app)/vendors/NewVendorModal.tsx',
            'src/app/t/[tenantSlug]/(app)/vendors/_form/NewVendorFields.tsx',
        ],
    },
];

const FORM_ERROR_SURFACES: FormSurface[] = [
    { label: 'controls/NewControlModal.tsx', files: ['src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx'] },
    // UploadEvidenceModal renders a form-level upload-error banner
    // (`#upload-error`) rather than per-field validation errors, so
    // `<FormError>` is not the right primitive — the ratchet was stale
    // listing it here. Field-level error surfaces remain ratcheted below.
    {
        label: 'tasks create (modal + fields)',
        files: [
            'src/components/tasks/NewTaskModal.tsx',
            'src/components/tasks/_form/NewTaskFields.tsx',
        ],
    },
];

function readSurface(surface: FormSurface): string {
    return surface.files
        .map((f) => {
            const full = path.join(REPO_ROOT, f);
            if (!fs.existsSync(full)) return '';
            return fs.readFileSync(full, 'utf-8');
        })
        .join('\n');
}

const MIN_FORM_FIELD = FORM_FIELD_SURFACES.length;
const MIN_FORM_ERROR = FORM_ERROR_SURFACES.length;

describe('Epic 55 — FormField adoption ratchet', () => {
    it.each(FORM_FIELD_SURFACES)(
        '$label imports + uses <FormField>',
        (surface) => {
            const src = readSurface(surface);
            expect(src.length).toBeGreaterThan(0);

            expect(src).toMatch(
                /from\s+['"]@\/components\/ui\/form-field['"]/,
            );
            expect(src).toMatch(/<FormField\b/);
        },
    );

    it(
        `at least ${MIN_FORM_FIELD} surfaces carry <FormField> (count can only grow)`,
        () => {
            const instrumented = FORM_FIELD_SURFACES.filter((surface) =>
                readSurface(surface).includes('<FormField'),
            );
            expect(instrumented.length).toBeGreaterThanOrEqual(MIN_FORM_FIELD);
        },
    );
});

describe('Epic 55 — FormError adoption ratchet', () => {
    it.each(FORM_ERROR_SURFACES)(
        '$label surfaces field-level errors via <FormError> OR <FormField error=…>',
        (surface) => {
            const src = readSurface(surface);
            expect(src.length).toBeGreaterThan(0);

            // Two equally-valid surfaces:
            //   (a) Direct `<FormError>` import + JSX usage — the original
            //       Epic 55 pattern, used when the form owns its error
            //       state explicitly (e.g., conditional banners outside
            //       the FormField row).
            //   (b) `<FormField error={...}>` from `@/components/ui/form-field`
            //       — the canonical Epic 64-FORM pattern with
            //       react-hook-form. FormField renders FormError
            //       internally when the `error` prop is set.
            const usesDirectFormError =
                /from\s+['"]@\/components\/ui\/form-error['"]/.test(src) &&
                /<FormError\b/.test(src);
            const usesFormFieldError =
                /from\s+['"]@\/components\/ui\/form-field['"]/.test(src) &&
                /<FormField[\s\S]*?\berror=/.test(src);
            expect(usesDirectFormError || usesFormFieldError).toBe(true);
        },
    );

    it(
        `at least ${MIN_FORM_ERROR} surfaces carry field-level error rendering (count can only grow)`,
        () => {
            const instrumented = FORM_ERROR_SURFACES.filter((surface) => {
                const src = readSurface(surface);
                return (
                    src.includes('<FormError') ||
                    /<FormField[\s\S]*?\berror=/.test(src)
                );
            });
            expect(instrumented.length).toBeGreaterThanOrEqual(MIN_FORM_ERROR);
        },
    );
});
