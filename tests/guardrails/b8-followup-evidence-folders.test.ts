/**
 * B8 follow-up — Evidence folders ratchet.
 *
 * Pairs with `b8-folders-frameworks.test.ts` (which locks the
 * VendorDocument folder pattern). This ratchet locks the same
 * shape on the bigger "documents" surface: Evidence.
 *
 *   1. `Evidence.folder String?` + `(tenantId, folder)` index in
 *      the Prisma schema.
 *   2. Migration `20260524190000_b8_evidence_folder` adds the
 *      column + the supporting index.
 *   3. `CreateEvidenceSchema` + `UpdateEvidenceSchema` accept the
 *      `folder` field with a 120-char cap.
 *   4. `createEvidence` + `updateEvidence` usecases trim +
 *      null-coerce the folder value (so empty input maps to
 *      "no folder" rather than the empty string).
 *   5. `uploadEvidenceFile` honours `folder` so file uploads land
 *      in the same folder as TEXT/LINK evidence.
 *   6. The `__none__` filter sentinel resolves to NULL/empty in
 *      `EvidenceRepository._buildWhere`.
 *   7. The evidence list page renders a Folder column, exposes
 *      the Folder filter via the toolbar, and mounts a shared
 *      `evidence-folder-suggestions` datalist for the create +
 *      upload modals.
 *   8. The Edit modal's `initial` shape carries `folder`, and the
 *      Edit modal renders a Folder input.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B8 follow-up — evidence folders', () => {
    describe('Schema + migration', () => {
        const compliance = read('prisma/schema/compliance.prisma');
        const migration = read(
            'prisma/migrations/20260524190000_b8_evidence_folder/migration.sql',
        );

        it('Evidence carries a nullable folder column', () => {
            // Anchor on the Evidence model so a `folder` field on
            // another model can't false-match.
            const evidenceBlock = compliance.slice(
                compliance.indexOf('model Evidence {'),
                compliance.indexOf('model FileRecord {'),
            );
            expect(evidenceBlock).toMatch(/^\s*folder\s+String\?/m);
        });

        it('Evidence indexes (tenantId, folder)', () => {
            const evidenceBlock = compliance.slice(
                compliance.indexOf('model Evidence {'),
                compliance.indexOf('model FileRecord {'),
            );
            expect(evidenceBlock).toMatch(
                /@@index\(\[tenantId,\s*folder\]\)/,
            );
        });

        it('migration adds the column + index', () => {
            expect(migration).toMatch(
                /ALTER TABLE "Evidence" ADD COLUMN "folder"/,
            );
            expect(migration).toMatch(
                /CREATE INDEX "Evidence_tenantId_folder_idx"/,
            );
        });
    });

    describe('Zod schema coverage', () => {
        const schema = read('src/lib/schemas/index.ts');

        it('CreateEvidence base schema accepts folder', () => {
            expect(
                /_CreateEvidenceBase[\s\S]{0,800}folder:\s*z\.string\(\)\.max\(120\)/.test(
                    schema,
                ),
            ).toBe(true);
        });

        it('UpdateEvidenceSchema accepts folder', () => {
            // Sliced from the declaration to its closing `})`, not matched
            // within a fixed character window. The window was 800 chars, and
            // a comment added above `folder` pushed it out of range — the
            // assertion then failed for a field that was still there, which
            // is a test measuring distance rather than the invariant.
            const block = schema.slice(schema.indexOf('export const UpdateEvidenceSchema'));
            const decl = block.slice(0, block.indexOf('})'));
            expect(decl).toMatch(/folder:\s*z\.string\(\)\.max\(120\)/);
        });
    });

    describe('Usecase wiring', () => {
        const usecase = read('src/app-layer/usecases/evidence.ts');

        // Folder values are trimmed, null-coerced when empty, AND sanitised
        // (Epic C.5 — evidence free text reaches the PDF export and the
        // audit-pack share link verbatim). The assertions below allow the
        // sanitiser wrapper rather than pinning the exact pre-sanitisation
        // expression, so adding a second wrapper does not fail a rule that
        // still holds.
        it('createEvidence trims + null-coerces folder', () => {
            expect(usecase).toMatch(
                /folder:\s*data\.folder\?\.trim\(\)\s*\?[\s\S]{0,120}data\.folder\.trim\(\)[\s\S]{0,40}:\s*null/,
            );
        });

        it('updateEvidence honours the three-state contract', () => {
            // undefined = no change, null = clear, string = set.
            expect(usecase).toMatch(
                /folder:[\s\S]{0,80}data\.folder === undefined[\s\S]{0,80}undefined[\s\S]{0,200}:\s*null\)/,
            );
        });

        it('uploadEvidenceFile threads folder onto the new row', () => {
            expect(usecase).toMatch(
                /folder:\s*metadata\.folder\?\.trim\(\)\s*\?[\s\S]{0,120}metadata\.folder\.trim\(\)[\s\S]{0,40}:\s*null/,
            );
        });

        it('folder is sanitised on every write path', () => {
            // The reason the shapes above changed. Three call sites, each
            // routing the trimmed value through the sanitiser.
            const sanitisedFolders = usecase.match(/sanitizePlainText\((?:data|metadata)\.folder\.trim\(\)\)/g) ?? [];
            expect(sanitisedFolders.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('Repository filter (__none__ sentinel)', () => {
        const src = read('src/app-layer/repositories/EvidenceRepository.ts');

        it('declares folder on EvidenceListFilters', () => {
            // Interface block, not a character window — the multi-select
            // facets above `folder` grew a comment explaining why they are
            // arrays, and a 500-char window then missed a field that had not
            // moved.
            const block = src.slice(src.indexOf('export interface EvidenceListFilters'));
            expect(block.slice(0, block.indexOf('\n}'))).toMatch(/folder\?:\s*string/);
        });

        it('selects the folder column for the list shape', () => {
            expect(src).toMatch(/^\s*folder:\s*true,/m);
        });

        it('resolves __none__ to a NULL-or-empty WHERE clause', () => {
            expect(src).toMatch(
                /filters\.folder === ['"]__none__['"][\s\S]{0,200}folder:\s*null/,
            );
        });
    });

    describe('API GET route', () => {
        const route = read(
            'src/app/api/t/[tenantSlug]/evidence/route.ts',
        );

        it('EvidenceQuerySchema accepts folder', () => {
            expect(route).toMatch(/folder:\s*z\.string\(\)\.optional\(\)/);
        });

        it('threads query.folder into the filters object', () => {
            expect(route).toMatch(/folder:\s*query\.folder/);
        });
    });

    describe('Upload route forwards folder', () => {
        const upload = read(
            'src/app/api/t/[tenantSlug]/evidence/uploads/route.ts',
        );

        it('reads folder from the multipart form data', () => {
            expect(upload).toMatch(
                /folder:\s*formData\.get\(['"]folder['"]\)/,
            );
        });
    });

    describe('Filter defs surface the Folder filter', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/evidence/filter-defs.ts',
        );

        it('declares the folder filter def', () => {
            expect(src).toMatch(/folder:\s*\{[\s\S]{0,400}label:\s*['"]Folder['"]/);
        });

        it('builds folder options at render time from loaded evidence', () => {
            expect(src).toMatch(/export function folderOptionsFromEvidence/);
            expect(src).toMatch(/__none__/);
        });

        it('buildEvidenceFilters accepts evidence + injects folder options', () => {
            expect(src).toMatch(
                /buildEvidenceFilters\([\s\S]{0,200}evidence: ReadonlyArray<EvidenceFolderLike>/,
            );
        });
    });

    describe('Modals + table', () => {
        const newText = read(
            'src/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal.tsx',
        );
        const upload = read(
            'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx',
        );
        const edit = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal.tsx',
        );
        const client = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
        );

        it('New TEXT evidence modal carries a Folder input', () => {
            expect(newText).toMatch(/data-testid="text-evidence-folder-input"/);
            expect(newText).toMatch(/list="evidence-folder-suggestions"/);
        });

        it('Upload modal carries a Folder input', () => {
            expect(upload).toMatch(/data-testid="upload-evidence-folder-input"/);
            expect(upload).toMatch(/list="evidence-folder-suggestions"/);
        });

        it('Upload mutation forwards the folder value via FormData', () => {
            expect(upload).toMatch(/formData\.append\(['"]folder['"]/);
        });

        it('Edit modal accepts a folder seed + renders a Folder input', () => {
            expect(edit).toMatch(/folder\?:\s*string\s*\|\s*null/);
            expect(edit).toMatch(/data-testid="edit-evidence-folder-input"/);
        });

        it('EvidenceClient threads evidence into the filter toolbar (via buildEvidenceFilters)', () => {
            // R-filter-gear (2026-06-07): the filters are now built in the
            // PARENT (so the filter gear can sit beside the columns gear in
            // the actions slot) and the visible subset is passed down — but
            // `evidence` still drives the folder filter options through
            // buildEvidenceFilters, and the built defs reach the toolbar.
            expect(client).toMatch(/buildEvidenceFilters\([\s\S]{0,120}evidence/);
            expect(client).toMatch(
                /<EvidenceFilterToolbar[\s\S]{0,120}filters=\{visibleFilterDefs\}/,
            );
        });

        it('EvidenceClient declares a global folder-suggestions datalist', () => {
            expect(client).toMatch(/<datalist id="evidence-folder-suggestions">/);
        });

        it('EvidenceClient adds a Folder column to the table', () => {
            // T08 i18n — the header moved to a next-intl call
            // (tr('client.colFolder')); assert the t() reference AND that
            // the en.json value stays "Folder".
            expect(client).toMatch(/id:\s*['"]folder['"][\s\S]{0,200}header:\s*\w+\(['"][\w.]*colFolder['"]\)/);
            const messages = JSON.parse(read('messages/en.json'));
            expect(messages.evidence.client.colFolder).toBe('Folder');
        });
    });
});
