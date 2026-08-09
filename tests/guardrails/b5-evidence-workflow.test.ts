/**
 * B5 — Evidence workflow completion ratchet.
 *
 *   1. Evidence rows open on click via the new detail sheet —
 *      pre-B5 the table was effectively read-only.
 *   2. Edit-after-create works through `EditEvidenceModal` (hooked
 *      into `PATCH /evidence/:id` which already existed).
 *   3. Approval flow buttons exposed from the detail sheet —
 *      Submit / Approve / Reject / Re-submit / Re-certify — all
 *      route back through the parent's existing optimistic
 *      `submitReview` mutation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B5 — Evidence workflow completion', () => {
    describe('Move 1 — Detail sheet opens on row click', () => {
        const sheet = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx',
        );
        const client = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
        );

        it('EvidenceDetailSheet primitive exists', () => {
            expect(sheet).toMatch(/export function EvidenceDetailSheet/);
            expect(sheet).toMatch(/import \{ Sheet \}/);
        });

        it('EvidenceClient mounts the sheet + wires row-click', () => {
            expect(client).toMatch(/import \{ EvidenceDetailSheet \}/);
            expect(client).toMatch(/<EvidenceDetailSheet\b/);
            expect(client).toMatch(/onRowClick=\{\(row\) => \{/);
            expect(client).toMatch(/setDetailSheetOpen\(true\)/);
        });
    });

    describe('Move 2 — Edit-after-create', () => {
        const sheet = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx',
        );
        const modal = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal.tsx',
        );
        const client = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx',
        );

        it('EditEvidenceModal primitive exists', () => {
            expect(modal).toMatch(/export function EditEvidenceModal/);
            // The tenant evidence route exposes PUT (not PATCH) for
            // metadata updates; the modal must match it or every save
            // 405s. Originally this asserted PATCH, codifying that bug.
            expect(modal).toMatch(/method:\s*['"]PUT['"]/);
            expect(modal).toMatch(/\/evidence\/\$\{initial\.id\}/);
        });

        it('EditEvidenceModal has Title (required) + Description + Owner + PracticeId fields', () => {
            expect(modal).toMatch(/edit-evidence-title-input/);
            expect(modal).toMatch(/edit-evidence-description/);
            expect(modal).toMatch(/edit-evidence-owner-input/);
            expect(modal).toMatch(/edit-evidence-practice-input/);
        });

        it('EvidenceClient mounts the edit modal + threads onSaved → invalidateEvidence', () => {
            expect(client).toMatch(/import \{ EditEvidenceModal \}/);
            expect(client).toMatch(/<EditEvidenceModal\b/);
            expect(client).toMatch(
                /onSaved=\{\(\) => \{[\s\S]{0,200}invalidateEvidence\(\)/,
            );
        });

        it('detail sheet edit button calls onEdit with the loaded values', () => {
            // The sheet's footer renders an icon-only edit button that
            // invokes onEdit({ id, title, description, ownerUserId, practiceId })
            // so the client can preload the modal.
            expect(sheet).toMatch(/evidence-sheet-edit-btn/);
            expect(sheet).toMatch(/onEdit\(\{[\s\S]{0,200}id:\s*evidence\.id/);
        });
    });

    describe('Move 3 — Approval flow completion', () => {
        const sheet = read(
            'src/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx',
        );

        it('renders Submit-for-review on DRAFT', () => {
            expect(sheet).toMatch(/evidence\.status === 'DRAFT'/);
            expect(sheet).toMatch(/evidence-sheet-submit-btn/);
            expect(sheet).toMatch(/onReview\(evidence\.id, 'SUBMITTED'\)/);
        });

        it('renders Approve + Reject (admin-only) on SUBMITTED', () => {
            expect(sheet).toMatch(/canAdmin && evidence\.status === 'SUBMITTED'/);
            expect(sheet).toMatch(/evidence-sheet-approve-btn/);
            expect(sheet).toMatch(/evidence-sheet-reject-btn/);
            expect(sheet).toMatch(/onReview\(evidence\.id, 'APPROVED'\)/);
            expect(sheet).toMatch(/onReview\(evidence\.id, 'REJECTED'\)/);
        });

        it('renders Re-submit on REJECTED', () => {
            expect(sheet).toMatch(/evidence\.status === 'REJECTED'/);
            expect(sheet).toMatch(/evidence-sheet-resubmit-btn/);
        });

        it('renders Re-certify on NEEDS_REVIEW', () => {
            // The Audit S3 follow-up landed `EvidenceStatus.NEEDS_REVIEW`.
            // The sheet now exposes the re-certification action on
            // that state.
            expect(sheet).toMatch(/evidence\.status === 'NEEDS_REVIEW'/);
            expect(sheet).toMatch(/evidence-sheet-recertify-btn/);
        });
    });
});
