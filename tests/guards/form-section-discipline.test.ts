/**
 * Roadmap-2 PR-6 — `<FormSection>` discipline.
 *
 * Forms used to be `<fieldset className="space-y-default">` with no
 * eyebrow grouping. Field dependencies (likelihood × impact for
 * scoring, applicability + justification for controls) lived
 * unframed. After PR-6, every form ≥ 6 fields wraps its content
 * in `<FormSection>` so the structure is visible before fields
 * are read.
 *
 * What this ratchet locks in
 *   1. The `<FormSection>` primitive exists at the canonical path
 *      with the documented prop surface (eyebrow + title +
 *      description + children).
 *   2. The proof-of-pattern adopter (NewRiskModal) imports AND
 *      mounts `<FormSection>`. Removing it returns the modal to
 *      a flat-fieldset shape and the visual rhythm regresses.
 *
 * Future modal migrations
 *   When NewControlModal, EditControlModal, UploadEvidenceModal,
 *   and the vendor-assessment forms migrate, extend the
 *   `ADOPTERS` array in this ratchet. A migration PR that adds
 *   the import + mount is the trigger to extend the curated
 *   list.
 *
 * What this ratchet does NOT police
 *   The exact eyebrow strings or section subdivision. Pages own
 *   their own narrative — the ratchet only asserts the slot is
 *   used, not what fills it.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PRIMITIVE_PATH = 'src/components/ui/form-section.tsx';

// Repointed by the risk-register uproot: this listed
// `risks/NewRiskModal.tsx`, and emptying the array would have left the
// ratchet vacuously green. The findings create-modal is the surviving
// multi-section form.
const ADOPTERS = [
    'src/app/t/[tenantSlug]/(app)/findings/CreateFindingModal.tsx',
];

describe('FormSection discipline (Roadmap-2 PR-6)', () => {
    it('the FormSection primitive exists at the canonical path', () => {
        expect(fs.existsSync(path.join(ROOT, PRIMITIVE_PATH))).toBe(true);
    });

    it('the primitive exposes the documented props', () => {
        const src = read(PRIMITIVE_PATH);
        expect(src).toMatch(/export\s+function\s+FormSection/);
        for (const prop of ['eyebrow', 'title', 'description', 'children']) {
            expect(src).toMatch(
                new RegExp(`\\b${prop}\\??:`),
            );
        }
    });

    it('the primitive forwards stable test ids per slot', () => {
        const src = read(PRIMITIVE_PATH);
        for (const id of [
            'form-section',
            'form-section-eyebrow',
            'form-section-title',
            'form-section-description',
        ]) {
            // Quote-agnostic — the id may appear as 'x' or "x"
            // depending on JSX vs JS context.
            expect(src).toMatch(new RegExp(`['"]${id}['"]`));
        }
    });

    it('the curated adopters import AND mount FormSection', () => {
        const offenders: string[] = [];
        for (const rel of ADOPTERS) {
            const src = read(rel);
            const importsIt = /from\s+['"]@\/components\/ui\/form-section['"]/.test(
                src,
            );
            const mountsIt = /<FormSection\b/.test(src);
            if (!importsIt || !mountsIt) {
                offenders.push(
                    `${rel} (import: ${importsIt}, mount: ${mountsIt})`,
                );
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `These curated FormSection adopters are missing the import or mount:\n  ${offenders.join('\n  ')}\n\nEither restore the FormSection adoption or remove the file from this ratchet's curated list with a written reason.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
