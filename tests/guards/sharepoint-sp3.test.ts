/**
 * SP-3 ratchet — the SharePoint evidence-import pipeline must stay wired:
 * the import + delta-sync service, the routes, the BullMQ job (executor +
 * schedule), the sourceUrl column, and the evidence-modal "Import from
 * SharePoint" hook.
 */
import { readCatalogue } from '../helpers/catalogue';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const SP = 'src/app-layer/integrations/providers/sharepoint';

describe('SP-3 SharePoint evidence import', () => {
    it('the import service does manual import + delta sync, never duplicating into a join', () => {
        const src = read(`${SP}/import.ts`);
        expect(src).toMatch(/export async function importSharePointItems/);
        expect(src).toMatch(/export async function runSharePointDeltaSync/);
        expect(src).toMatch(/uploadEvidenceFile/);
        expect(src).toMatch(/integrationSyncMapping\.upsert/);
        expect(src).toMatch(/sourceUrl/);
    });

    it('the import/sync/connections routes exist + are evidence.upload-gated', () => {
        const base = 'src/app/api/t/[tenantSlug]/integrations/sharepoint';
        for (const f of ['import/route.ts', 'sync/route.ts', 'connections/route.ts']) {
            expect(exists(`${base}/${f}`)).toBe(true);
            expect(read(`${base}/${f}`)).toMatch(/requirePermission(<[^>]*>)?\(\s*'evidence\.upload'/);
        }
    });

    it('the delta-sync BullMQ job is registered + scheduled', () => {
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(/register\('sharepoint-delta-sync'/);
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(/register\('sharepoint-delta-sync-dispatch'/);
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/sharepoint-delta-sync-dispatch/);
        expect(read('src/app-layer/jobs/types.ts')).toMatch(/'sharepoint-delta-sync':/);
    });

    it('IntegrationSyncMapping carries sourceUrl', () => {
        expect(read('prisma/schema/automation.prisma')).toMatch(/sourceUrl\s+String\?/);
        expect(exists('prisma/migrations/20260609120000_sync_mapping_source_url/migration.sql')).toBe(true);
    });

    it('the evidence upload modal offers Import from SharePoint', () => {
        const modal = read('src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx');
        expect(modal).toMatch(/SharePointFilePicker/);
        // The "Import from SharePoint" button label was migrated to next-intl
        // (T08 i18n batch) — the literal now lives in messages/en.json under
        // `evidence.upload.importFromSharePoint`. The modal references it via
        // the translation key.
        expect(modal).toMatch(/upload\.importFromSharePoint/);
        const en = JSON.parse(
            JSON.stringify(readCatalogue('en')),
        ) as { evidence: { upload: { importFromSharePoint: string } } };
        expect(en.evidence.upload.importFromSharePoint).toBe('Import from SharePoint');
        expect(modal).toMatch(/\/integrations\/sharepoint\/import/);
    });
});
