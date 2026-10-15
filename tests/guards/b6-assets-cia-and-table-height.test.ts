/**
 * B6 (2026-06-07) — two asset fixes.
 *
 * 1. The C/I/A (confidentiality/integrity/availability) column was removed
 *    from the assets list table (the underlying fields stay on the model +
 *    the edit form — only the list column is gone).
 * 2. The shared Table primitive's 400px min-height floor is now gated to the
 *    EMPTY state. A POPULATED non-fillBody sub-table (e.g. a detail-page
 *    Tasks tab with one task) sized to ~400px before, leaving a big empty,
 *    grid-less area below the row(s); it now sizes to content.
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

const ASSETS = read('src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx');
const TABLE = read('src/components/ui/table/table.tsx');

describe('B6 — assets C/I/A column removed + sub-table height', () => {
    it('the assets list no longer renders the C/I/A column', () => {
        expect(ASSETS).not.toMatch(/id: 'cia'/);
        expect(ASSETS).not.toMatch(/label: 'C\/I\/A'/);
    });

    it('the 400px table floor is gated to the empty state (no dead space under populated sub-tables)', () => {
        // the floor is conditional on numRows === 0, not an unconditional class.
        expect(TABLE).toMatch(/numRows === 0 && "min-h-\[400px\]"/);
        expect(TABLE).not.toMatch(/"relative min-h-\[400px\] overflow-x-auto/);
    });
});
