/**
 * Roadmap-4 PR-4 — required-field marker discipline.
 *
 * The visual cue for a required form field — a red asterisk next
 * to the label — drifted across seven sites:
 *
 *   • src/app/t/[tenantSlug]/(app)/practices/PracticeDetailSheet.tsx
 *   • src/app/t/[tenantSlug]/(app)/practices/[practiceId]/_modals/EditPracticeModal.tsx
 *   • src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx        (×2)
 *   • src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx
 *   • src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx
 *   • src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/assessment/[assessmentId]/page.tsx
 *
 * Each rendered its own `<span className="text-content-error">*</span>`
 * inline. The drift had two real costs:
 *
 *   1. Accessibility — the inline shape omitted `aria-hidden="true"`
 *      so screen readers announced a literal "asterisk" before each
 *      required field. The `aria-required="true"` on the form
 *      control is the canonical signal for assistive tech; the
 *      visual asterisk is sighted-only and must be hidden from AT.
 *
 *   2. Visual rhythm — three flavours rendered in the codebase:
 *      `<span class="text-content-error">*</span>`,
 *      `<span class="text-content-error ml-1">*</span>`,
 *      and the `<FormField>`-internal canonical
 *      `<span aria-hidden="true" class="ml-1 text-content-error">*</span>`.
 *      Same intent, three flavours.
 *
 * What this ratchet locks
 *
 *   1. The `<RequiredMarker>` primitive lives at
 *      `src/components/ui/required-marker.tsx` with the canonical
 *      shape (`aria-hidden`, `ml-1`, `text-content-error`).
 *   2. `<FormField>` renders a required field via the primitive.
 *   3. No other `.tsx` under `src/` ships an asterisk-shaped span
 *      using `text-content-error` — i.e. the drift pattern
 *      `<span ... text-content-error ...>*</span>` (with optional
 *      surrounding whitespace) is gone everywhere.
 *
 * What this ratchet does NOT police
 *
 *   - Other uses of an asterisk character (footnote refs, "edited"
 *     stars, …). Only the `text-content-error` flavour is the
 *     required-field marker — non-error asterisks are out of scope.
 *
 *   - Text content that happens to contain a literal `*` somewhere
 *     in a string. The detector is anchored on the `<span ...
 *     text-content-error ...>*</span>` shape specifically.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PRIMITIVE = 'src/components/ui/required-marker.tsx';
const FORM_FIELD = 'src/components/ui/form-field.tsx';

describe('Required-field marker discipline (Roadmap-4 PR-4)', () => {
    it('the <RequiredMarker> primitive exists with the locked shape', () => {
        const src = read(PRIMITIVE);
        // Component declared.
        expect(src).toMatch(/export function RequiredMarker/);
        // aria-hidden="true" is mandatory (screen-reader hygiene).
        expect(src).toMatch(/aria-hidden="true"/);
        // Canonical class string. ml-1 + text-content-error.
        expect(src).toMatch(/ml-1 text-content-error/);
        // The asterisk character.
        expect(src).toMatch(/>\s*\*\s*</);
        // Anchor for E2E + ratchets.
        expect(src).toMatch(/data-required-marker/);
    });

    it('<FormField> renders the required cue via the primitive', () => {
        const src = read(FORM_FIELD);
        expect(src).toMatch(
            /import\s+\{\s*RequiredMarker\s*\}\s+from\s+["']\.\/required-marker["']/,
        );
        // The wrapper mounts the primitive when `required` is true.
        expect(src).toMatch(/required\s*&&\s*<RequiredMarker\s*\/>/);
        // The old inline span is gone.
        expect(src).not.toMatch(
            /aria-hidden="true"[\s\S]{0,80}className="ml-1 text-content-error"/,
        );
    });

    it('no other source file hand-rolls an error-toned asterisk span', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                if (rel === PRIMITIVE) continue;
                const src = fs.readFileSync(full, 'utf-8');
                // <span ... text-content-error ...>*</span> shape.
                // Matches both `text-content-error` solo and combos
                // like `text-content-error ml-1`.
                if (
                    /<span[^>]*\btext-content-error\b[^>]*>\s*\*\s*<\/span>/.test(
                        src,
                    )
                ) {
                    offenders.push(rel);
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            throw new Error(
                `These files hand-roll the required-field asterisk span. Use <RequiredMarker /> from @/components/ui/required-marker instead:\n  ${offenders.join('\n  ')}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
