/**
 * UI roadmap 20 — canonical tooltips on the table/filter chrome.
 *
 * The column-toggle + filter-card + edit-columns gear buttons used native
 * `title=` because naively wrapping a Popover trigger in <Tooltip> swallowed the
 * open onClick. They now use the canonical Tooltip via the Popover's
 * `triggerTooltip` prop (Tooltip OUTER → Popover.Trigger INNER), proven to still
 * open by tests/rendered/popover-trigger-tooltip.test.tsx.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// an assertion about a string LITERAL would pass vacuously under
// `{ strings: true }`, which is why this stays a per-file decision.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('UI-20 — Popover supports a canonical triggerTooltip', () => {
    const pop = read('src/components/ui/popover.tsx');
    it('Popover exposes triggerTooltip and wraps the Trigger element in <Tooltip>', () => {
        expect(pop).toMatch(/triggerTooltip\?:\s*string/);
        expect(pop).toMatch(/<Tooltip content=\{triggerTooltip\}>/);
    });
});

describe('UI-20 — gear buttons use the canonical tooltip, not native title', () => {
    it('ChecklistGearButton passes triggerTooltip and drops native title', () => {
        const src = read('src/components/ui/checklist-gear-button.tsx');
        expect(src).toMatch(/triggerTooltip=\{title\}/);
        expect(src).not.toMatch(/\btitle=\{title\}/);
    });
    it('EditColumnsButton passes triggerTooltip and drops native title', () => {
        const src = read('src/components/ui/table/edit-columns-button.tsx');
        expect(src).toMatch(/triggerTooltip=\{title\}/);
        expect(src).not.toMatch(/\btitle=\{title\}/);
    });
});
