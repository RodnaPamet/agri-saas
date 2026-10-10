/**
 * Structural ratchet — the gear button gets its hover hint via the Popover's
 * `triggerTooltip` prop, and must NOT hand-roll a `<Tooltip>` wrap inside the
 * Popover trigger.
 *
 * Background: `<Popover><Tooltip><Button/></Tooltip></Popover>` (Tooltip INNER)
 * is functionally broken. Radix's `Popover.Trigger asChild` clones its immediate
 * child (the Tooltip), adding onClick / aria-expanded / data-state. With the
 * Tooltip nested INSIDE the trigger those props are dropped — the gear renders
 * but doesn't open ("gear doesn't open" bug).
 *
 * The fix (UI-20): the canonical hover hint is wired via the Popover's
 * `triggerTooltip` prop, which nests Tooltip OUTER → Popover.Trigger INNER →
 * button so the open onClick stays on the button while the tooltip hover merges
 * through it. The gear files therefore pass `triggerTooltip` and never import or
 * render `<Tooltip>` themselves. Runtime proof:
 * `tests/rendered/popover-trigger-tooltip.test.tsx` (the popover opens WITH a
 * trigger tooltip set); this guard locks the structural shape.
 *
 * Files that render the gear TRIGGER (and so must follow the rule):
 *   • checklist-gear-button.tsx — the shared gear primitive; both toolbar gears
 *     (Edit filter cards + Toggle columns) trigger through it.
 *   • edit-columns-button.tsx — the TanStack table-bound variant.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FILES = [
    'src/components/ui/checklist-gear-button.tsx',
    'src/components/ui/table/edit-columns-button.tsx',
];

describe('Gear button — hover hint via Popover triggerTooltip, no hand-rolled <Tooltip> wrap', () => {
    for (const rel of FILES) {
        describe(rel, () => {
            const src = read(rel);
            // Strip comments — the doc-comment legitimately mentions <Tooltip>.
            const code = blankNonCode(src);

            it('does NOT import or render the Tooltip primitive directly', () => {
                // The composition lives in the Popover (triggerTooltip); the gear
                // file re-adding a direct <Tooltip> import/wrap is the first step
                // of the regression and fails here.
                expect(code).not.toMatch(
                    /import\s*\{[^}]*\bTooltip\b[^}]*\}\s*from\s*['"][.\/]*tooltip['"]/,
                );
                expect(code).not.toMatch(/<Tooltip\b/);
            });

            it('provides the hover hint via the canonical triggerTooltip prop', () => {
                expect(code).toMatch(/triggerTooltip=\{/);
                // The old native `title=` workaround is gone.
                expect(code).not.toMatch(/\btitle=\{title\}/);
            });

            it('preserves screen-reader accessibility via aria-label', () => {
                expect(code).toMatch(/aria-label=["{]/);
            });
        });
    }
});
