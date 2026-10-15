/**
 * SP-2 ratchet — the SharePoint browse plane must stay wired: the practitioner
 * browse/sites routes (evidence.upload-gated), the service flatteners, and the
 * file-picker component's core affordances (multi/single select, type filter,
 * breadcrumb, lazy folder load via the browse route).
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
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('SP-2 SharePoint browser', () => {
    it('the practitioner browse + sites routes exist and are evidence.upload-gated', () => {
        const base = 'src/app/api/t/[tenantSlug]/integrations/sharepoint';
        for (const f of ['browse/route.ts', 'sites/route.ts']) {
            expect(exists(`${base}/${f}`)).toBe(true);
            expect(read(`${base}/${f}`)).toMatch(/requirePermission(<[^>]*>)?\(\s*'evidence\.upload'/);
        }
    });

    it('the service flattens DriveItems + resolves sites/drives', () => {
        const svc = read('src/app-layer/integrations/providers/sharepoint/service.ts');
        expect(svc).toMatch(/export async function browseSharePoint/);
        expect(svc).toMatch(/export async function getSharePointSitesAndDrives/);
        expect(svc).toMatch(/isFolder/);
    });

    it('the file picker supports multi/single select, type filter, breadcrumb + lazy browse', () => {
        const f = 'src/components/integrations/sharepoint/SharePointFilePicker.tsx';
        expect(exists(f)).toBe(true);
        const src = read(f);
        expect(src).toMatch(/multiple/);
        expect(src).toMatch(/Filter/); // file-type filter
        expect(src).toMatch(/breadcrumb|gotoCrumb|path\.map/i);
        expect(src).toMatch(/\/integrations\/sharepoint\/browse/);
        expect(src).toMatch(/\/integrations\/sharepoint\/sites/);
        expect(src).toMatch(/onConfirm/);
    });
});
