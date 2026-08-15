/**
 * Epic 55 Prompt 7 — hardening pass contract.
 *
 * Locks in the final migration batch and the architectural doc that
 * guides future contributors:
 *
 *   1. tasks/new                 — remaining linkEntityType select
 *                                  migrated. (findingSource / gapType
 *                                  went with the GRC teardown — see below.)
 *   2. docs/combobox-form-strategy.md exists + covers the decision tree.
 *   3. The native-<select> ratchet guardrail is installed and still
 *      enumerates its surviving drift sentinels.
 *
 * GRC teardown phase 2 removed three of the four migrated surfaces this
 * file covered, along with their pages and their models:
 *   - findings/FindingsClient + findings/CreateFindingModal
 *     (severity + type Combobox hideSearch)
 *   - clauses/ClausesBrowser  (status Combobox hideSearch)
 *   - policies/new            (category Combobox with search)
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const TASKS_NEW_SRC =
    read('src/components/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/components/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/components/tasks/_form/useNewTaskForm.ts');
const STRATEGY_DOC = read('docs/combobox-form-strategy.md');

// ─── tasks/new remaining selects ────────────────────────────────

// GRC teardown phase 2 (operator decision A6) removed the AUDIT_FINDING /
// PRACTICE_GAP task types and with them the whole audit-details sub-form,
// so `finding-source-select` and `gap-type-select` no longer exist. The
// surviving contract is the link-entity select — and the point of this
// block is the NATIVE-<select> ban, which is unchanged.
describe('tasks/new — linkEntityType select', () => {
    it('zero native <select> remain in tasks/new', () => {
        expect(TASKS_NEW_SRC).not.toMatch(/<select\b/);
    });

    it('preserves finding-source-select / gap-type-select / link-entity-type ids', () => {
        for (const id of [
            'link-entity-type',
        ]) {
            expect(TASKS_NEW_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        }
    });

    it('option arrays are typed ComboboxOption[] (no leftover sentinel empty rows)', () => {
        // FINDING_OPTIONS / GAP_TYPE_OPTIONS went with the audit-details
        // sub-form. LINK_ENTITY_OPTIONS survives but is now DERIVED from
        // AddTaskLinkSchema rather than hand-listed, so the annotation sits
        // on the declaration rather than the literal.
        expect(TASKS_NEW_SRC).toMatch(
            /LINK_ENTITY_OPTIONS:\s*ComboboxOption\[\]/,
        );
        // The old sentinel row `{ value: '', label: '— Select source —' }`
        // should be gone; Combobox owns the unset state via placeholder.
        expect(TASKS_NEW_SRC).not.toMatch(
            /\{\s*value:\s*['"]['"]\s*,\s*label:\s*['"]—\s*Select source/,
        );
    });
});

// ─── Strategy doc ───────────────────────────────────────────────

describe('docs/combobox-form-strategy.md', () => {
    it('exists and is non-trivial', () => {
        expect(STRATEGY_DOC.length).toBeGreaterThan(2000);
    });

    it('documents each primitive with a "When to use" section', () => {
        for (const heading of [
            '<Combobox>',
            '<Combobox hideSearch>',
            '<RadioGroup>',
            '<UserCombobox>',
            '<Switch>',
            '<Checkbox>',
        ]) {
            expect(STRATEGY_DOC).toContain(heading);
        }
    });

    it('lists both migrated surfaces and deferred surfaces', () => {
        expect(STRATEGY_DOC).toMatch(/## Migrated surfaces/i);
        expect(STRATEGY_DOC).toMatch(/## Deferred surfaces/i);
        expect(STRATEGY_DOC).toMatch(/## Out of scope/i);
    });

    it('references the ratchet guardrail so contributors find it', () => {
        expect(STRATEGY_DOC).toContain(
            'epic55-native-select-ratchet.test.ts',
        );
    });

    it('includes the contributor checklist', () => {
        expect(STRATEGY_DOC).toMatch(/Adding a new surface — checklist/);
    });
});

// ─── Guardrail presence ─────────────────────────────────────────

describe('Epic 55 — native <select> ratchet is installed', () => {
    const guardPath = 'tests/guards/epic55-native-select-ratchet.test.ts';
    const guardSrc = read(guardPath);

    it('declares a numeric BASELINE_NATIVE_SELECTS constant', () => {
        expect(guardSrc).toMatch(
            /BASELINE_NATIVE_SELECTS\s*=\s*\d+/,
        );
    });

    it('enumerates the migrated surfaces that must not regress', () => {
        // tasks/new/page.tsx dropped when the /tasks compliance UI was retired;
        // its create form now lives in the shared src/components/tasks/ modal.
        //
        // GRC teardown phase 2 dropped the guard's audits/ practices/
        // policies/ vendors/ findings/ clauses/ sentinels with their pages.
        // Rather than shrink this to the two evidence entries that happened
        // to survive, the list is RE-POINTED at the guard's full surviving
        // sentinel set (measured against
        // tests/guards/epic55-native-select-ratchet.test.ts) — so "the guard
        // still names every migrated surface" stays a real bound instead of
        // a token one.
        for (const surface of [
            'evidence/UploadEvidenceModal.tsx',
            'evidence/NewEvidenceTextModal.tsx',
            'assets/[id]/page.tsx',
            'assets/AssetsClient.tsx',
            'admin/members/page.tsx',
            'admin/roles/page.tsx',
            'admin/api-keys/page.tsx',
            'admin/integrations/page.tsx',
            'access-reviews/[reviewId]/AccessReviewDetailClient.tsx',
            'components/ui/map/PrescriptionPanel.tsx',
            'components/ui/VersionDiff.tsx',
            'components/ui/dashboard-widgets/WidgetPicker.tsx',
        ]) {
            expect(guardSrc).toContain(surface);
        }
    });

    it('points contributors to the strategy doc on failure', () => {
        expect(guardSrc).toContain('docs/combobox-form-strategy.md');
    });
});
