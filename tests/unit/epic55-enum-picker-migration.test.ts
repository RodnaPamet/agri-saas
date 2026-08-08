/**
 * Epic 55 Prompt 6 — status/lifecycle/enum migration contract.
 *
 * Asserts the primitive-fit across the five migrated surfaces:
 *   1. tasks/new                  → Combobox hideSearch × 3 (type/severity/priority)
 *   2. controls/NewControlModal   → Combobox × 2 (category/frequency, freq hideSearch)
 *   3. controls/ControlDetailSheet → Combobox × 2 (category/frequency, freq hideSearch)
 *   5. vendors/new                → RadioGroup × 1 (status) + Combobox hideSearch × 2
 *
 * Primitive rules verified:
 *   - ≤3 user-choice options with all-visible semantics  → RadioGroup.
 *   - 4–7 enum options where search adds no value        → Combobox `hideSearch`.
 *   - ≥8 options OR dynamic list                         → Combobox with search.
 *
 * Every migrated control preserves its legacy id for E2E parity and
 * its `name` attribute for native `<form onSubmit>` serialisation.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

// Modal-form P1 (2026-05-24) — the `/tasks/new` and `/vendors/new`
// pages were decomposed into page wrapper + extracted form hook +
// extracted field component. The Epic 55 structural assertions lock
// the migration SHAPE, not the specific file the import / id /
// constant ended up in. Concatenate the relevant files so the
// assertions resolve correctly post-extraction.
const TASK_NEW_SRC =
    read('src/components/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/components/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/components/tasks/_form/useNewTaskForm.ts');
const CONTROL_MODAL_SRC = read(
    'src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx',
);
const CONTROL_SHEET_SRC = read(
    'src/app/t/[tenantSlug]/(app)/controls/ControlDetailSheet.tsx',
);
const VENDORS_NEW_SRC =
    read('src/app/t/[tenantSlug]/(app)/vendors/new/page.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/vendors/NewVendorModal.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/vendors/_form/NewVendorFields.tsx') +
    '\n' +
    read('src/app/t/[tenantSlug]/(app)/vendors/_form/useNewVendorForm.ts');

// ─── 1. tasks/new — type / severity / priority ────────────────────

describe('tasks/new — type / severity / priority Combobox', () => {
    it('imports Combobox', () => {
        expect(TASK_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    const PICKER_IDS = [
        'task-type-select',
        'task-severity-select',
        'task-priority-select',
    ];

    it.each(PICKER_IDS)('no native <select id="%s">', (id) => {
        expect(TASK_NEW_SRC).not.toMatch(
            new RegExp(`<select[^>]*\\bid=["']${id}["']`),
        );
    });

    it.each(PICKER_IDS)(
        'Combobox preserves id="%s" for E2E parity',
        (id) => {
            expect(TASK_NEW_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        },
    );

    it('uses hideSearch — these are ≤5-option enums with no search value', () => {
        // All three pickers should have hideSearch; count at least 3
        // occurrences of the hideSearch flag across the file.
        const hits = TASK_NEW_SRC.match(/hideSearch/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(3);
    });

    it('preserves legacy TYPE_OPTIONS / SEVERITY_OPTIONS / PRIORITY_OPTIONS constants (typed as ComboboxOption[])', () => {
        expect(TASK_NEW_SRC).toMatch(
            /TYPE_OPTIONS:\s*ComboboxOption\[\]/,
        );
        expect(TASK_NEW_SRC).toMatch(
            /SEVERITY_OPTIONS:\s*ComboboxOption\[\]/,
        );
        expect(TASK_NEW_SRC).toMatch(
            /PRIORITY_OPTIONS:\s*ComboboxOption\[\]/,
        );
    });
});

// ─── 2. NewControlModal — category + frequency ────────────────────

describe('NewControlModal — category + frequency Comboboxes', () => {
    it('imports Combobox', () => {
        expect(CONTROL_MODAL_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it.each(['control-category-input', 'control-frequency-input'])(
        'no native <select id="%s">',
        (id) => {
            expect(CONTROL_MODAL_SRC).not.toMatch(
                new RegExp(`<select[^>]*\\bid=["']${id}["']`),
            );
        },
    );

    it.each(['control-category-input', 'control-frequency-input'])(
        'Combobox preserves id="%s"',
        (id) => {
            expect(CONTROL_MODAL_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        },
    );

    it('category Combobox uses search (10 options); frequency uses hideSearch (7)', () => {
        // Category has `searchPlaceholder`; frequency has `hideSearch`.
        // T07 i18n — searchPlaceholder moved to t('newModal.searchCategories');
        // assert the t() reference AND the en.json value stays "Search categories…".
        expect(CONTROL_MODAL_SRC).toMatch(
            /id=["']control-category-input["'][\s\S]{0,800}searchPlaceholder=\{t\(['"]newModal\.searchCategories['"]\)\}/,
        );
        expect(
            JSON.parse(read('messages/en.json')).controls.newModal.searchCategories,
        ).toMatch(/^Search categories/);
        expect(CONTROL_MODAL_SRC).toMatch(
            /id=["']control-frequency-input["'][\s\S]{0,800}hideSearch/,
        );
    });

    it('renders inside <Modal> so nested Comboboxes auto-dropdown (P3.2) — no manual forceDropdown', () => {
        // P3.2 retired the per-call-site `forceDropdown` nesting opt-in.
        // A Combobox inside <Modal> now auto-renders as a portalled
        // dropdown (not a nested Vaul Drawer) because <Modal> wraps its
        // children in OverlayDepthProvider and Popover reads the depth.
        // So the modal needs NEITHER a nested drawer NOR a forceDropdown.
        expect(CONTROL_MODAL_SRC).toMatch(/<Modal[\s.]/);
        expect(CONTROL_MODAL_SRC).not.toMatch(/forceDropdown/);
    });

    it('CATEGORY_OPTIONS + FREQUENCY_OPTIONS are typed ComboboxOption[] (no stale string[] shape)', () => {
        expect(CONTROL_MODAL_SRC).toMatch(
            /FREQUENCY_OPTIONS:\s*ComboboxOption\[\]/,
        );
        expect(CONTROL_MODAL_SRC).toMatch(
            /CATEGORY_OPTIONS:\s*ComboboxOption\[\]/,
        );
    });
});

// ─── 3. ControlDetailSheet — category + frequency ─────────────────

describe('ControlDetailSheet — category + frequency Comboboxes', () => {
    it('imports Combobox', () => {
        expect(CONTROL_SHEET_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
    });

    it.each(['sheet-category-input', 'sheet-frequency-input'])(
        'no native <select id="%s">',
        (id) => {
            expect(CONTROL_SHEET_SRC).not.toMatch(
                new RegExp(`<select[^>]*\\bid=["']${id}["']`),
            );
        },
    );

    it.each(['sheet-category-input', 'sheet-frequency-input'])(
        'Combobox preserves id="%s"',
        (id) => {
            expect(CONTROL_SHEET_SRC).toMatch(
                new RegExp(`<Combobox[\\s\\S]{0,500}id=["']${id}["']`),
            );
        },
    );

    it('both pickers wire disabled={!canWrite} so RBAC mirrors the rest of the sheet', () => {
        const hits = CONTROL_SHEET_SRC.match(/disabled=\{!canWrite\}/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(3); // fieldset + 2 pickers
    });
});

// ─── 5. vendors/new — status RadioGroup + criticality/dataAccess Combobox ─

describe('vendors/new — mixed primitives (RadioGroup + Combobox)', () => {
    it('imports Combobox + RadioGroup + Label', () => {
        expect(VENDORS_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/combobox["']/,
        );
        expect(VENDORS_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/radio-group["']/,
        );
        expect(VENDORS_NEW_SRC).toMatch(
            /from ["']@\/components\/ui\/label["']/,
        );
    });

    it('vendor status uses RadioGroup (2-option user choice, all-visible)', () => {
        expect(VENDORS_NEW_SRC).toMatch(
            /<RadioGroup[\s\S]{0,300}id=["']vendor-status-select["']/,
        );
        expect(VENDORS_NEW_SRC).toMatch(/<RadioGroupItem\b/);
    });

    it('no native <select> for any of the 3 enum pickers', () => {
        for (const id of [
            'vendor-status-select',
            'vendor-criticality-select',
            'vendor-data-access',
        ]) {
            expect(VENDORS_NEW_SRC).not.toMatch(
                new RegExp(`<select[^>]*\\bid=["']${id}["']`),
            );
        }
    });

    it('criticality + dataAccess use Combobox hideSearch (4–5 option enums)', () => {
        // Modal-form P1 — window widened from 500→900 because the
        // extracted field component spreads each Combobox's selected/
        // setSelected callbacks across multi-line indented bodies; the
        // ratchet's intent (the Combobox carries `hideSearch`) doesn't
        // care about formatting density.
        expect(VENDORS_NEW_SRC).toMatch(
            /<Combobox[\s\S]{0,900}id=["']vendor-criticality-select["'][\s\S]{0,900}hideSearch/,
        );
        expect(VENDORS_NEW_SRC).toMatch(
            /<Combobox[\s\S]{0,900}id=["']vendor-data-access["'][\s\S]{0,900}hideSearch/,
        );
    });

    it('DATA_ACCESS_OPTIONS drops the phantom empty-value row (Combobox treats null via placeholder)', () => {
        // Legacy had `{ value: '', label: '— None —' }` as an option.
        // Combobox carries this via `placeholder="— None —"` instead.
        expect(VENDORS_NEW_SRC).toMatch(
            /DATA_ACCESS_OPTIONS:\s*ComboboxOption\[\]\s*=\s*\[\s*\{\s*value:\s*['"]NONE['"]/,
        );
        // T09 i18n — the placeholder moved to t('dataAccessPlaceholder');
        // assert the t() reference AND the en.json value stays "— None —".
        expect(VENDORS_NEW_SRC).toMatch(
            /placeholder=\{\w+\(['"][\w.]*dataAccessPlaceholder['"]\)\}/,
        );
        expect(
            JSON.parse(read('messages/en.json')).vendors.fields.dataAccessPlaceholder,
        ).toBe('— None —');
    });
});

// ─── 6. Cross-cutting drift sentinels ─────────────────────────────

describe('Epic 55 Prompt 6 — drift sentinels', () => {
    it('every migrated picker also carries a `name` attribute for form serialisation', () => {
        for (const [src, ids] of [
            [TASK_NEW_SRC, ['type', 'severity', 'priority']],
            [CONTROL_MODAL_SRC, ['category', 'frequency']],
            [CONTROL_SHEET_SRC, ['category', 'frequency']],
            [VENDORS_NEW_SRC, ['criticality', 'dataAccess']],
        ] as const) {
            for (const name of ids) {
                expect(src).toMatch(
                    new RegExp(`name=["']${name}["']`),
                );
            }
        }
    });

    it('RadioGroup is only used where semantically appropriate (vendor status, 2 options)', () => {
        // Only vendors/new should use <RadioGroup> among the five
        // migrated surfaces; the others should stay on <Combobox>.
        expect(VENDORS_NEW_SRC).toMatch(/<RadioGroup\b/);
        expect(TASK_NEW_SRC).not.toMatch(/<RadioGroup\b/);
        expect(CONTROL_MODAL_SRC).not.toMatch(/<RadioGroup\b/);
        expect(CONTROL_SHEET_SRC).not.toMatch(/<RadioGroup\b/);
    });
});
