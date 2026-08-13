/**
 * Epic 55 Prompt 6 — status/lifecycle/enum migration contract.
 *
 * Asserts the primitive-fit across the migrated surfaces:
 *   1. tasks/new                  → Combobox hideSearch × 3 (type/severity/priority)
 *
 * GRC teardown phase 2 removed the other three surfaces this file
 * covered, along with their pages and their models:
 *   - practices/NewPracticeModal    (category/frequency Comboboxes)
 *   - practices/PracticeDetailSheet (category/frequency Comboboxes)
 *   - vendors/new                   (status RadioGroup + criticality /
 *                                    dataAccess Comboboxes)
 * The vendor surface was the file's only <RadioGroup> call site, so the
 * "RadioGroup only where semantically appropriate" sentinel went with it
 * rather than being kept as a negative-only assertion about tasks/new
 * (which would have been green forever regardless of the rollout).
 *
 * Primitive rules verified:
 *   - ≤3 user-choice options with all-visible semantics  → RadioGroup.
 *   - 4–7 enum options where search adds no value        → Combobox `hideSearch`.
 *   - ≥8 options OR dynamic list                         → Combobox with search.
 *
 * Every migrated picker preserves its legacy id for E2E parity and
 * its `name` attribute for native `<form onSubmit>` serialisation.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

// Modal-form P1 (2026-05-24) — the `/tasks/new` page was decomposed
// into page wrapper + extracted form hook + extracted field component.
// The Epic 55 structural assertions lock the migration SHAPE, not the
// specific file the import / id / constant ended up in. Concatenate the
// relevant files so the assertions resolve correctly post-extraction.
const TASK_NEW_SRC =
    read('src/components/tasks/NewTaskModal.tsx') +
    '\n' +
    read('src/components/tasks/_form/NewTaskFields.tsx') +
    '\n' +
    read('src/components/tasks/_form/useNewTaskForm.ts');

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

// ─── 2. Cross-cutting drift sentinels ─────────────────────────────

describe('Epic 55 Prompt 6 — drift sentinels', () => {
    it('every migrated picker also carries a `name` attribute for form serialisation', () => {
        // GRC teardown phase 2 — the practices / vendors rows of this
        // table went with their pages; tasks/new is the surviving surface.
        for (const [src, ids] of [
            [TASK_NEW_SRC, ['type', 'severity', 'priority']],
        ] as const) {
            for (const name of ids) {
                expect(src).toMatch(
                    new RegExp(`name=["']${name}["']`),
                );
            }
        }
    });
});
