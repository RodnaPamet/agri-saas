/**
 * Epic D.1 — `UserSession` RLS behavioural tests.
 *
 * The static guardrail (`tests/guardrails/rls-coverage.test.ts`)
 * confirms the policies + FORCE flag exist on the table. These tests
 * exercise the actual semantics against a live Postgres so a future
 * migration that quietly weakens the rules (e.g. adds a permissive
 * sibling policy) breaks here even if the static surface still looks
 * correct.
 *
 * Coverage
 * --------
 *   1. INSERT under `app_user` with own tenantId   → succeeds.
 *   2. INSERT under `app_user` with a different tenantId → blocked.
 *   3. INSERT under `app_user` with NULL tenantId  → blocked
 *      (only the superuser-bypassed sign-in path may mint NULL).
 *   4. SELECT under `app_user` returns own-tenant rows and EXCLUDES other
 *      tenants'. NULL-tenant rows are NO LONGER unconditionally visible —
 *      P1.4 scoped that arm to the row's own user, and `withTenantDb` does
 *      not set `app.user_id`, so they are filtered here. The own-user half
 *      lives in `tests/integration/null-tenant-user-scoping.test.ts`.
 *   5. UPDATE under `app_user` cannot reassign a NULL row to a
 *      different tenant (the asymmetric-USING + strict-WITH-CHECK
 *      contract).
 *   6. UPDATE under `app_user` cannot reassign an own-tenant row to
 *      a different tenant.
 *   7. Superuser (default `postgres` role, no SET LOCAL ROLE) can
 *      read every row regardless of tenant — covers migrations,
 *      sign-in INSERT, admin reads from the global Prisma client.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────────

const TENANT_A = `t-rls-a-${randomUUID()}`;
const TENANT_B = `t-rls-b-${randomUUID()}`;
let USER_ID = `u-rls-${randomUUID()}`;

function makeSessionRow(overrides: {
    sessionId?: string;
    tenantId?: string | null;
    userId?: string;
} = {}) {
    return {
        sessionId: overrides.sessionId ?? `sid-${randomUUID()}`,
        userId: overrides.userId ?? USER_ID,
        tenantId: overrides.tenantId === undefined ? TENANT_A : overrides.tenantId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
}

async function seedSuperuser(rows: Array<ReturnType<typeof makeSessionRow>>) {
    // Default Prisma client = postgres role = superuser_bypass fires.
    for (const r of rows) {
        await globalPrisma.userSession.create({ data: r });
    }
}

async function cleanup() {
    await globalPrisma.userSession.deleteMany({
        where: { userId: USER_ID },
    });
}

// ─── Suite ─────────────────────────────────────────────────────────

describeFn('Epic D.1 — UserSession RLS', () => {
    beforeAll(async () => {
        // Ensure the user FK target exists. Reuse an existing seeded
        // user if one is already in the DB, otherwise create one.
        const existing = await globalPrisma.user.findFirst();
        if (existing) {
            USER_ID = existing.id;
        } else {
            const userEmail = `rls-${randomUUID()}@example.test`;
            await globalPrisma.user.create({
                data: {
                    id: USER_ID,
                    email: userEmail,
                    emailHash: hashForLookup(userEmail),
                },
            });
        }
    });

    afterEach(async () => {
        await cleanup();
    });

    afterAll(async () => {
        await cleanup();
        await globalPrisma.$disconnect();
    });

    it('app_user INSERT with own tenantId succeeds', async () => {
        const row = makeSessionRow({ tenantId: TENANT_A });
        await withTenantDb(TENANT_A, async (tx) => {
            await tx.$executeRawUnsafe(
                `INSERT INTO "UserSession"("id","sessionId","userId","tenantId","expiresAt")
                 VALUES ($1, $2, $3, $4, $5)`,
                `id-${randomUUID()}`,
                row.sessionId,
                row.userId,
                row.tenantId,
                row.expiresAt,
            );
        });
        const persisted = await globalPrisma.userSession.findUnique({
            where: { sessionId: row.sessionId },
        });
        expect(persisted?.tenantId).toBe(TENANT_A);
    });

    it('app_user INSERT with a different tenantId is blocked', async () => {
        const row = makeSessionRow({ tenantId: TENANT_B });
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "UserSession"("id","sessionId","userId","tenantId","expiresAt")
                     VALUES ($1, $2, $3, $4, $5)`,
                    `id-${randomUUID()}`,
                    row.sessionId,
                    row.userId,
                    row.tenantId,
                    row.expiresAt,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('app_user INSERT with NULL tenantId is blocked (only sign-in path may mint NULL)', async () => {
        const row = makeSessionRow({ tenantId: null });
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "UserSession"("id","sessionId","userId","tenantId","expiresAt")
                     VALUES ($1, $2, $3, NULL, $4)`,
                    `id-${randomUUID()}`,
                    row.sessionId,
                    row.userId,
                    row.expiresAt,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('app_user SELECT returns own-tenant rows, NOT other tenants', async () => {
        const ownSid = `sid-own-${randomUUID()}`;
        const nullSid = `sid-null-${randomUUID()}`;
        const otherSid = `sid-other-${randomUUID()}`;
        await seedSuperuser([
            makeSessionRow({ sessionId: ownSid, tenantId: TENANT_A }),
            makeSessionRow({ sessionId: nullSid, tenantId: null }),
            makeSessionRow({ sessionId: otherSid, tenantId: TENANT_B }),
        ]);

        const visible = await withTenantDb(TENANT_A, async (tx) => {
            return tx.userSession.findMany({
                where: { sessionId: { in: [ownSid, nullSid, otherSid] } },
                select: { sessionId: true, tenantId: true },
            });
        });
        const sids = new Set(visible.map((r) => r.sessionId));
        expect(sids.has(ownSid)).toBe(true);
        // The strict isolation property — TENANT_B's session is invisible.
        expect(sids.has(otherSid)).toBe(false);

        // P1.4 CHANGED THIS ASSERTION, deliberately. It used to require the
        // NULL-tenant row to be VISIBLE here, which was the D.1 contract: the
        // NULL arm was unconditional, so under `app_user` any session could
        // read every null-tenant row on the deployment. It is now scoped to its
        // own user, and `withTenantDb` sets `app.tenant_id` but not
        // `app.user_id` — so the row is invisible, which is the FAIL-CLOSED
        // direction. The own-user-visible half is proved in
        // `tests/integration/null-tenant-user-scoping.test.ts`, which sets
        // `app.user_id` explicitly.
        expect(sids.has(nullSid)).toBe(false);
    });

    it('app_user UPDATE cannot reassign a NULL row to another tenant (WITH CHECK strict)', async () => {
        const sid = `sid-null-claim-${randomUUID()}`;
        await seedSuperuser([
            makeSessionRow({ sessionId: sid, tenantId: null }),
        ]);

        // Try to claim the NULL row for TENANT_B while the session is bound to
        // TENANT_A. The USING arm admits the row; the WITH CHECK (own) rejects
        // the new tenantId.
        //
        // P1.4 ADDED THE `set_config` LINE, and the reason is the sharper half
        // of this test. The NULL arm is now scoped to the row's own user, so
        // without `app.user_id` the row is INVISIBLE — and an UPDATE that
        // matches no rows SUCCEEDS, affecting zero. The assertion below would
        // then fail not because the write was allowed but because it was never
        // attempted: a silent pass dressed as a refusal. Setting the user makes
        // the row visible, which is the only state in which "WITH CHECK
        // refuses" is a claim about anything.
        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `SELECT set_config('app.user_id', $1, true)`,
                    USER_ID,
                );
                await tx.$executeRawUnsafe(
                    `UPDATE "UserSession" SET "tenantId" = $1 WHERE "sessionId" = $2`,
                    TENANT_B,
                    sid,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('P1.4 control: with the row HIDDEN, the same UPDATE is silently a no-op', async () => {
        // The failure mode the test above now guards against, pinned so nobody
        // "simplifies" the set_config away. This is the RLS rule that bites
        // everywhere: a write under RLS does not raise when SELECT hides the
        // row — it quietly affects zero rows. Assert the COUNT, never that the
        // call returned.
        const sid = `sid-null-hidden-${randomUUID()}`;
        await seedSuperuser([makeSessionRow({ sessionId: sid, tenantId: null })]);

        const affected = await withTenantDb(TENANT_A, async (tx) => {
            // No set_config — `app.user_id` is unset, so the row is filtered.
            return tx.$executeRawUnsafe(
                `UPDATE "UserSession" SET "tenantId" = $1 WHERE "sessionId" = $2`,
                TENANT_B,
                sid,
            );
        });
        expect(affected).toBe(0);

        // And the row is untouched, read back past RLS as the superuser.
        const row = await globalPrisma.userSession.findFirst({
            where: { sessionId: sid },
            select: { tenantId: true },
        });
        expect(row?.tenantId).toBeNull();
    });

    it('app_user UPDATE cannot reassign an own-tenant row to another tenant', async () => {
        const sid = `sid-own-reassign-${randomUUID()}`;
        await seedSuperuser([
            makeSessionRow({ sessionId: sid, tenantId: TENANT_A }),
        ]);

        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "UserSession" SET "tenantId" = $1 WHERE "sessionId" = $2`,
                    TENANT_B,
                    sid,
                );
            }),
        ).rejects.toThrow(/row-level security|new row violates/i);
    });

    it('superuser (no SET LOCAL ROLE) sees every row regardless of tenant', async () => {
        const ownSid = `sid-su-own-${randomUUID()}`;
        const otherSid = `sid-su-other-${randomUUID()}`;
        const nullSid = `sid-su-null-${randomUUID()}`;
        await seedSuperuser([
            makeSessionRow({ sessionId: ownSid, tenantId: TENANT_A }),
            makeSessionRow({ sessionId: otherSid, tenantId: TENANT_B }),
            makeSessionRow({ sessionId: nullSid, tenantId: null }),
        ]);

        const all = await globalPrisma.userSession.findMany({
            where: { sessionId: { in: [ownSid, otherSid, nullSid] } },
            select: { sessionId: true },
        });
        expect(all).toHaveLength(3);
    });
});
