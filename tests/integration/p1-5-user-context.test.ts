/**
 * P1.5 — `runInUserContext` executes as a PERSON: `app_user` + `app.user_id`,
 * and no tenant.
 *
 * P1.4 gave the null-tenant tables a two-armed policy:
 *
 *     USING (
 *         "tenantId" = current_setting('app.tenant_id', true)::text
 *         OR ("tenantId" IS NULL AND "userId" = current_setting('app.user_id', true)::text)
 *     )
 *
 * and proved it with a hand-rolled `asUser` helper that set `app.user_id`
 * inside `withTenantDb`. That helper was a stand-in for this function. These
 * tests drive the REAL `runInUserContext`, because a policy proven against a
 * test helper is a policy proven against a test helper.
 *
 * ── the two properties, and why each needs its own assertion ──
 *
 * 1. `app.user_id` IS set, so a person reads their own rows. Asserted as a
 *    NON-ZERO count. "A sees no more than their own" would pass on an empty
 *    result and prove nothing — an empty selection is a pass, and the plan's
 *    hardening item is specifically that REMOVING `app.user_id` must turn CI
 *    red, which only a positive count can do.
 *
 * 2. `app.tenant_id` is NOT set. This is the load-bearing absence: with it
 *    unset, `current_setting(..., true)` yields NULL, the first arm evaluates
 *    to NULL rather than true, and the row is judged solely by ownership.
 *    Setting a tenant would re-open that arm and let a person-scoped query read
 *    a farm's rows. Asserted directly against `current_setting`, not inferred
 *    from the row counts — a query that returns the right rows for the wrong
 *    reason looks identical.
 *
 * ── the shape of the negatives ──
 *
 * Same rule as P1.4: under RLS a write is refused with 42501 only when the row
 * is VISIBLE; when SELECT hides it the write affects zero rows and returns
 * normally. So every negative asserts a row COUNT or a raised code, never that
 * a call returned.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { runInUserContext } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import type { UserContext } from '@/app-layer/types';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

let USER_A = '';
let USER_B = '';
const SESSION_ROW_A = `sr-a-${randomUUID()}`;
const SESSION_ROW_B = `sr-b-${randomUUID()}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

const in1h = () => new Date(Date.now() + 3_600_000);

/**
 * `User` needs `updatedAt` spelled out: `@updatedAt` is applied by the Prisma
 * CLIENT, not as a database default, so a raw INSERT that omits it fails 23502.
 * And no `name` — the schema field is `@map`'d to `nameEncrypted`, so naming
 * `name` fails 42703 on a column that does not exist. Both are the same two
 * traps P1.4's fixture records.
 */
async function createUser(tag: string): Promise<string> {
    const id = `u-p15-${tag}-${randomUUID()}`;
    const email = `p15-${tag}-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id,
        encryptField(email),
        hashForLookup(email),
    );
    return id;
}

describeFn('P1.5 — runInUserContext is a person, not a tenant', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        USER_A = await createUser('a');
        USER_B = await createUser('b');
        // Seeded as the owner role so `superuser_bypass` applies — the
        // production path for every writer of these tables.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "UserSession"("id","sessionId","userId","tenantId","expiresAt")
             VALUES ($1,$2,$3,NULL,$4), ($5,$6,$7,NULL,$8)`,
            SESSION_ROW_A, `sess-a-${randomUUID()}`, USER_A, in1h(),
            SESSION_ROW_B, `sess-b-${randomUUID()}`, USER_B, in1h(),
        );
    });

    afterAll(async () => {
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "UserSession" WHERE "userId" IN ($1,$2)`, USER_A, USER_B,
        );
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "User" WHERE "id" IN ($1,$2)`, USER_A, USER_B,
        );
        await globalPrisma.$disconnect();
    });

    it('enters app_user — without which every policy here is inert', async () => {
        // The precondition for all of it. `superuser_bypass` makes the policies
        // invisible to the owner role, so a suite that forgot the role change
        // would pass every assertion below for the wrong reason.
        const who = await runInUserContext(ctxFor(USER_A), (tx) =>
            tx.$queryRawUnsafe<Array<{ u: string }>>(`SELECT current_user AS u`),
        );
        expect(who[0].u).toBe('app_user');
    });

    it('binds app.user_id and leaves app.tenant_id UNSET', async () => {
        const settings = await runInUserContext(ctxFor(USER_A), (tx) =>
            tx.$queryRawUnsafe<Array<{ uid: string | null; tid: string | null }>>(
                `SELECT current_setting('app.user_id', true) AS uid,
                        current_setting('app.tenant_id', true) AS tid`,
            ),
        );
        expect(settings[0].uid).toBe(USER_A);
        // The load-bearing absence. An empty string would also be falsy, so the
        // assertion names what it must be rather than that it is not truthy.
        expect(settings[0].tid).toBeNull();
    });

    it('a person READS their own null-tenant rows (non-zero, not "no more than")', async () => {
        const rows = await runInUserContext(ctxFor(USER_A), (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "UserSession" WHERE "userId" = $1`, USER_A,
            ),
        );
        // The assertion the plan's mutation item turns on: drop `app.user_id`
        // from runInUserContext and this becomes 0.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map((r) => r.id)).toContain(SESSION_ROW_A);
    });

    it("a person reads ZERO of another person's null-tenant rows", async () => {
        const rows = await runInUserContext(ctxFor(USER_A), (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "UserSession" WHERE "userId" = $1`, USER_B,
            ),
        );
        expect(rows).toHaveLength(0);
    });

    it('B reads B — so the zero above is isolation, not a broken fixture', async () => {
        // The positive control for the previous case. Without it, a fixture that
        // never inserted B's row would produce the same empty result and read as
        // isolation working.
        const rows = await runInUserContext(ctxFor(USER_B), (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "UserSession" WHERE "userId" = $1`, USER_B,
            ),
        );
        expect(rows.map((r) => r.id)).toContain(SESSION_ROW_B);
    });

    it("cannot UPDATE another person's row — asserted as a row COUNT", async () => {
        // RLS hides B's row from A's SELECT, so this UPDATE neither throws nor
        // changes anything. The refusal is only observable as the count.
        const affected = await runInUserContext(ctxFor(USER_A), (tx) =>
            tx.$executeRawUnsafe(
                `UPDATE "UserSession" SET "expiresAt" = now() WHERE id = $1`, SESSION_ROW_B,
            ),
        );
        expect(affected).toBe(0);

        // And B's row is untouched, read back OUTSIDE the person context so the
        // check is not subject to the same policy that hid it.
        const after = await globalPrisma.$queryRawUnsafe<Array<{ e: Date }>>(
            `SELECT "expiresAt" AS e FROM "UserSession" WHERE id = $1`, SESSION_ROW_B,
        );
        expect(after[0].e.getTime()).toBeGreaterThan(Date.now() + 1_000);
    });

    it('the transaction leaves nothing bound behind it', async () => {
        // `SET LOCAL` is transaction-scoped; this pins that so a later change to
        // plain `SET` cannot leak a user id into a pooled connection, where the
        // next request on it would be judged as the previous caller.
        await runInUserContext(ctxFor(USER_A), async () => undefined);
        const leaked = await globalPrisma.$queryRawUnsafe<Array<{ uid: string | null }>>(
            `SELECT current_setting('app.user_id', true) AS uid`,
        );
        expect(leaked[0].uid === null || leaked[0].uid === '').toBe(true);
    });
});
