/**
 * UI roadmap 21 + 14 ratchet.
 *
 * 21 — the `code` column is OFF by default in the Asset table (still the
 *      leading column DEF per table-unification; just defaultVisible: false in
 *      the columns-dropdown list so it's opt-in via the gear).
 * 14 — `ownerDisplayName` strips the @domain so an owner cell renders a name,
 *      never a raw email.
 *
 * Both rules once covered Risk and Practice too. The risk uproot took the
 * first; the GRC teardown took the second, and 14's per-page assertions went
 * with them -- Asset owner is free-text and Task assignee is already
 * name-only, so only the helper itself is left to guard.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CLIENTS = {
    assets: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
};

describe('UI-21 — code column off by default', () => {
    it.each(Object.entries(CLIENTS))('%s code entry is defaultVisible: false', (_name, file) => {
        const src = read(file);
        // The columns-dropdown list entry for `code` carries defaultVisible:false.
        expect(src).toMatch(/\{\s*id:\s*'code'[^}]*defaultVisible:\s*false[^}]*\}/);
    });
});

describe('UI-14 — Owner column is name-only (no email address)', () => {
    it('ownerDisplayName helper exists + strips the @domain', () => {
        expect(read('src/lib/owner-display.ts')).toMatch(/export function ownerDisplayName/);
    });
});
