/**
 * UI roadmap 15 + 18 ratchet — chrome cleanup.
 *
 * 15a — the dashboard no longer renders a notifications button (the top-bar
 *       bell is the single canonical affordance).
 * 15b — the Practices header no longer has a standalone "Frameworks" button.
 * 18  — the evidence +Evidence flow is unified onto the Upload-a-file modal;
 *       the "Upload file" + "Import ZIP" icon buttons + text modal were removed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('UI-15 — removed buttons', () => {
    it('dashboard has no notifications header button', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx');
        expect(src).not.toMatch(/href=\{href\('\/notifications'\)\}/);
        expect(src).not.toMatch(/unreadNotifications > 0 \?/);
    });
});

describe('UI-18 — unified evidence upload', () => {
    const src = read('src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx');
    it('a single +Evidence button opens the Upload-a-file modal', () => {
        expect(src).toMatch(/id="add-evidence-btn"/);
        expect(src).toMatch(/onClick=\{\(\) => setShowUpload\(true\)\}/);
        expect(src).toMatch(/<UploadEvidenceModal\b/);
    });
    it('the upload-file + import-zip icon buttons + text modal are gone', () => {
        expect(src).not.toContain('upload-evidence-btn');
        expect(src).not.toContain('bulk-import-evidence-btn');
        expect(src).not.toContain('add-text-evidence-btn');
        expect(src).not.toMatch(/<NewEvidenceTextModal\b/);
        expect(src).not.toMatch(/<EvidenceBulkImportModal\b/);
    });
});
