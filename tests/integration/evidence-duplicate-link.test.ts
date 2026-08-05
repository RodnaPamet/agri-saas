/**
 * Duplicate control↔evidence links, against a real Postgres transaction.
 *
 * The bug this file exists for could not be seen by a unit test, and that is
 * the whole point of it living here.
 *
 * `uploadEvidenceFile` wrapped its `ControlEvidenceLink` insert in
 * `try { … } catch { }` with the comment "duplicate link is acceptable". Under
 * a mocked Prisma client that reads correctly: the create rejects, the catch
 * swallows, execution continues. Under a real interactive transaction it is
 * the opposite of correct — a unique violation (23505) aborts the transaction
 * *at the database*, and every statement after it fails with 25P02
 * "current transaction is aborted, commands ignored until end of transaction
 * block". Catching the JavaScript exception does not un-abort anything. So the
 * audit write immediately after the catch failed, and the upload that the
 * catch existed to permit was precisely the one that broke.
 *
 * Two tests below, and they are deliberately a pair:
 *
 *   1. The MECHANISM test proves the claim about Postgres directly — swallowed
 *      23505 then one more statement, expecting 25P02. If that ever stops
 *      failing, the premise of the fix is gone and this file should be re-read
 *      rather than deleted.
 *   2. The BEHAVIOUR test drives the real usecase twice, which is the
 *      acceptance criterion: uploading a duplicate file to a control succeeds.
 */
// STORAGE_PROVIDER defaults to "s3" in env.ts; uploadEvidenceFile needs the
// local provider in tests. Set before the storage module's lazy singleton is
// constructed.
process.env.STORAGE_PROVIDER = 'local';
process.env.FILE_STORAGE_ROOT =
    process.env.FILE_STORAGE_ROOT || '/tmp/test-evidence-uploads';

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `dup-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';
let CONTROL_ID = '';

function txtFile(body: string, name = 'duplicate.txt') {
    return new File([body], name, { type: 'text/plain' });
}

function adminCtx() {
    return makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId: USER_ID, tenantSlug: TAG });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.tenant.create({ data: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
    const email = `${TAG}@example.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    USER_ID = user.id;
    await prisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    const control = await prisma.control.create({
        data: { tenantId: TENANT_ID, name: 'Control receiving duplicate evidence' },
    });
    CONTROL_ID = control.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) {
        await prisma.$disconnect();
        return;
    }
    const scope = { tenantId: TENANT_ID };
    try { await prisma.auditLog.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.controlEvidenceLink.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.evidence.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.fileRecord.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.control.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.tenantMembership.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.user.deleteMany({ where: { id: USER_ID } }); } catch { /* best effort */ }
    try { await prisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
    await prisma.$disconnect();
});

describeFn('duplicate control↔evidence link (integration)', () => {
    it('a swallowed 23505 still poisons the transaction — the premise of the fix', async () => {
        // Establish the row that will be duplicated.
        const url = `https://example.test/${TAG}/premise`;
        await prisma.controlEvidenceLink.create({
            data: { tenantId: TENANT_ID, controlId: CONTROL_ID, kind: 'LINK', url },
        });

        await expect(
            prisma.$transaction(async (tx) => {
                try {
                    await tx.controlEvidenceLink.create({
                        data: { tenantId: TENANT_ID, controlId: CONTROL_ID, kind: 'LINK', url },
                    });
                } catch {
                    // The old code's comment: "duplicate link is acceptable".
                    // The exception is caught here; the transaction is not.
                }
                // Any statement at all. In the real usecase this was logEvent.
                await tx.control.findFirst({ where: { id: CONTROL_ID } });
            }),
        ).rejects.toThrow(/current transaction is aborted|25P02/i);
    });

    it('ON CONFLICT DO NOTHING leaves the transaction usable', async () => {
        const url = `https://example.test/${TAG}/fixed`;
        await prisma.controlEvidenceLink.create({
            data: { tenantId: TENANT_ID, controlId: CONTROL_ID, kind: 'LINK', url },
        });

        const after = await prisma.$transaction(async (tx) => {
            await tx.controlEvidenceLink.createMany({
                data: [{ tenantId: TENANT_ID, controlId: CONTROL_ID, kind: 'LINK', url }],
                skipDuplicates: true,
            });
            // The statement that used to die with 25P02.
            return tx.control.findFirst({ where: { id: CONTROL_ID } });
        });

        expect(after?.id).toBe(CONTROL_ID);
        // Still exactly one link — skipDuplicates skipped, it did not insert.
        const links = await prisma.controlEvidenceLink.count({
            where: { tenantId: TENANT_ID, controlId: CONTROL_ID, url },
        });
        expect(links).toBe(1);
    });

    it('uploading the SAME file to the SAME control twice succeeds', async () => {
        // The acceptance criterion. Identical bytes also take the SHA-256
        // dedup path, so the second upload reuses the FileRecord and hits the
        // (controlId, kind, fileId) unique constraint — the exact collision.
        const first = await uploadEvidenceFile(adminCtx(), txtFile('same bytes every time'), {
            title: 'First upload',
            controlId: CONTROL_ID,
        });

        const second = await uploadEvidenceFile(adminCtx(), txtFile('same bytes every time'), {
            title: 'Second upload',
            controlId: CONTROL_ID,
        });

        expect(second.id).not.toBe(first.id);
        expect(second.fileRecordId).toBe(first.fileRecordId);

        // One link, not two — and crucially the second upload's audit row
        // exists, which is what 25P02 used to prevent.
        const links = await prisma.controlEvidenceLink.count({
            where: { tenantId: TENANT_ID, controlId: CONTROL_ID, fileId: first.fileRecordId },
        });
        expect(links).toBe(1);

        const audits = await prisma.auditLog.count({
            where: { tenantId: TENANT_ID, entityId: second.id },
        });
        expect(audits).toBeGreaterThan(0);
    });

    it('a duplicate LINK evidence row on the same control also survives', async () => {
        // createEvidence carries the same bridge; the LINK unique is
        // (controlId, kind, url).
        const { createEvidence } = await import('@/app-layer/usecases/evidence');
        const content = `https://example.test/${TAG}/link-evidence`;
        const a = await createEvidence(adminCtx(), {
            title: 'Link evidence',
            type: 'LINK',
            content,
            controlId: CONTROL_ID,
        } as never);
        const b = await createEvidence(adminCtx(), {
            title: 'Link evidence again',
            type: 'LINK',
            content,
            controlId: CONTROL_ID,
        } as never);

        expect(a.id).not.toBe(b.id);
        const links = await prisma.controlEvidenceLink.count({
            where: { tenantId: TENANT_ID, controlId: CONTROL_ID, kind: 'LINK', url: content },
        });
        expect(links).toBe(1);
    });
});
