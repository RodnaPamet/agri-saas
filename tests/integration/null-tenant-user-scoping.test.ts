/**
 * P1.4 — a NULL-tenant row belongs to ONE user, and the org rules are READ-ONLY.
 *
 * ── what was wrong ──
 *
 * `UserSession`, `NativeRefreshToken` and `NativeAuthCode` all carried the
 * Epic D.1 asymmetric policy with an UNCONDITIONAL null arm:
 *
 *     USING ("tenantId" IS NULL OR "tenantId" = app.tenant_id)
 *
 * so under `app_user` any session could read EVERY null-tenant row of all
 * three — session metadata, refresh tokens, in-flight native auth codes, for
 * every user on the deployment. Separately, both org policies were `FOR ALL`
 * with no `WITH CHECK`, and Postgres uses USING as the check when WITH CHECK is
 * absent — so `OrgMembership`'s `USING ("userId" = app.user_id)` let an
 * `app_user` session INSERT a membership for ITSELF. A self-grant of the thing
 * org membership exists to gate.
 *
 * ── and why it was not a live leak ──
 *
 * Measured 2026-10-02: nothing reads those tables under `app_user`. Every
 * access uses the global Prisma client or an explicit `asSystem(...)`, neither
 * of which issues `SET LOCAL ROLE app_user`, so `superuser_bypass` fires and
 * the policies are inert in production. These tests reach the policies by
 * entering `app_user` deliberately — which is what P1.5 will do for real, and
 * why the fix lands before it.
 * `tests/guards/null-tenant-tables-not-read-as-app-user.test.ts` keeps that
 * measurement from going stale.
 *
 * ── the shape of every assertion here ──
 *
 * A write refused by RLS raises 42501 ONLY when the row is visible. When SELECT
 * hides it the write affects zero rows and returns normally, so "it threw" and
 * "it did nothing" are different outcomes and only one of them is a refusal.
 * Every negative below therefore asserts either the raised error or the ROW
 * COUNT — never merely that the call returned.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { encryptField, hashForLookup } from '@/lib/security/encryption';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TENANT = `t-p14-${randomUUID()}`;
const ORG = `o-p14-${randomUUID()}`;

/**
 * Assigned in `beforeAll`, not generated as constants.
 *
 * `UserSession.userId`, `NativeRefreshToken.userId`, `NativeAuthCode.userId`
 * and `OrgMembership.userId` all carry a foreign key to `User.id`, so a made-up
 * id fails at 23503 before any policy is reached — which is how this file first
 * ran. The rows have to hang off real users.
 */
let USER_A = '';
let USER_B = '';

/**
 * `sessionId` is the opaque JWT-side identifier; `id` is the row's primary key.
 *
 * Both exist and they are NOT interchangeable: `NativeRefreshToken.userSessionId`
 * and `NativeAuthCode.userSessionId` foreign-key to `UserSession.id`. Passing
 * the `sessionId` value there fails 23503 — which it did, and the error names
 * the constraint rather than the mix-up.
 */
const SESSION_A = `sid-p14-a-${randomUUID()}`;
const SESSION_B = `sid-p14-b-${randomUUID()}`;
const SESSION_ROW_A = `us-p14-a-${randomUUID()}`;
const SESSION_ROW_B = `us-p14-b-${randomUUID()}`;
const in1h = (): Date => new Date(Date.now() + 3_600_000);

/**
 * Create a user with raw SQL, encrypting and hashing the address ourselves.
 *
 * `globalPrisma` is a BARE `PrismaClient` — the raw adapter, deliberately,
 * because these tests need to read past RLS as the owner role. It therefore
 * carries no `pii-middleware`, so `user.create({ data: { email } })` writes
 * neither `emailEncrypted` nor `emailHash` and dies on a NOT NULL constraint.
 * That is what it did on the first run: "Null constraint violation on the (not
 * available)", which names no column and reads like a schema problem.
 */
async function createUser(label: string): Promise<string> {
    const id = `u-p14-${label}-${randomUUID()}`;
    const email = `p14-${label}-${randomUUID()}@scoping.test`;
    // No `name`: the schema field is `@map`'d to `nameEncrypted`, so a raw
    // INSERT naming `name` fails 42703 on a column that does not exist. It is
    // nullable, so the row does not need one.
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id,
        encryptField(email),
        hashForLookup(email),
    );
    return id;
}

/**
 * Run inside `app_user` with BOTH settings bound.
 *
 * `withTenantDb` sets `app.tenant_id` only; `app.user_id` is what P1.5's
 * `runInUserContext` will own. Setting it with `set_config(..., true)` here is
 * transaction-local and is the smallest thing that exercises the policy without
 * pulling P1.5 forward.
 */
async function asUser<T>(userId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return withTenantDb(TENANT, async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, userId);
        return fn(tx as unknown as PrismaClient);
    });
}

describeFn('P1.4 — null-tenant rows are user-scoped', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();

        USER_A = await createUser('a');
        USER_B = await createUser('b');

        // Seeded as the owner role, so `superuser_bypass` applies — which is
        // also the production path: every writer of these tables is bypassed.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "UserSession"("id","sessionId","userId","tenantId","expiresAt")
             VALUES ($1,$2,$3,NULL,$4), ($5,$6,$7,NULL,$8)`,
            SESSION_ROW_A, SESSION_A, USER_A, in1h(),
            SESSION_ROW_B, SESSION_B, USER_B, in1h(),
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "NativeRefreshToken"("id","tokenHash","userSessionId","userId","familyId","tenantId","expiresAt")
             VALUES ($1,$2,$3,$4,$5,NULL,$6), ($7,$8,$9,$10,$11,NULL,$12)`,
            `rt-a-${randomUUID()}`, `hash-a-${randomUUID()}`, SESSION_ROW_A, USER_A, `fam-a-${randomUUID()}`, in1h(),
            `rt-b-${randomUUID()}`, `hash-b-${randomUUID()}`, SESSION_ROW_B, USER_B, `fam-b-${randomUUID()}`, in1h(),
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "NativeAuthCode"("id","codeHash","userSessionId","userId","codeChallenge","redirectUri","tenantId","expiresAt")
             VALUES ($1,$2,$3,$4,$5,$6,NULL,$7), ($8,$9,$10,$11,$12,$13,NULL,$14)`,
            `ac-a-${randomUUID()}`, `chash-a-${randomUUID()}`, SESSION_ROW_A, USER_A, 'challenge-a', 'bg.agrent.app://cb', in1h(),
            `ac-b-${randomUUID()}`, `chash-b-${randomUUID()}`, SESSION_ROW_B, USER_B, 'challenge-b', 'bg.agrent.app://cb', in1h(),
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "Organization"("id","name","slug","updatedAt") VALUES ($1,$2,$3,NOW())`,
            ORG, 'P1.4 Org', `p14-${randomUUID()}`.slice(0, 40),
        );
    });

    afterAll(async () => {
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "NativeAuthCode" WHERE "userId" IN ($1,$2)`, USER_A, USER_B);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "NativeRefreshToken" WHERE "userId" IN ($1,$2)`, USER_A, USER_B);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "userId" IN ($1,$2)`, USER_A, USER_B);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "UserSession" WHERE "userId" IN ($1,$2)`, USER_A, USER_B);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" = $1`, ORG);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN ($1,$2)`, USER_A, USER_B);
        await globalPrisma.$disconnect();
    });

    it.each([
        ['UserSession', 'UserSession'],
        ['NativeRefreshToken', 'NativeRefreshToken'],
        ['NativeAuthCode', 'NativeAuthCode'],
    ])('%s: user A sees own null-tenant row and ZERO of user B\'s', async (_label, table) => {
        const rows = await asUser(USER_A, async (tx) =>
            tx.$queryRawUnsafe<Array<{ userId: string }>>(
                `SELECT "userId" FROM "${table}" WHERE "userId" IN ($1,$2)`,
                USER_A,
                USER_B,
            ),
        );
        const owners = rows.map((r) => r.userId);
        expect(owners).toEqual([USER_A]);
        // Stated separately so a failure says WHICH half broke: a regression
        // that hides everything and one that shows everything are opposite
        // bugs, and `toEqual` alone does not distinguish them in the message.
        expect(owners).toContain(USER_A);
        expect(owners).not.toContain(USER_B);
    });

    it.each(['UserSession', 'NativeRefreshToken', 'NativeAuthCode'])(
        '%s: with app.user_id UNSET the rows are hidden, not exposed',
        async (table) => {
            // The fail-closed direction. A future path that enters `app_user`
            // without setting the user sees nothing rather than everyone's.
            const rows = await withTenantDb(TENANT, async (tx) =>
                tx.$queryRawUnsafe<Array<{ userId: string }>>(
                    `SELECT "userId" FROM "${table}" WHERE "userId" IN ($1,$2)`,
                    USER_A,
                    USER_B,
                ),
            );
            expect(rows).toEqual([]);
        },
    );

    it('user B cannot DELETE user A\'s session — and the no-op is asserted by COUNT', async () => {
        const affected = await asUser(USER_B, async (tx) =>
            tx.$executeRawUnsafe(`DELETE FROM "UserSession" WHERE "sessionId" = $1`, SESSION_A),
        );
        // RLS makes this silent: the row is invisible to B, so the DELETE
        // removes nothing and raises nothing. Asserting the call "succeeded"
        // would have passed before this migration too.
        expect(affected).toBe(0);

        const still = await globalPrisma.userSession.findFirst({
            where: { sessionId: SESSION_A },
            select: { userId: true },
        });
        expect(still?.userId).toBe(USER_A);
    });

    it('the superuser bypass still reads every row — the production path', async () => {
        const count = await globalPrisma.userSession.count({
            where: { userId: { in: [USER_A, USER_B] } },
        });
        expect(count).toBe(2);
    });
});

describeFn('P1.4 — the org rules are READ-ONLY under app_user', () => {
    // Its OWN fixtures. The block above tears its users down in `afterAll`, and
    // jest runs the two blocks in order, so sharing them would leave this one
    // asserting against deleted rows — a failure that looks like an RLS result.
    let ORG_USER_A = '';
    let ORG_USER_B = '';
    const ORG_ID = `o-p14-ro-${randomUUID()}`;

    beforeAll(async () => {
        await globalPrisma.$connect();
        ORG_USER_A = await createUser('ro-a');
        ORG_USER_B = await createUser('ro-b');
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "Organization"("id","name","slug","updatedAt") VALUES ($1,$2,$3,NOW())`,
            ORG_ID,
            'P1.4 Org',
            `p14ro-${randomUUID()}`.slice(0, 40),
        );
    });
    afterAll(async () => {
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "userId" IN ($1,$2)`, ORG_USER_A, ORG_USER_B);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" = $1`, ORG_ID);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN ($1,$2)`, ORG_USER_A, ORG_USER_B);
        await globalPrisma.$disconnect();
    });

    it('an app_user self-INSERT into OrgMembership is refused (42501)', async () => {
        // The plan's stated test. Before this migration the policy was FOR ALL
        // with no WITH CHECK, so USING doubled as the check and a session could
        // grant ITSELF org membership.
        await expect(
            asUser(ORG_USER_A, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "OrgMembership"("id","organizationId","userId") VALUES ($1,$2,$3)`,
                    `om-forged-${randomUUID()}`,
                    ORG_ID,
                    ORG_USER_A,
                ),
            ),
        ).rejects.toThrow(/row-level security|violates row-level/i);

        const count = await globalPrisma.orgMembership.count({ where: { userId: ORG_USER_A } });
        expect(count).toBe(0);
    });

    it('an app_user UPDATE of Organization is refused', async () => {
        // Seed a membership as the owner role so the row IS visible to A —
        // otherwise the UPDATE would be a silent no-op and this assertion would
        // pass for the wrong reason.
        const omId = `om-read-${randomUUID()}`;
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "OrgMembership"("id","organizationId","userId") VALUES ($1,$2,$3)`,
            omId,
            ORG_ID,
            ORG_USER_A,
        );
        try {
            const visible = await asUser(ORG_USER_A, async (tx) =>
                tx.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT "id" FROM "Organization" WHERE "id" = $1`,
                    ORG_ID,
                ),
            );
            // The READ still works — this is a read-only rule, not a lockout.
            expect(visible.map((r) => r.id)).toEqual([ORG_ID]);

            // ASSERTED BY COUNT, not by a thrown error — and the asymmetry with
            // the INSERT above is the thing to understand here.
            //
            // `FOR SELECT` leaves no policy applicable to UPDATE, so under
            // `app_user` the row is not visible FOR UPDATE: Postgres updates
            // zero rows and raises nothing. An INSERT has no row to hide, so it
            // has nothing to satisfy and raises 42501 outright. Same refusal,
            // two different observable shapes — and `rejects.toThrow` is only
            // correct for one of them. This assertion was written the wrong way
            // round first, and it failed, which is the only reason the
            // distinction got written down.
            const affected = await asUser(ORG_USER_A, async (tx) =>
                tx.$executeRawUnsafe(`UPDATE "Organization" SET "name" = $1 WHERE "id" = $2`, 'Renamed', ORG_ID),
            );
            expect(affected).toBe(0);

            const row = await globalPrisma.organization.findUnique({
                where: { id: ORG_ID },
                select: { name: true },
            });
            expect(row?.name).toBe('P1.4 Org');
        } finally {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "id" = $1`, omId);
        }
    });

    it('a member can still SELECT their own membership row', async () => {
        const omId = `om-self-${randomUUID()}`;
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "OrgMembership"("id","organizationId","userId") VALUES ($1,$2,$3)`,
            omId,
            ORG_ID,
            ORG_USER_A,
        );
        try {
            const mine = await asUser(ORG_USER_A, async (tx) =>
                tx.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT "id" FROM "OrgMembership" WHERE "organizationId" = $1`,
                    ORG_ID,
                ),
            );
            expect(mine.map((r) => r.id)).toEqual([omId]);

            // And user B sees none of it.
            const theirs = await asUser(ORG_USER_B, async (tx) =>
                tx.$queryRawUnsafe<Array<{ id: string }>>(
                    `SELECT "id" FROM "OrgMembership" WHERE "organizationId" = $1`,
                    ORG_ID,
                ),
            );
            expect(theirs).toEqual([]);
        } finally {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "id" = $1`, omId);
        }
    });
});

describeFn('the tests above can TELL THE TWO POLICIES APART', () => {
    /**
     * The discriminating control, and it exists because the obvious mutation
     * proofs for a migration do not work.
     *
     * I tried two and both stayed green:
     *
     *   · reverting the policy with `psql` against the base database — jest's
     *     `globalSetup` re-runs `prisma migrate deploy` and re-clones per
     *     worker on every run, so the revert was undone before any test saw it;
     *   · editing the migration FILE — `_prisma_migrations` already records
     *     `20261002080000_p1_4_…` as applied, so `migrate deploy` skips it and
     *     the file has no further influence on a migrated database.
     *
     * Both failures look identical to "the tests are fine", which is the whole
     * problem: a mutation that cannot reach the subject proves nothing, and
     * reads as proof. Measured instead — `current_user` is `app_user` inside
     * `withTenantDb`, the live `tenant_isolation` qual is the P1.4 form, and
     * both migrations are recorded.
     *
     * So the control swaps the policy to the Epic D.1 form IN PLACE, runs the
     * same query the tests above run, and asserts the answer CHANGES. The
     * worker database is disposable (dropped after the run) and the swap is
     * restored in a `finally`, but the honest caveat is that this is not
     * transactional: a hard crash mid-test leaves that one worker clone on the
     * old policy.
     */
    let CTRL_USER_A = '';
    let CTRL_USER_B = '';
    const CTRL_SESSION_A = `us-ctrl-a-${randomUUID()}`;
    const CTRL_SESSION_B = `us-ctrl-b-${randomUUID()}`;

    const P1_4_POLICY = `
        CREATE POLICY tenant_isolation ON "UserSession"
            USING (
                "tenantId" = current_setting('app.tenant_id', true)::text
                OR ("tenantId" IS NULL AND "userId" = current_setting('app.user_id', true)::text)
            )
            WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text)`;

    const D1_POLICY = `
        CREATE POLICY tenant_isolation ON "UserSession"
            USING (
                "tenantId" IS NULL
                OR "tenantId" = current_setting('app.tenant_id', true)::text
            )
            WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text)`;

    async function setPolicy(sql: string): Promise<void> {
        await globalPrisma.$executeRawUnsafe(`DROP POLICY IF EXISTS tenant_isolation ON "UserSession"`);
        await globalPrisma.$executeRawUnsafe(sql);
    }

    beforeAll(async () => {
        await globalPrisma.$connect();
        CTRL_USER_A = await createUser('ctrl-a');
        CTRL_USER_B = await createUser('ctrl-b');
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "UserSession"("id","sessionId","userId","tenantId","expiresAt")
             VALUES ($1,$2,$3,NULL,$4), ($5,$6,$7,NULL,$8)`,
            CTRL_SESSION_A, `sid-ctrl-a-${randomUUID()}`, CTRL_USER_A, in1h(),
            CTRL_SESSION_B, `sid-ctrl-b-${randomUUID()}`, CTRL_USER_B, in1h(),
        );
    });

    afterAll(async () => {
        // Restore first, unconditionally — a later suite in this worker shares
        // the database and must not inherit the D.1 policy.
        await setPolicy(P1_4_POLICY);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "UserSession" WHERE "id" IN ($1,$2)`, CTRL_SESSION_A, CTRL_SESSION_B);
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "User" WHERE "id" IN ($1,$2)`, CTRL_USER_A, CTRL_USER_B);
        await globalPrisma.$disconnect();
    });

    /** The query every assertion above makes, as user A. */
    async function visibleOwners(): Promise<string[]> {
        const rows = await asUser(CTRL_USER_A, async (tx) =>
            tx.$queryRawUnsafe<Array<{ userId: string }>>(
                `SELECT "userId" FROM "UserSession" WHERE "userId" IN ($1,$2)`,
                CTRL_USER_A,
                CTRL_USER_B,
            ),
        );
        return rows.map((r) => r.userId).sort();
    }

    it('under P1.4 user A sees only themselves; under D.1 they see user B too', async () => {
        try {
            await setPolicy(P1_4_POLICY);
            expect(await visibleOwners()).toEqual([CTRL_USER_A]);

            // The defect, on demand, in the database the tests actually read.
            await setPolicy(D1_POLICY);
            expect(await visibleOwners()).toEqual([CTRL_USER_A, CTRL_USER_B].sort());
        } finally {
            await setPolicy(P1_4_POLICY);
        }
    });

    it('and the restore worked, so the suite leaves the DB as it found it', async () => {
        expect(await visibleOwners()).toEqual([CTRL_USER_A]);
    });
});

describe('the DB gate is visible when it skips', () => {
    it('says so rather than passing silently', () => {
        if (!DB_AVAILABLE) {
            console.warn(
                '[null-tenant-user-scoping] SKIPPED — no database. These are the only ' +
                    'assertions that execute the P1.4 policies; the migration SQL alone ' +
                    'proves nothing about behaviour. Set INTEGRATION_REQUIRE_DB=1 to make ' +
                    'absence a failure.',
            );
        }
        expect(typeof DB_AVAILABLE).toBe('boolean');
    });
});
