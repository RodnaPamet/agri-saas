/**
 * PR-C — Forms, filters & interactions ratchet.
 *
 *   1. Filter dropdown's option `value` is space-separated so cmdk's
 *      `commandScore` treats label + value as independent tokens —
 *      fixes "typing in the filter does not actually search".
 *
 *   2. LeftAccordionRail accepts a `persistKey` + `defaultFolded`
 *      and renders a fold/expand toggle. The Practices page wires a
 *      `persistKey` so each user's rail-fold preference sticks.
 *
 *   3. CalendarMonth accepts an `onDoubleClickDate` handler;
 *      CalendarClient wires it to open NewTaskModal seeded with
 *      the clicked day's YMD.
 *
 *   4. NewTaskModal accepts `initialDueAt` and `onCreated`;
 *      `useNewTaskForm` merges any seed into the canonical
 *      `INITIAL`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-C — forms, filters & interactions', () => {
    describe('Filter dropdown option search', () => {
        const src = read('src/components/ui/filter/filter-select.tsx');

        it('Command.Item value is space-separated (label + value)', () => {
            // Pre-PR-C: `value={label + option?.value}` (no separator).
            // Post-PR-C: `value={`${label} ${option?.value ?? filter.key}`}`.
            // The space lets cmdk score the two tokens independently;
            // typing the label alone matches the visible text cleanly.
            expect(src).toMatch(
                /value=\{`\$\{label\}\s+\$\{option\?\.value\s*\?\?\s*filter\.key\}`\}/,
            );
            // Defensive: no remaining concatenation form.
            expect(src).not.toMatch(/value=\{label\s*\+\s*option\?\.value\}/);
        });

        it('Command.Item carries a keywords prop for fuzzy label match', () => {
            // cmdk's `keywords` prop is a second search-text surface;
            // when set it amplifies matches against the visible label.
            expect(src).toMatch(/keywords=\{\[label\]\}/);
        });
    });

    describe('LeftAccordionRail foldable behaviour', () => {
        // 2026-05-25 — the Practices list retired its LeftAccordionRail
        // wiring; the orientation rail moved into an <AsidePanel> on
        // the right (verified by `b7-layout-redesign.test.ts`). The
        // primitive itself still exists in the codebase, so the
        // shape-of-the-primitive assertions below stay — only the
        // Practices page-threading assertion was removed.
        const src = read('src/components/ui/left-accordion-rail.tsx');

        it('primitive declares persistKey + defaultFolded props', () => {
            expect(src).toMatch(/persistKey\?:\s*string/);
            expect(src).toMatch(/defaultFolded\?:\s*boolean/);
        });

        it('renders both the folded spine + expanded shell', () => {
            expect(src).toMatch(/data-rail-folded="true"/);
            expect(src).toMatch(/data-rail-folded="false"/);
            expect(src).toMatch(/data-testid="rail-fold-toggle"/);
        });

        it('persists folded state via localStorage when key supplied', () => {
            // SSR-safe guard: `typeof window === 'undefined'` branch
            // returns the default; otherwise read+write the key.
            expect(src).toMatch(
                /window\.localStorage\.getItem\(persistKey\)/,
            );
            expect(src).toMatch(
                /window\.localStorage\.setItem\(persistKey/,
            );
            expect(src).toMatch(/typeof window === 'undefined'/);
        });
    });

    describe('Calendar double-click → New Task modal', () => {
        const monthSrc = read('src/components/ui/CalendarMonth.tsx');
        const clientSrc = read(
            'src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx',
        );

        it('CalendarMonth declares an onDoubleClickDate prop', () => {
            expect(monthSrc).toMatch(/onDoubleClickDate\?:\s*\(date:\s*string\)\s*=>\s*void/);
        });

        it('CalendarMonth wires onDoubleClick on the day cell', () => {
            // The cell carries an `onDoubleClick={onDoubleClickDate ? () => ... : undefined}`
            expect(monthSrc).toMatch(
                /onDoubleClick=\{[\s\S]{0,200}onDoubleClickDate\(ymd\)/,
            );
        });

        it('CalendarClient mounts NewTaskModal driven by taskCreateDate', () => {
            expect(clientSrc).toMatch(
                /import\s*\{\s*NewTaskModal\s*\}\s*from\s*['"]@\/components\/tasks\/NewTaskModal['"]/,
            );
            expect(clientSrc).toMatch(/setTaskCreateDate\(ymd\)/);
            // The NewTaskModal mount must thread initialDueAt
            // through; an empty mount would defeat the feature.
            expect(clientSrc).toMatch(
                /<NewTaskModal[\s\S]{0,500}initialDueAt=\{taskCreateDate\s*\?\?\s*undefined\}/,
            );
        });
    });

    describe('NewTaskModal pre-fill seam', () => {
        const modalSrc = read(
            'src/components/tasks/NewTaskModal.tsx',
        );
        const hookSrc = read(
            'src/components/tasks/_form/useNewTaskForm.ts',
        );

        it('NewTaskModalProps declares initialDueAt + onCreated', () => {
            expect(modalSrc).toMatch(/initialDueAt\?:\s*string/);
            expect(modalSrc).toMatch(/onCreated\?:\s*\(\)\s*=>\s*void/);
        });

        it('useNewTaskForm merges initialDueAt over the INITIAL seed', () => {
            expect(hookSrc).toMatch(/initialDueAt\?:\s*string/);
            expect(hookSrc).toMatch(
                /initialDueAt\s*\?\s*\{\s*\.\.\.INITIAL,\s*dueAt:\s*initialDueAt\s*\}\s*:\s*INITIAL/,
            );
        });

        it('NewTaskModal skips the router push when onCreated is supplied', () => {
            // Pre-PR-C the success branch unconditionally
            // `router.push(`/farm-tasks/${task.id}`)`. Post-PR-C the
            // calendar caller passes a no-op onCreated so the user
            // stays on the calendar.
            expect(modalSrc).toMatch(
                /if\s*\(onCreated\)\s*\{\s*onCreated\(\);\s*\}\s*else\s*\{\s*router\.push/,
            );
        });
    });
});
