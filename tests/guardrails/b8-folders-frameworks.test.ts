/**
 * B8 — Folders + framework lifecycle ratchet.
 *
 *   1. VendorDocument carries a nullable `folder` column with the
 *      `(tenantId, vendorId, folder)` index for filter/group reads.
 *   2. Vendor-document API + usecase accept `folder` end-to-end —
 *      schema → route → usecase → repository.
 *   3. Vendor detail page exposes a Folder input + a Folder filter
 *      Combobox driven by the docs currently in scope.
 *   4. Audit carries a nullable `frameworkKey` column + an index.
 *      The createAudit usecase + Zod schema + form schema + form
 *      hook + new-audit fields all surface it.
 *   5. Frameworks list page surfaces an "Import framework" primary
 *      CTA and a "Create framework" secondary CTA (the latter opens
 *      a placeholder modal — full custom-framework creation is
 *      queued per the implementation note).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B8 — folders + framework lifecycle', () => {
    describe('VendorDocument.folder schema', () => {
        const src = read('prisma/schema/vendor.prisma');

        it('declares a nullable folder column', () => {
            expect(src).toMatch(/^\s*folder\s+String\?/m);
        });

        it('indexes (tenantId, vendorId, folder) for filter reads', () => {
            expect(src).toMatch(
                /@@index\(\[tenantId,\s*vendorId,\s*folder\]\)/,
            );
        });
    });

    describe('Audit.frameworkKey schema', () => {
        const src = read('prisma/schema/audit.prisma');

        it('declares a nullable frameworkKey column', () => {
            expect(src).toMatch(/^\s*frameworkKey\s+String\?/m);
        });

        it('indexes (tenantId, frameworkKey) for catalog reads', () => {
            expect(src).toMatch(/@@index\(\[tenantId,\s*frameworkKey\]\)/);
        });
    });

    describe('B8 migration', () => {
        const sql = read(
            'prisma/migrations/20260524170000_b8_folders_and_framework_link/migration.sql',
        );

        it('adds the VendorDocument.folder column', () => {
            expect(sql).toMatch(/ALTER TABLE "VendorDocument" ADD COLUMN "folder"/);
        });

        it('adds the Audit.frameworkKey column', () => {
            expect(sql).toMatch(/ALTER TABLE "Audit" ADD COLUMN "frameworkKey"/);
        });

        it('creates both supporting indexes', () => {
            expect(sql).toMatch(/CREATE INDEX "VendorDocument_tenantId_vendorId_folder_idx"/);
            expect(sql).toMatch(/CREATE INDEX "Audit_tenantId_frameworkKey_idx"/);
        });
    });

    describe('Vendor-document folder wiring', () => {
        const schema = read('src/lib/schemas/index.ts');
        const usecase = read('src/app-layer/usecases/vendor.ts');
        const repo = read('src/app-layer/repositories/VendorRepository.ts');
        const page = read(
            'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx',
        );

        it('Zod schema accepts folder', () => {
            // Match the field declaration inside CreateVendorDocumentSchema
            // (the regex is anchored to the export name to avoid
            // matching folder fields in unrelated schemas).
            expect(
                /CreateVendorDocumentSchema[\s\S]{0,2000}folder:\s*z\.string/.test(schema),
            ).toBe(true);
        });

        it('usecase threads folder through sanitisation', () => {
            expect(usecase).toMatch(/folder:\s*sanitizeOptional/);
        });

        it('repository persists folder with empty-coercion', () => {
            expect(repo).toMatch(/folder:\s*data\.folder\?\.trim\(\)\s*\|\|\s*null/);
        });

        it('vendor detail page exposes a Folder input + filter', () => {
            expect(page).toMatch(/id="doc-folder-input"/);
            expect(page).toMatch(/data-testid="doc-folder-filter"/);
        });

        it('vendor detail page filters docs by folder', () => {
            expect(page).toMatch(/docFolderFilter/);
            expect(page).toMatch(/__none__/);
        });
    });

    describe('Audit ↔ Framework wiring', () => {
        const schema = read('src/lib/schemas/index.ts');
        const formSchema = read('src/lib/schemas/audit-form.ts');
        const usecase = read('src/app-layer/usecases/audit.ts');
        const hook = read(
            'src/app/t/[tenantSlug]/(app)/audits/_form/useNewAuditForm.ts',
        );
        const fields = read(
            'src/app/t/[tenantSlug]/(app)/audits/_form/NewAuditFields.tsx',
        );

        it('CreateAuditSchema accepts frameworkKey', () => {
            expect(
                /CreateAuditSchema[\s\S]{0,1500}frameworkKey:\s*z\.string/.test(schema),
            ).toBe(true);
        });

        it('NewAuditFormSchema declares frameworkKey', () => {
            expect(formSchema).toMatch(/frameworkKey:\s*z\.string/);
        });

        it('createAudit usecase passes frameworkKey to the repository', () => {
            expect(usecase).toMatch(/frameworkKey:\s*data\.frameworkKey\s*\?/);
        });

        it('form hook null-coerces frameworkKey in the POST body', () => {
            expect(hook).toMatch(
                /frameworkKey:\s*payload\.frameworkKey\?\.trim\(\)\s*\|\|\s*null/,
            );
        });

        it('NewAuditFields renders a framework Combobox', () => {
            expect(fields).toMatch(/data-testid="audit-framework-select"/);
            expect(fields).toMatch(/setField\(['"]frameworkKey['"]/);
        });

        it('NewAuditFields fetches frameworks on mount', () => {
            expect(fields).toMatch(/apiUrl\(['"]\/frameworks['"]\)/);
        });
    });

});
