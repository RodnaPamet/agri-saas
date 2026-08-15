/**
 * Swallowing a unique violation does NOT un-abort the transaction.
 *
 * The bug this file exists for could not be seen by a unit test, and that is
 * the whole point of it living here.
 *
 * `uploadEvidenceFile` once wrapped a link insert in `try { … } catch { }`
 * with the comment "duplicate link is acceptable". Under a mocked Prisma
 * client that reads correctly: the create rejects, the catch swallows,
 * execution continues. Under a real interactive transaction it is the
 * opposite of correct — a unique violation (23505) aborts the transaction
 * *at the database*, and every statement after it fails with 25P02 "current
 * transaction is aborted, commands ignored until end of transaction block".
 * Catching the JavaScript exception does not un-abort anything. So the audit
 * write immediately after the catch failed, and the upload that the catch
 * existed to permit was precisely the one that broke.
 *
 * GRC teardown phase 2 deleted the surface this was first written against
 * (`PracticeEvidenceLink`), which would have deleted the proof along with
 * it. The proof was RE-BASED rather than dropped, because the conclusion it
 * establishes is not about practices at all — it is about Postgres, and
 * roughly a dozen live call sites now depend on it:
 * `createMany({ skipDuplicates: true })` is the idiom in
 * `notifications/{assignment,agro,task-due}.ts`,
 * `automation/action-executor.ts`, `usecases/org-tenants.ts` and five
 * background jobs, several of whose docblocks cite this exact reasoning.
 * If any of those is ever "simplified" back to a `create` in a `try/catch`,
 * this file is what says why that is wrong.
 *
 * `Notification.dedupeKey` is the re-base target because it is the very
 * unique index those call sites rely on — a `{tenantId}:{type}:{entityId}:
 * {userId}:{YYYY-MM-DD}` idempotency key written by jobs that can re-run.
 *
 * Two tests, deliberately a pair:
 *
 *   1. The swallowed 23505 poisons the transaction — the premise of the fix.
 *      If that ever stops failing, the premise is gone and this file should
 *      be re-read rather than deleted.
 *   2. ON CONFLICT DO NOTHING (`skipDuplicates`) leaves it usable — the fix.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `dup-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';

/** The shape jobs actually write — see `notifications/task-due.ts`. */
function notif(dedupeKey: string) {
    return {
        tenantId: TENANT_ID,
        userId: USER_ID,
        title: 'Duplicate-safe notification',
        message: 'written twice on purpose',
        dedupeKey,
    };
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
});

afterAll(async () => {
    if (!DB_AVAILABLE) {
        await prisma.$disconnect();
        return;
    }
    const scope = { tenantId: TENANT_ID };
    try { await prisma.notification.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.tenantMembership.deleteMany({ where: scope }); } catch { /* best effort */ }
    try { await prisma.user.deleteMany({ where: { id: USER_ID } }); } catch { /* best effort */ }
    try { await prisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
    await prisma.$disconnect();
});

describeFn('a swallowed unique violation (integration)', () => {
    it('still poisons the transaction — the premise of the fix', async () => {
        // Establish the row that will be duplicated.
        const key = `${TAG}:premise`;
        await prisma.notification.create({ data: notif(key) });

        await expect(
            prisma.$transaction(async (tx) => {
                try {
                    await tx.notification.create({ data: notif(key) });
                } catch {
                    // The old code's comment: "duplicate is acceptable".
                    // The exception is caught here; the transaction is not.
                }
                // Any statement at all. In the real usecase this was logEvent.
                await tx.notification.findFirst({ where: { dedupeKey: key } });
            }),
        ).rejects.toThrow(/current transaction is aborted|25P02/i);
    });

    it('ON CONFLICT DO NOTHING leaves the transaction usable', async () => {
        const key = `${TAG}:fixed`;
        await prisma.notification.create({ data: notif(key) });

        const after = await prisma.$transaction(async (tx) => {
            await tx.notification.createMany({ data: [notif(key)], skipDuplicates: true });
            // The statement that used to die with 25P02.
            return tx.notification.findFirst({ where: { dedupeKey: key } });
        });

        expect(after?.dedupeKey).toBe(key);
        // Still exactly one row — skipDuplicates skipped, it did not insert.
        const rows = await prisma.notification.count({ where: { tenantId: TENANT_ID, dedupeKey: key } });
        expect(rows).toBe(1);
    });
});
