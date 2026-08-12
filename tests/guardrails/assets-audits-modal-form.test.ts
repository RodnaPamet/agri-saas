/**
 * Modal-form follow-up — assets-CREATE + audits-CREATE were missed by
 * the original P2 (which scoped tasks / policies / vendors /
 * assets-EDIT only). This ratchet locks in the migration so a future
 * refactor cannot bring the inline `showForm` + `<form onSubmit>`
 * pattern back to either list page.
 *
 * Twins of the established modal-form-extractions / modal-form-p3
 * tests for the four flows that shipped earlier.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Modal-form follow-up — assets-create + audits-create', () => {
    describe('Assets', () => {
        const client = read(
            'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
        );

        it('AssetsClient mounts <NewAssetModal>', () => {
            expect(client).toMatch(/import \{ NewAssetModal \}/);
            expect(client).toMatch(/<NewAssetModal\b/);
        });

        it('AssetsClient reads ?create=1 and opens the modal', () => {
            expect(client).toMatch(
                /searchParams\?\.get\(['"]create['"]\)\s*===\s*['"]1['"]/,
            );
            expect(client).toMatch(/setIsCreateOpen\(true\)/);
        });

        it('legacy inline showForm pattern is retired', () => {
            // No more `useState` toggle named showForm, no inline
            // <form onSubmit={createAsset}>, no inline createMutation.
            expect(client).not.toMatch(/\bsetShowForm\b/);
            expect(client).not.toMatch(/\bshowForm\b/);
            expect(client).not.toMatch(/onSubmit=\{createAsset\}/);
            expect(client).not.toMatch(/const createAsset\b/);
            expect(client).not.toMatch(/const createMutation\b/);
        });

        it('hook + fields + modal triple all exist with the canonical naming', () => {
            const base = 'src/app/t/[tenantSlug]/(app)/assets';
            expect(
                fs.existsSync(path.join(ROOT, base, '_form/useNewAssetForm.ts')),
            ).toBe(true);
            expect(
                fs.existsSync(path.join(ROOT, base, '_form/NewAssetFields.tsx')),
            ).toBe(true);
            expect(fs.existsSync(path.join(ROOT, base, 'NewAssetModal.tsx'))).toBe(
                true,
            );
            expect(
                fs.existsSync(path.join(ROOT, base, 'new/page.tsx')),
            ).toBe(true);
        });

        it('/assets/new page is a redirect shim, not a full-page form', () => {
            const shim = read(
                'src/app/t/[tenantSlug]/(app)/assets/new/page.tsx',
            );
            expect(shim).toMatch(/import \{ redirect \} from ['"]next\/navigation['"]/);
            expect(shim).toMatch(/redirect\(`\/t\/\$\{tenantSlug\}\/assets\?create=1`\)/);
        });

        it('modal hook owns submit + isDirty + canSubmit (P3 contract)', () => {
            const hook = read(
                'src/app/t/[tenantSlug]/(app)/assets/_form/useNewAssetForm.ts',
            );
            expect(hook).toMatch(/canSubmit/);
            expect(hook).toMatch(/isDirty/);
            expect(hook).toMatch(/submit:\s*\(\)\s*=>\s*Promise<void>/);
        });
    });

    describe('Audits', () => {
        const client = read(
        );

        it('AuditsClient mounts <NewAuditModal>', () => {
            expect(client).toMatch(/import \{ NewAuditModal \}/);
            expect(client).toMatch(/<NewAuditModal\b/);
        });

        it('AuditsClient reads ?create=1 and opens the modal', () => {
            expect(client).toMatch(
                /searchParams\?\.get\(['"]create['"]\)\s*===\s*['"]1['"]/,
            );
            expect(client).toMatch(/setIsCreateOpen\(true\)/);
        });

        it('legacy inline showForm pattern is retired', () => {
            expect(client).not.toMatch(/\bsetShowForm\b/);
            expect(client).not.toMatch(/\bshowForm\b/);
            expect(client).not.toMatch(/onSubmit=\{createAudit\}/);
            expect(client).not.toMatch(/const createAudit\b/);
            expect(client).not.toMatch(/const createMutation\b/);
        });

        it('hook + fields + modal triple all exist with the canonical naming', () => {
            const base = 'src/app/t/[tenantSlug]/(app)/audits';
            expect(
                fs.existsSync(path.join(ROOT, base, '_form/useNewAuditForm.ts')),
            ).toBe(true);
            expect(
                fs.existsSync(path.join(ROOT, base, '_form/NewAuditFields.tsx')),
            ).toBe(true);
            expect(fs.existsSync(path.join(ROOT, base, 'NewAuditModal.tsx'))).toBe(
                true,
            );
            expect(
                fs.existsSync(path.join(ROOT, base, 'new/page.tsx')),
            ).toBe(true);
        });

        it('/audits/new page is a redirect shim, not a full-page form', () => {
            const shim = read(
            );
            expect(shim).toMatch(/import \{ redirect \} from ['"]next\/navigation['"]/);
            expect(shim).toMatch(/redirect\(`\/t\/\$\{tenantSlug\}\/audits\?create=1`\)/);
        });

        it('modal hook owns submit + isDirty + canSubmit (P3 contract)', () => {
            const hook = read(
            );
            expect(hook).toMatch(/canSubmit/);
            expect(hook).toMatch(/isDirty/);
            expect(hook).toMatch(/submit:\s*\(\)\s*=>\s*Promise<void>/);
        });

        it('the create-audit response still lands the user on the new row', () => {
            // The legacy flow called `loadAudit(a.id)` from the
            // create mutation's onSuccess. The modal flow keeps this
            // via the `onCreated` callback so the master/detail UX
            // doesn't regress.
            expect(client).toMatch(
                /onCreated=\{\(a\)\s*=>\s*loadAudit\(a\.id\)\}/,
            );
        });
    });
});
