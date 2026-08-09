/**
 * UI roadmap (2026-06) — capstone meta-ratchet + audit-polish locks.
 *
 * Two jobs:
 *
 * 1. GUARD THE GUARDS — every per-item ratchet from this 12-item roadmap must
 *    keep existing. A future PR that deletes one (re-opening that regression
 *    class) fails here. Mirrors the codebase's other "*-integrity" meta-ratchets.
 *
 * 2. AUDIT POLISH — the skeptical end-of-roadmap review found three consistency
 *    stragglers (item 14's "no email in owner columns" + item 2/3's "tags one
 *    size smaller" applied to surfaces the original items didn't name). These
 *    are now fixed and locked here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const PER_ITEM_GUARDS = [
    'tests/guards/ui-tables-columns-owner.test.ts', // 21 + 14a + 2/3
    'tests/guards/ui-action-row.test.ts', // 22 + 23
    'tests/guards/ui-chrome-cleanup.test.ts', // 15 + 18
    'tests/guards/ui-setup-wizard-colors.test.ts', // 24
    'tests/guards/ui-canonical-tooltips.test.ts', // 20
    'tests/guards/ui-rightrail-expand-toggle.test.ts', // 13
    'tests/guards/ui-create-gradient.test.ts', // 11
    'tests/guards/ui-profile-name-capture.test.ts', // 14b
];

describe('UI roadmap capstone — guard the guards', () => {
    it.each(PER_ITEM_GUARDS)('per-item ratchet still exists: %s', (g) => {
        expect(exists(g)).toBe(true);
    });
});

describe('UI roadmap capstone — audit polish (owner columns are name-only everywhere)', () => {
    it('Policies owner column uses ownerDisplayName and renders no raw email', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx');
        expect(src).toMatch(/ownerDisplayName\(p\.owner\?\.name, p\.owner\?\.email\)/);
        expect(src).not.toMatch(/\{p\.owner\.email\}/);
    });
    it('Findings assignee column uses ownerDisplayName', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/findings/FindingsClient.tsx');
        expect(src).toMatch(/ownerDisplayName\(f\.assignee\?\.name, f\.assignee\?\.email\)/);
    });
});

describe('UI roadmap capstone — audit polish (tags one size smaller everywhere)', () => {
    it('the practices Browse rail status badge is size="sm" (no stray default-md tag)', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx');
        // Every StatusBadge in this file (table cells + the browse-rail rows)
        // carries size="sm" — no bare `<StatusBadge variant=…>` without a size.
        const badges = src.match(/<StatusBadge[\s\S]*?>/g) ?? [];
        expect(badges.length).toBeGreaterThan(0);
        for (const b of badges) {
            expect(b).toMatch(/size="sm"/);
        }
    });
});
