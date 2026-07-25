/**
 * B1 (2026-06-07) — the row-select action bar lives in the column-header
 * row, NOT a right-rail (Controls) or a standalone section (Tasks).
 *
 * The DataTable's `SelectionToolbar` already overlays the `<thead>` row
 * (absolute, top-0, z-30). B1:
 *   - Controls: the bulk-status verbs moved from the `SelectionSummaryPanel`
 *     right-rail BACK into the DataTable's `batchActions` (header bar).
 *   - Tasks: the standalone `#bulk-toolbar` card moved into the DataTable's
 *     `selectionControls` (the inline form renders in the header bar).
 *   - The bar height now matches the header row (`h-9`, was `h-11` — it
 *     overhung the header by ~8px), and batch-action chips don't wrap.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CONTROLS = read('src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
const TASKS = read('src/app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx');
const TOOLBAR = read('src/components/ui/table/selection-toolbar.tsx');

describe('B1 — row-select action bar in the header row', () => {
    it('Controls renders bulk-status verbs via batchActions, NOT a selection right-rail', () => {
        expect(CONTROLS).toMatch(/batchActions:\s*controlBatchActions/);
        // i18n batch T07 — the bulk-status verb label routes through
        // next-intl (`t('list.markImplemented')`); assert the key is wired
        // AND the en.json value preserves the "Mark Implemented" copy.
        expect(CONTROLS).toMatch(/t\(['"]list\.markImplemented['"]\)/);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(require('../../messages/en.json').controls.list.markImplemented).toBe('Mark Implemented');
        // The selection-summary right-rail is gone.
        expect(CONTROLS).not.toMatch(/SelectionSummaryPanel/);
    });

    it('Farm Tasks renders the bulk-edit form via selectionControls, NOT a standalone #bulk-toolbar', () => {
        // Farm Tasks wires the bulk form through the DataTable's
        // `selectionControls` slot (object-property form inside the
        // `table={{ … }}` prop) so it renders in the header bar.
        expect(TASKS).toMatch(/selectionControls:\s*\(\)\s*=>/);
        expect(TASKS).toMatch(/id="bulk-apply-btn"/);
        // The standalone bulk-action card is gone.
        expect(TASKS).not.toMatch(/id="bulk-toolbar"/);
    });

    it('the selection toolbar matches the column-header row height (h-9, not h-11)', () => {
        expect(TOOLBAR).toMatch(/flex h-9 items-center/);
        expect(TOOLBAR).not.toMatch(/flex h-11 items-center/);
    });

    it('batch-action chips do not wrap (whitespace-nowrap) so they fit the slim bar', () => {
        expect(TOOLBAR).toMatch(/inline-flex items-center gap-1\.5 whitespace-nowrap/);
    });
});
