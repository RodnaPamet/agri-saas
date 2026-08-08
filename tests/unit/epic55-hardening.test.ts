/**
 * Epic 55 Prompt 7 — hardening pass contract.
 *
 * Locks in the final migration batch and the architectural doc that
 * guides future contributors:
 *
 *   1. findings/FindingsClient   — severity + type Combobox hideSearch.
 *   2. clauses/ClausesBrowser    — status Combobox hideSearch.
 *   3. policies/new              — category Combobox with search.
 *   4. tasks/new                 — remaining findingSource / gapType /
 *                                  linkEntityType selects migrated.
 *   5. docs/combobox-form-strategy.md exists + covers the decision tree.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

// The severity + type Comboboxes moved from the inline FindingsClient
// form into the CreateFindingModal (2026-06-05). Assert against the
// joined surface — the modal is where the pickers live now.
const FINDINGS_SRC =
    read('src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/findings/CreateFindingModal.tsx');
const CLAUSES_SRC = read(
    'src/app/t/[tenantSlug]/(app)/clauses/ClausesBrowser.tsx',
);
// Modal-form P1 (2026-05-24) — page wrappers decomposed into
// page + extracted form module. Structural assertions resolve
// against the joined surface.
const POLICIES_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/policies/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/policies/NewPolicyModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/policies/_form/NewPolicyFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/policies/_form/useNewPolicyForm.ts');
const TASKS_NEW_SRC =
    read('src/components/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/components/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/components/tasks/_form/useNewTaskForm.ts');
const STRATEGY_DOC = read('docs/combobox-form-strategy.md');

// ─── findings severity + type ───────────────────────────────────

describe('findings/FindingsClient — severity + type', () => {
    it('imports Combobox', () => {
        expect(FINDINGS_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it('no native <select> remains', () => {
        expect(FINDINGS_SRC).not.toMatch(/<select\b/);
    });

    it('exposes finding-severity + finding-type ids', () => {
        expect(FINDINGS_SRC).toMatch(/id=["']finding-severity["']/);
        expect(FINDINGS_SRC).toMatch(/id=["']finding-type["']/);
    });

    it('both use hideSearch (≤5 options)', () => {
        const hits = FINDINGS_SRC.match(/hideSearch/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(2);
    });
});

// ─── clauses status ─────────────────────────────────────────────

describe('clauses/ClausesBrowser — status', () => {
    it('imports Combobox', () => {
        expect(CLAUSES_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it('no native <select> remains', () => {
        expect(CLAUSES_SRC).not.toMatch(/<select\b/);
    });

    it('Combobox preserves id="clause-status-select"', () => {
        expect(CLAUSES_SRC).toMatch(
            /<Combobox[\s\S]{0,500}id=["']clause-status-select["']/,
        );
    });

    it('re-runs its options memo when the i18n bundle changes', () => {
        // The option labels come from t('notStarted') etc., so the
        // array must rebuild when `t` swaps locale.
        expect(CLAUSES_SRC).toMatch(/useMemo[\s\S]{0,400}\[t\]/);
    });

    it('passes the status through to updateStatus() as before', () => {
        expect(CLAUSES_SRC).toMatch(
            /setSelected=\{\(o\)\s*=>\s*\{\s*if\s*\(o\)\s*updateStatus\(selected\.id,\s*o\.value\)/,
        );
    });
});

// ─── policies/new category ──────────────────────────────────────

describe('policies/new — category', () => {
    it('imports Combobox + declares POLICY_CATEGORIES as ComboboxOption[]', () => {
        expect(POLICIES_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
        expect(POLICIES_NEW_SRC).toMatch(
            /POLICY_CATEGORIES:\s*ComboboxOption\[\]/,
        );
    });

    it('no native <select> remains', () => {
        expect(POLICIES_NEW_SRC).not.toMatch(/<select\b/);
    });

    it('Combobox uses search (10 options) and preserves id="policy-category-select"', () => {
        expect(POLICIES_NEW_SRC).toMatch(
            /<Combobox[\s\S]{0,500}id=["']policy-category-select["']/,
        );
        // T09 i18n — searchPlaceholder moved to t('categorySearch'); assert
        // the t() reference AND the en.json value stays "Search categories…".
        expect(POLICIES_NEW_SRC).toMatch(
            /searchPlaceholder=\{\w+\(['"][\w.]*categorySearch['"]\)\}/,
        );
        expect(
            JSON.parse(read('messages/en.json')).policies.fields.categorySearch,
        ).toMatch(/^Search categories/);
    });
});

// ─── tasks/new remaining selects ────────────────────────────────

describe('tasks/new — findingSource / gapType / linkEntityType', () => {
    it('zero native <select> remain in tasks/new', () => {
        expect(TASKS_NEW_SRC).not.toMatch(/<select\b/);
    });

    it('preserves finding-source-select / gap-type-select / link-entity-type ids', () => {
        for (const id of [
            'finding-source-select',
            'gap-type-select',
            'link-entity-type',
        ]) {
            expect(TASKS_NEW_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        }
    });

    it('option arrays are typed ComboboxOption[] (no leftover sentinel empty rows)', () => {
        expect(TASKS_NEW_SRC).toMatch(/FINDING_OPTIONS:\s*ComboboxOption\[\]/);
        expect(TASKS_NEW_SRC).toMatch(/GAP_TYPE_OPTIONS:\s*ComboboxOption\[\]/);
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
        for (const surface of [
            'audits/cycles/page.tsx',
            'controls/NewControlModal.tsx',
            'controls/ControlDetailSheet.tsx',
            'evidence/UploadEvidenceModal.tsx',
            'evidence/NewEvidenceTextModal.tsx',
            'vendors/new/page.tsx',
            'findings/FindingsClient.tsx',
            'clauses/ClausesBrowser.tsx',
            'policies/new/page.tsx',
        ]) {
            expect(guardSrc).toContain(surface);
        }
    });

    it('points contributors to the strategy doc on failure', () => {
        expect(guardSrc).toContain('docs/combobox-form-strategy.md');
    });
});
