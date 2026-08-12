/**
 * SP-5 ratchet — the SharePoint sync-health surface must stay wired: the
 * health route and the admin dashboard page that reads it.
 *
 * This ratchet originally covered two halves. The other half — the
 * audit-pack SharePoint export (the FROZEN-gated ZIP upload usecase, the
 * `AuditPack.spExport*` columns, the export route and the export button on
 * the pack detail page) — went with the GRC teardown in phase 2: AuditPack
 * is an inherited GRC model and its pages and routes are deleted. The
 * export usecase itself is deleted with the rest of the KILL app-layer
 * tier; asserting on it here would only re-break this suite mid-teardown.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('SP-5 SharePoint sync health', () => {
    it('the health route exists and is admin.manage-gated', () => {
        const health =
            'src/app/api/t/[tenantSlug]/integrations/sharepoint/health/route.ts';
        expect(exists(health)).toBe(true);
        expect(read(health)).toMatch(
            /requirePermission(<[^>]*>)?\(\s*'admin\.manage'/,
        );
    });

    it('the health dashboard page exists', () => {
        expect(
            exists(
                'src/app/t/[tenantSlug]/(app)/admin/integrations/sharepoint-health/page.tsx',
            ),
        ).toBe(true);
    });

    it('the health dashboard reads the health route', () => {
        const page = read(
            'src/app/t/[tenantSlug]/(app)/admin/integrations/sharepoint-health/page.tsx',
        );
        expect(page).toMatch(/integrations\/sharepoint\/health/);
    });
});
