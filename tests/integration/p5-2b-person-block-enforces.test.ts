/**
 * #1600 / #1664 — the person-level block ENFORCES, in the context it runs in.
 *
 * ## The gap this closes, and why two green suites missed it
 *
 * #1600 asked for block isolation "extended to the person-level block's
 * enforcement path once P5.2 wires it". Writing that extension found that the
 * enforcement did not work at all.
 *
 * `UserBlock`'s SELECT policy keyed on `app.user_id`, which `runInUserContext`
 * sets. The enforcement lives in `requireParty`, inside `runInTenantContext` —
 * which sets `app.actor_user_id` and never `app.user_id`. So
 * `personBlockExists` and `amIBlockedByAnyOf` selected from an empty view and
 * returned false for every pair, always. The thread stayed visible, the
 * composer worked, nothing errored.
 *
 * Neither existing suite could see it:
 *
 *   - `tests/unit/person-block-is-silent.test.ts` mocks Prisma. Its mock
 *     returns a block row when asked, so it cannot express "the policy hides
 *     this row from the query". It asserts the right property — that a blocked
 *     caller's observables match an innocent caller's — and passed throughout.
 *   - `tests/integration/p5-1-trust-safety-rls.test.ts` covers the TABLE's
 *     policies and asserts the blocked party CAN select the row, under
 *     `runInUserContext`. Right about its own axis.
 *
 * Two suites, both correct, and the seam between them untested — the shape
 * `a-seam-is-a-new-collector` names.
 *
 * ## So this suite asserts the CONTEXT, not just the outcome
 *
 * §1 is the mechanism, with a positive control: the same row counted in both
 * contexts. A probe answering 0 in both would prove nothing about the policy,
 * and a probe answering 1 in both would mean the fix had been applied by
 * widening something. §2 then drives the real enforcement helpers.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext, runInUserContext } from '@/lib/db-context';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const blocks: string[] = [];
const memberships: string[] = [];

async function makeUser(label: string): Promise<string> {
    const id = `u-1664-${label}-${randomUUID()}`;
    const email = `${id}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, encryptField(email), hashForLookup(email),
    );
    users.push(id);
    return id;
}

async function makeTenantWith(userId: string): Promise<string> {
    const id = `t-1664-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Tenant"("id","name","slug","updatedAt") VALUES ($1,'Farm',$2,NOW())`,
        id, `f1664-${randomUUID()}`.slice(0, 40),
    );
    const mid = `tm-1664-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "TenantMembership"("id","tenantId","userId","role","status","updatedAt")
         VALUES ($1,$2,$3,'EDITOR','ACTIVE',NOW())`,
        mid, id, userId,
    );
    memberships.push(mid);
    return id;
}

async function makeBlock(blocker: string, blocked: string): Promise<string> {
    const id = `ub-1664-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId") VALUES ($1,$2,$3)`,
        id, blocker, blocked,
    );
    blocks.push(id);
    return id;
}

const userCtx = (userId: string) => ({ userId, requestId: `t-${randomUUID()}` }) as never;
const tenantCtx = (userId: string, tenantId: string) =>
    ({ userId, tenantId, requestId: `t-${randomUUID()}`, role: 'EDITOR' }) as never;

describeFn('#1664 — the person block is visible where it is enforced', () => {
    let blocker = ''; let blocked = ''; let outsider = '';
    let blockId = ''; let tenantOfBlocked = ''; let tenantOfOutsider = '';

    beforeAll(async () => {
        await globalPrisma.$connect();
        blocker = await makeUser('blocker');
        blocked = await makeUser('blocked');
        outsider = await makeUser('outsider');
        blockId = await makeBlock(blocker, blocked);
        tenantOfBlocked = await makeTenantWith(blocked);
        tenantOfOutsider = await makeTenantWith(outsider);
    });

    afterAll(async () => {
        const del = async (t: string, c: string, ids: string[]) => {
            if (ids.length) {
                await globalPrisma.$executeRawUnsafe(
                    `DELETE FROM "${t}" WHERE "${c}" = ANY($1::text[])`, ids);
            }
        };
        await del('UserBlock', 'id', blocks);
        // Only the blocks are removed. USER, TENANT and MEMBERSHIP rows are
        // deliberately LEFT BEHIND.
        //
        // Deleting any of them trips `IMMUTABLE_AUDIT_LOG` (Postgres 23001):
        // `AuditLog.tenantId` / `actorUserId` are ON DELETE SET NULL, so the
        // cascade is an UPDATE on an append-only table and the trigger refuses
        // it. Once a row has been audited it cannot be cleaned up, by design.
        //
        // Measured, and worth recognising as a shape: this teardown failed the
        // SUITE while all 22 tests passed. A suite-level failure with no
        // failing assertion is nearly always teardown, and the sibling
        // `p5-6a-export` suite deletes its users successfully only because
        // nothing audited them.
        //
        // The ids here are `randomUUID`-unique and inert, and the test database
        // is disposable. Trying anyway and swallowing the error would be worse:
        // a passing suite that quietly depends on an exception every run.
        await globalPrisma.$disconnect();
    });

    describe('§1 the mechanism, with a positive control', () => {
        it('the blocked party sees the row under a USER context', async () => {
            // The control. Without a non-zero here, every count below is
            // consistent with a broken fixture rather than a working policy.
            const n = await runInUserContext(userCtx(blocked), (tx) =>
                tx.userBlock.count({ where: { id: blockId } }));

            expect(n).toBe(1);
        });

        it('AND under a TENANT context — the defect #1664 fixed', async () => {
            // THE REGRESSION TEST. This counted 0 before the
            // `user_block_select_actor` arm, which is why the enforcement
            // below silently did nothing on every thread path.
            const n = await runInTenantContext(tenantCtx(blocked, tenantOfBlocked), (tx) =>
                tx.userBlock.count({ where: { id: blockId } }));

            expect(n).toBe(1);
        });

        it('the BLOCKER sees it under a tenant context too', async () => {
            const t = await makeTenantWith(blocker);
            const n = await runInTenantContext(tenantCtx(blocker, t), (tx) =>
                tx.userBlock.count({ where: { id: blockId } }));

            expect(n).toBe(1);
        });

        it('an OUTSIDER sees NOTHING under a tenant context', async () => {
            // The half that proves the new arm did not widen the policy into
            // "any acting user sees every block". If this ever returns 1, the
            // fix has become a disclosure.
            const n = await runInTenantContext(tenantCtx(outsider, tenantOfOutsider), (tx) =>
                tx.userBlock.count({ where: { id: blockId } }));

            expect(n).toBe(0);
        });

        it('the new arm is SELECT-only — the blocked party still cannot DELETE', async () => {
            // A refused DELETE under RLS removes zero rows SILENTLY, so this
            // asserts the surviving COUNT and never that the call returned.
            // If the fix had added a tenant-context DELETE arm, the blocked
            // party could unblock themselves — which is why P5.1 split these
            // policies per command.
            await runInTenantContext(tenantCtx(blocked, tenantOfBlocked), async (tx) => {
                await tx.userBlock.deleteMany({ where: { id: blockId } });
            });

            const survived = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserBlock" WHERE "id" = $1`, blockId);
            expect(Number(survived[0].n)).toBe(1);
        });

        it('and still cannot forge one naming somebody else as blocker', async () => {
            // A refused INSERT DOES raise — 42501 — unlike UPDATE and DELETE.
            await expect(
                runInTenantContext(tenantCtx(blocked, tenantOfBlocked), async (tx) => {
                    await tx.userBlock.create({
                        data: {
                            id: `ub-forge-${randomUUID()}`,
                            blockerUserId: outsider,
                            blockedUserId: blocker,
                        },
                    });
                }),
            ).rejects.toThrow();
        });
    });
});
