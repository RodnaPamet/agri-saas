/**
 * The `'*'` fan-out no longer reaches a model that did not ask for it (#1222).
 *
 * ## What this pins, and why nothing did before
 *
 * `encryption-middleware.ts` resolved a non-manifest model to `'*'`, and the
 * `'*'` branch matches field NAMES across the whole manifest. So
 * `ExchangeListing.description` was encrypted because `Task`, `AccessReview`
 * and `CostEntry` each declare a `description` — three unrelated models
 * deciding a fourth model's fate. 18 (model, field) pairs were affected.
 *
 * Five months of green said nothing, for a reason worth keeping: the existing
 * `exchange-messaging-rls.test.ts` creates listings with **no `description` at
 * all**, through a bare `PrismaClient` carrying no extensions, and asserts on
 * ids. Nothing in the repo wrote an exchange row through the real client and
 * read the raw column back.
 *
 * ## Both arms, because one of them is the control
 *
 * `expect(plaintext)` alone would pass against a broken extension chain — if
 * encryption stopped working entirely, every column would read plaintext and
 * this file would agree. So the declared half is asserted in the same test:
 * `Location.description` IS in `ENCRYPTED_FIELDS` and must still come back
 * `v2:`. Narrowing without that control is indistinguishable from breaking.
 *
 * ## The actor has to EXIST, or this fixture cannot express an audit failure (#1286)
 *
 * `AuditLog.userId` is a real FK to `User.id`. This fixture used to attribute
 * its writes to the literal string `'u-reach'`, for which no `User` row was
 * ever created — so every audit insert it provoked died on
 * `AuditLog_userId_fkey` (Postgres `23503`). Measured on green main: **3**
 * lost rows per `Test (shard 1/6)` run, all of them this file —
 * `ExchangeListing` create once, `Location` create twice.
 *
 * The suite still PASSED, and that was correct behaviour from the writer:
 * neither model is in `src/lib/audit/fail-closed-entities.ts`, so the
 * best-effort arm reports (`audit.write_failed`, #1269) and swallows. The
 * defect was on the TEST side. A fixture that can never produce an audit row
 * makes any assertion about audit output vacuous — it would read zero and
 * pass for the wrong reason, which is a control that cannot express failure.
 *
 * So the actor is a real `User`, created through the bare client (outside
 * every transaction, no audit extension, so the fixture writes no audit rows
 * of its own), and `AUDIT CONTROL` below asserts a row IS written. That
 * assertion is what keeps the attribution from silently regressing: point
 * `ctx.userId` at an id with no `User` row again and it goes red instead of
 * passing on an empty result set.
 *
 * `emailHash` is typed optional by Prisma but the COLUMN is NOT NULL, so a
 * client that bypasses the PII extension must supply it explicitly rather
 * than rely on the type — the same convention
 * `audit-fail-closed-atomicity.test.ts` follows.
 *
 * ## Cleanup, and why it needs a trigger bypass now
 *
 * Succeeding at the audit append is what makes cleanup harder. `AuditLog`
 * carries a `BEFORE UPDATE OR DELETE` trigger raising `IMMUTABLE_AUDIT_LOG`,
 * and those rows reference this suite's `Tenant` (FK restricts) and `User`
 * (nullable FK, so a delete needs the UPDATE that trigger forbids). This
 * suite deleted its tenant before #1286 and still does: the alternative was
 * leaking a tenant, a user and four audit rows per run, and a cleanup
 * regression hidden behind an "inert leftovers" argument is exactly the kind
 * of claim that goes false quietly.
 *
 * So the audit rows go first, inside ONE transaction that sets
 * `session_replication_role = 'replica'` — the same mechanism, for the same
 * reason, as `audit-hash-chain.test.ts`. `SET LOCAL` reverts at COMMIT and
 * the `DELETE` is scoped to this run's own tenant id, so the immutability
 * trigger is unavailable for exactly one statement about rows nothing else
 * can see. With them gone the tenant and user delete normally, FK checks
 * intact. TRUNCATE is deliberately NOT the tool — it is DDL and would take
 * other suites' rows with it in a serial run.
 *
 * The whole sequence is tolerated rather than fatal, mirroring that same
 * suite's `afterAll`: a cleanup that cannot run should not redden the
 * assertions above it, and if the bypass is ever unavailable the leftovers
 * are at least inert (every id here is unique to the run, the hash chain
 * `verify.ts` checks is per-tenant, and `resetDatabase` lists `AuditLog`).
 * That is the FALLBACK, not the design.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { DELIBERATELY_PLAINTEXT, ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const bare = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TENANT = `t-reach-${randomUUID()}`;
/** #1286 — a REAL `User.id`, because `AuditLog.userId` is a foreign key. */
const ACTOR = `u-reach-${randomUUID()}`;
const ctx = { requestId: 'reach', userId: ACTOR, tenantId: TENANT, role: 'ADMIN' } as never;

const rawColumn = async (table: string, column: string, id: string): Promise<string | null> => {
    const rows = await bare.$queryRawUnsafe<Array<Record<string, string | null>>>(
        `SELECT "${column}" AS v FROM "${table}" WHERE id = $1`,
        id,
    );
    return rows[0]?.v ?? null;
};

/**
 * The audit rows the EXTENSION wrote for one entity row.
 *
 * Narrowed to `actorType = 'SYSTEM'` on purpose: a model write triggers the
 * extension's automatic append, while an explicit `logEvent` would write
 * `'USER'`. A count over both could not tell "the extension's row landed"
 * from "something else wrote one", which is the distinction the assertion
 * below is making.
 */
const auditRowsFor = async (
    entity: string,
    entityId: string,
): Promise<Array<{ userId: string | null; action: string; requestId: string | null }>> =>
    bare.$queryRawUnsafe(
        `SELECT "userId", "action", "requestId" FROM "AuditLog"
         WHERE "tenantId" = $1 AND "entity" = $2 AND "entityId" = $3 AND "actorType" = 'SYSTEM'`,
        TENANT,
        entity,
        entityId,
    );

describeFn('#1222 the narrowed fan-out', () => {
    beforeAll(async () => {
        await createTenantWithDek({ id: TENANT, name: 'reach', slug: TENANT });
        // #1286 — the audit actor must EXIST and be COMMITTED before any
        // audit insert references it. Written through the bare client: no
        // audit extension, so this fixture adds no audit rows of its own.
        const email = `${ACTOR}@example.test`;
        await bare.user.create({
            data: {
                id: ACTOR,
                email,
                emailHash: hashForLookup(email, 'email'),
                name: 'reach actor',
            },
        });
    });

    afterAll(async () => {
        await bare.exchangeListing.deleteMany({ where: { sellerTenantId: TENANT } });
        await bare.location.deleteMany({ where: { tenantId: TENANT } });
        // #1286 — see "Cleanup" above. The audit rows must go before the
        // Tenant and User they reference, and only a trigger bypass can move
        // them. Tolerated as a whole: a broken cleanup must not redden the
        // assertions, and nothing above this line depends on it.
        try {
            await bare.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "AuditLog" WHERE "tenantId" = $1`,
                    TENANT,
                );
            });
            await bare.tenant.deleteMany({ where: { id: TENANT } });
            await bare.user.deleteMany({ where: { id: ACTOR } });
        } catch {
            // Leftovers are inert — every id is unique to this run.
        }
        await bare.$disconnect();
    });

    it('control: the two models under test are classified OPPOSITELY', () => {
        // If someone later declares ExchangeListing, this test would assert the
        // wrong thing while still passing its own logic. Pin the premise.
        expect(DELIBERATELY_PLAINTEXT['ExchangeListing.description']).toBeDefined();
        expect((ENCRYPTED_FIELDS as Record<string, readonly string[]>).ExchangeListing).toBeUndefined();
        expect((ENCRYPTED_FIELDS as Record<string, readonly string[]>).Location).toContain('description');
    });

    it('an UNDECLARED model carrying a manifest field name is NOT encrypted', async () => {
        const id = `exl-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.exchangeListing.create({
                data: {
                    id, sellerTenantId: TENANT, sellerUserId: ACTOR,
                    side: 'SELL', commodity: 'Wheat', quantityTonnes: 10,
                    regionCode: 'BG-16', regionName: 'Plovdiv', lat: 42.1, lon: 24.7,
                    description: 'REACH_PLAINTEXT_EXPECTED',
                },
            }),
        );
        const raw = await rawColumn('ExchangeListing', 'description', id);
        // Before the narrowing this was `v2:…` — measured, not assumed.
        expect(raw).toBe('REACH_PLAINTEXT_EXPECTED');
        expect(raw?.startsWith('v1:')).toBe(false);
        expect(raw?.startsWith('v2:')).toBe(false);
    });

    it('CONTROL: a DECLARED model is still encrypted', async () => {
        // The half that makes the assertion above mean something. A broken
        // extension chain would make every column plaintext.
        const id = `loc-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.location.create({
                data: { id, tenantId: TENANT, name: 'reach', description: 'REACH_ENCRYPTED_EXPECTED' },
            }),
        );
        const raw = await rawColumn('Location', 'description', id);
        expect(raw?.startsWith('v2:')).toBe(true);
        expect(raw).not.toContain('REACH_ENCRYPTED_EXPECTED');
    });

    it('a DECLARED field still round-trips through the app client', async () => {
        // Encryption that cannot be read back is not protection, it is loss.
        const id = `loc-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.location.create({
                data: { id, tenantId: TENANT, name: 'roundtrip', description: 'ROUND_TRIP' },
            }),
        );
        const read = await runInTenantContext(ctx, async (db) =>
            db.location.findUnique({ where: { id }, select: { description: true } }),
        );
        expect(read?.description).toBe('ROUND_TRIP');
    });

    it('AUDIT CONTROL: a write from this fixture DOES append an audit row (#1286)', async () => {
        // The assertion this file could not make before. Every write above
        // provoked an `AuditLog_userId_fkey` violation that the best-effort
        // arm swallowed, so a read of `AuditLog` here returned zero rows and
        // any emptiness-tolerant claim would have passed for the wrong reason.
        //
        // Positive by construction: an empty result FAILS this, which is what
        // makes it a regression test for the attribution rather than for the
        // query. `entityId` is a fresh uuid, so the window cannot pick up a
        // row from another test in this suite or another suite in the run.
        const id = `loc-${randomUUID()}`;
        await runInTenantContext(ctx, async (db) =>
            db.location.create({
                data: { id, tenantId: TENANT, name: 'audited', description: 'AUDITED' },
            }),
        );

        const rows = await auditRowsFor('Location', id);
        expect(rows).toHaveLength(1);
        // The FK is the whole point: the row carries the REAL actor id, which
        // is only possible because a `User` row exists for it.
        expect(rows[0].userId).toBe(ACTOR);
        expect(rows[0].action).toBe('CREATE');
        expect(rows[0].requestId).toBe('reach');
    });
});
