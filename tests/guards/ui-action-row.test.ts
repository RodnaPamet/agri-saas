/**
 * UI roadmap 22 + 23 ratchet — table selection action row.
 *
 * 22 — the Farm Tasks bulk "Assign" action uses a real people-picker
 *      (UserCombobox), not a raw "User ID" text input.
 * 23 — the selection toolbar carries a thin brand-coloured lower border
 *      (`--brand-default`: orange light / yellow dark).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// some assertions below are about string LITERALS, and `{ strings: true }`
// would blank those too and pass vacuously — the trap that makes this
// conversion a per-file decision rather than a sweep.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('UI-22 — Farm Tasks bulk Assign uses a people-picker', () => {
    const src = read('src/app/t/[tenantSlug]/(app)/farm-tasks/FarmTasksClient.tsx');
    it('renders <UserCombobox> for the assign action (no raw User ID input)', () => {
        expect(src).toMatch(/bulkAction === 'assign'[\s\S]{0,200}<UserCombobox/);
        expect(src).not.toMatch(/placeholder="User ID \(blank = unassign\)"/);
    });
});

describe('UI-23 — selection toolbar has a brand lower border', () => {
    it('selection-toolbar bottom border is brand-coloured', () => {
        const src = read('src/components/ui/table/selection-toolbar.tsx');
        expect(src).toMatch(/border-b border-\[var\(--brand-default\)\]/);
    });
});
