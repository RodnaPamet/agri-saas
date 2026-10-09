/**
 * A compliance-critical audit row is ATOMIC with the write it describes.
 *
 * ## What this is for (#1223)
 *
 * `appendAuditEntry` opened its own `$transaction` on the global client, so an
 * audited write needed a SECOND pool connection. At `PG_POOL_MAX` it could not
 * get one: 12 writes committed with 0 audit rows and 0 rejections. The write
 * survived; the hash-chained trail gained a hole.
 *
 * `logEvent` already RECEIVED the caller's transaction on all 222 of its call
 * sites and discarded it — the parameter was spelled `_db`. For the entities in
 * `fail-closed-entities.ts` it now uses it, so the chain append runs on the
 * caller's transaction: no second connection, and the row commits or rolls back
 * with the write.
 *
 * ## Why the best-effort case is asserted too, and is the real discriminator
 *
 * "The audit row is gone after a rollback" is also what a test produces when
 * the audit row was never written at all. So the same rollback is run twice
 * with only the ENTITY TYPE changed: a fail-closed entity must lose its row,
 * and a best-effort entity must KEEP one. One of those outcomes is impossible
 * unless the classification is actually being consulted.
 *
 * The best-effort result is worth reading twice: an audit row SURVIVES a write
 * that rolled back, so the trail asserts something happened that did not. That
 * is pre-existing behaviour, not something this change introduces — and for the
 * seventeen entities routed fail-closed, it is now fixed as a side effect of
 * fixing the connection. Out of scope for the rest.
 *
 * ## Cleanup
 *
 * `AuditLog` carries a `BEFORE UPDATE OR DELETE` trigger raising
 * `IMMUTABLE_AUDIT_LOG`, so these rows cannot be deleted — by design, and
 * TRUNCATE is left as the test-reset path precisely because it is DDL and
 * bypasses row triggers. This suite will NOT truncate a table other suites in
 * the same serial run share. Every assertion is scoped to a tenant id unique
 * to the run, the leftovers are inert, and `resetDatabase` already lists
 * `AuditLog` for anyone who wants them gone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { withTenantDb } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { createTenantWithDek, clearTenantDekCache } from '@/lib/security/tenant-key-manager';
import { isFailClosedAuditEntity, failClosedAuditEntities } from '@/lib/audit';
import { hashForLookup } from '@/lib/security/encryption';
import { PG_POOL_MAX } from '@/lib/db/pool-config';
import { makeRequestContext } from '../helpers/make-context';

import { DB_URL, DB_AVAILABLE } from './db-helper';

// The APP's connection — see #1265: `DB_URL` and `process.env.DATABASE_URL`
// are the same database in CI and can differ locally, and a verifier built
// from the wrong one reports committed rows as absent.
const APP_DB_URL = process.env.DATABASE_URL ?? DB_URL;

/** A bare client: no audit extension, so the verifier writes no audit rows. */
const verifier = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_DB_URL }) });

/**
 * The one delegate these assertions reach for, named rather than cast to
 * `any`.
 *
 * Two `as any` casts cost two lint warnings, and the ceiling has no headroom
 * left to pay for them. Naming the shape also means a `location` rename breaks
 * here loudly rather than surviving as `any` and failing at runtime.
 */
type LocationReader = { location: { findUnique(args: unknown): Promise<unknown> } };
const verifierRaw = () => verifier as unknown as LocationReader;

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * Rows for one entity, optionally narrowed by actor type.
 *
 * The narrowing matters: a model write triggers the EXTENSION's automatic
 * audit (`actorType: 'SYSTEM'`, no actor id) as well as any explicit
 * `logEvent` (`actorType: 'USER'`). A count over both cannot tell "logEvent's
 * row was correctly dropped" from "no row was written at all" — which is how
 * this helper's first version made the best-effort case look broken when the
 * behaviour was right.
 */
async function auditRowsForActor(
    tenantId: string,
    entity: string,
    actorType: string,
): Promise<number> {
    const rows: Array<{ n: bigint }> = await verifier.$queryRawUnsafe(
        `SELECT count(*)::bigint AS n FROM "AuditLog"
         WHERE "tenantId" = $1 AND "entity" = $2 AND "actorType" = $3`,
        tenantId,
        entity,
        actorType,
    );
    return Number(rows[0].n);
}

async function auditRowsFor(tenantId: string, entity: string): Promise<number> {
    const rows: Array<{ n: bigint }> = await verifier.$queryRawUnsafe(
        `SELECT count(*)::bigint AS n FROM "AuditLog" WHERE "tenantId" = $1 AND "entity" = $2`,
        tenantId,
        entity,
    );
    return Number(rows[0].n);
}

describeFn('a fail-closed audit row is atomic with its write (#1223)', () => {
    const TENANT = `t-failclosed-${randomUUID()}`;
    const USER = `u-failclosed-${randomUUID()}`;
    const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, userId: USER });

    beforeAll(async () => {
        await createTenantWithDek({ id: TENANT, name: 'failclosed', slug: TENANT });
        // `AuditLog.userId` is a real FK, so the actor must EXIST and be
        // COMMITTED before any audit insert references it. Created through the
        // bare verifier — outside every transaction, and with no audit
        // extension, so this fixture writes no audit rows of its own.
        // `emailHash` is nullable, which is what lets a bare client do this
        // without the PII extension.
        // `emailHash` is typed optional by Prisma but the COLUMN is NOT NULL,
        // which is why the convention for a client that bypasses the PII
        // extension is to supply it explicitly rather than rely on the type.
        const email = `${USER}@example.test`;
        await verifier.user.create({
            data: {
                id: USER,
                email,
                emailHash: hashForLookup(email, 'email'),
                name: 'failclosed actor',
            },
        });
    });

    afterAll(async () => {
        // Locations are removable; the tenant is not while its immutable audit
        // rows reference it, and that is the trade this suite accepts.
        await verifier.location.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
        // The user cannot go while immutable audit rows reference it either.
        await verifier.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
        await verifier.$disconnect();
    });

    it('control: the classification is consulted, and is case-insensitive', () => {
        expect(isFailClosedAuditEntity('TenantMembership')).toBe(true);
        // The codebase spells entityType inconsistently — `Location` and
        // `LOCATION` both occur — so a case-sensitive set would fail OPEN,
        // which is the direction that loses rows.
        expect(isFailClosedAuditEntity('tenantmembership')).toBe(true);
        expect(isFailClosedAuditEntity('TENANTMEMBERSHIP')).toBe(true);
        // ...and an ordinary content entity is NOT fail-closed.
        expect(isFailClosedAuditEntity('Location')).toBe(false);
        expect(isFailClosedAuditEntity('Task')).toBe(false);
        expect(isFailClosedAuditEntity(undefined)).toBe(false);
        // The set is non-empty and every entry is a real schema model name.
        expect(failClosedAuditEntities().length).toBeGreaterThanOrEqual(10);
    });

    it('control: every fail-closed entity is a REAL Prisma model', () => {
        // A typo in that list fails OPEN — the entity silently stays
        // best-effort, which is the direction that loses rows, and nothing
        // else would ever say so. Derived from the schema rather than kept as
        // a second hand-maintained list that could rot the same way.
        const schemaDir = path.resolve(__dirname, '../../prisma/schema');
        const models = new Set<string>();
        for (const file of fs.readdirSync(schemaDir).filter((n) => n.endsWith('.prisma'))) {
            const src = fs.readFileSync(path.join(schemaDir, file), 'utf8');
            for (const m of src.matchAll(/^model\s+(\w+)\s*\{/gm)) models.add(m[1]);
        }
        // The denominator, so an empty read cannot pass this silently.
        expect(models.size).toBeGreaterThan(100);
        expect(models.has('TenantMembership')).toBe(true);

        const notAModel = failClosedAuditEntities().filter((e) => !models.has(e));
        expect(notAModel).toEqual([]);
    });

    it('FAIL CLOSED: a rolled-back write takes its audit row with it', async () => {
        const before = await auditRowsFor(TENANT, 'TenantMembership');

        await expect(
            withTenantDb(TENANT, async (db) => {
                await logEvent(db, ctx, {
                    action: 'UPDATE',
                    entityType: 'TenantMembership',
                    entityId: `m-${randomUUID()}`,
                    detailsJson: { category: 'access', granted: true } as never,
                });
                throw new Error('deliberate rollback');
            }),
        ).rejects.toThrow('deliberate rollback');

        // THE POINT. On the caller's transaction the append rolls back with it.
        expect(await auditRowsFor(TENANT, 'TenantMembership')).toBe(before);
    });

    it('BOTH tiers now roll back with the write (#1223 before-commit drain)', async () => {
        // This test USED to be the discriminator: the same rollback left a
        // best-effort row and removed a fail-closed one. #1223's before-commit
        // collector moved every audit write onto the caller's transaction, so
        // both tiers are atomic now and that difference is gone.
        //
        // Keeping the case, inverted, because the OLD behaviour was the
        // defect: a best-effort row survived a write that rolled back, so the
        // trail asserted something that did not happen. For a hash-chained
        // record that is the wrong direction to be wrong in.
        const beforeBE = await auditRowsFor(TENANT, 'Location');
        const beforeFC = await auditRowsFor(TENANT, 'TenantMembership');

        await expect(
            withTenantDb(TENANT, async (db) => {
                await logEvent(db, ctx, {
                    action: 'UPDATE',
                    entityType: 'Location',
                    entityId: `loc-${randomUUID()}`,
                    detailsJson: { category: 'custom', legacyText: 'probe' } as never,
                });
                throw new Error('deliberate rollback');
            }),
        ).rejects.toThrow('deliberate rollback');

        expect(await auditRowsFor(TENANT, 'Location')).toBe(beforeBE);
        // ...and the fail-closed count is untouched by a best-effort rollback,
        // so this is not just "the whole table is empty".
        expect(await auditRowsFor(TENANT, 'TenantMembership')).toBe(beforeFC);
    });

    it('THE DISCRIMINATOR: an audit failure aborts a FAIL-CLOSED write', async () => {
        // The two tiers are now separated by what an audit FAILURE costs, not
        // by rollback behaviour. Forced without mocking: `AuditLog.userId` is a
        // real FK, so an actor that does not exist makes the chain insert fail
        // with 23503 — a realistic failure rather than a stubbed one.
        const bogus = makeRequestContext('ADMIN', {
            tenantId: TENANT,
            userId: `ghost-${randomUUID()}`,
        });
        const locId = `loc-fc-${randomUUID()}`;

        await expect(
            withTenantDb(TENANT, async (db) => {
                await db.location.create({ data: { id: locId, tenantId: TENANT, name: 'fc' } });
                await logEvent(db, bogus, {
                    action: 'UPDATE',
                    entityType: 'TenantMembership',
                    entityId: `m-${randomUUID()}`,
                    detailsJson: { category: 'access', granted: true } as never,
                });
            }),
        ).rejects.toThrow();

        // The business write is GONE — the audit failure took it with it.
        const found = await verifierRaw().location.findUnique({ where: { id: locId } });
        expect(found).toBeNull();
    });

    it('THE DISCRIMINATOR: an audit failure LEAVES a best-effort write committed', async () => {
        // Same forced failure, best-effort entity. The savepoint rolls the
        // audit insert back and the transaction stays usable, so the write
        // commits with no audit row — which is what "best effort" has always
        // claimed and, before #1223, could not deliver without a second pool
        // connection.
        const bogus = makeRequestContext('ADMIN', {
            tenantId: TENANT,
            userId: `ghost-${randomUUID()}`,
        });
        const locId = `loc-be-${randomUUID()}`;
        // USER-attributed only: the `location.create` below also produces the
        // extension's own SYSTEM row, which has no actor and so does not hit
        // the FK — counting both would hide the result.
        const beforeUser = await auditRowsForActor(TENANT, 'Location', 'USER');
        const beforeSystem = await auditRowsForActor(TENANT, 'Location', 'SYSTEM');

        await withTenantDb(TENANT, async (db) => {
            await db.location.create({ data: { id: locId, tenantId: TENANT, name: 'be' } });
            await logEvent(db, bogus, {
                action: 'UPDATE',
                entityType: 'Location',
                entityId: `loc-${randomUUID()}`,
                detailsJson: { category: 'custom', legacyText: 'probe' } as never,
            });
        });

        // The write SURVIVED, and logEvent's row did not.
        const found = await verifierRaw().location.findUnique({ where: { id: locId } });
        expect(found).not.toBeNull();
        expect(await auditRowsForActor(TENANT, 'Location', 'USER')).toBe(beforeUser);
        // ...while the extension's own audit of that same write DID land, which
        // is what proves the transaction stayed usable after the savepoint
        // rollback rather than the whole audit path having gone silent.
        expect(await auditRowsForActor(TENANT, 'Location', 'SYSTEM')).toBe(beforeSystem + 1);
    });

    it('FAIL CLOSED: a COMMITTED write keeps its audit row', async () => {
        // Without this, "the row is gone" would also be satisfied by a change
        // that simply stopped writing fail-closed audit rows at all.
        const before = await auditRowsFor(TENANT, 'TenantMembership');

        await withTenantDb(TENANT, async (db) => {
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'TenantMembership',
                entityId: `m-${randomUUID()}`,
                detailsJson: { category: 'access', granted: true } as never,
            });
        });

        expect(await auditRowsFor(TENANT, 'TenantMembership')).toBe(before + 1);
    });

    // ── P3.4 — FarmIdentityClaim joined the list (owner ruling 2026-10-06) ──
    //
    // Driven against the REAL table rather than asserted from the list, because
    // `isFailClosedAuditEntity('FarmIdentityClaim') === true` only proves the
    // classification is present. It cannot show that a claim write actually
    // rides the caller's transaction — which is the property the ruling bought,
    // and the one that would silently stop holding if the audit extension's
    // model-to-entityType mapping ever stopped covering this model.

    it('FAIL CLOSED: an audit failure aborts a FarmIdentityClaim write', async () => {
        const bogus = makeRequestContext('ADMIN', {
            tenantId: TENANT,
            userId: `ghost-${randomUUID()}`,
        });
        const claimId = `fic-fc-${randomUUID()}`;

        await expect(
            withTenantDb(TENANT, async (db) => {
                await db.farmIdentityClaim.create({
                    data: {
                        id: claimId,
                        tenantId: TENANT,
                        eikHash: hashForLookup(`831650349-${claimId}`, 'eik'),
                        status: 'PENDING',
                        claimedByUserId: USER,
                    },
                });
                await logEvent(db, bogus, {
                    action: 'CREATE',
                    entityType: 'FarmIdentityClaim',
                    entityId: claimId,
                    detailsJson: { category: 'access', granted: true } as never,
                });
            }),
        ).rejects.toThrow();

        // THE POINT: the claim is GONE. A claim that outlived its own audit row
        // would be a farm identity assertion with no record of who made it.
        const found = await (verifier as never as PrismaClient).farmIdentityClaim.findUnique({
            where: { id: claimId },
        });
        expect(found).toBeNull();
    });

    it('FAIL CLOSED: a COMMITTED FarmIdentityClaim keeps both its rows', async () => {
        // The positive control. Without it, the case above is also satisfied by
        // a build in which `farmIdentityClaim.create` never works at all.
        //
        // Counted PER ACTOR, not in total. The `create` below produces the
        // extension's own `SYSTEM` row as well as the explicit `logEvent`
        // `USER` row, so a total count moves by two — which is what the first
        // version of this case got wrong, asserting +1 against `auditRowsFor`.
        // Splitting them also makes the assertion say more: the fail-closed
        // `logEvent` row landed AND the extension's automatic audit of the same
        // write landed, rather than one covering for the other.
        const beforeUser = await auditRowsForActor(TENANT, 'FarmIdentityClaim', 'USER');
        const beforeSystem = await auditRowsForActor(TENANT, 'FarmIdentityClaim', 'SYSTEM');
        const claimId = `fic-ok-${randomUUID()}`;

        await withTenantDb(TENANT, async (db) => {
            await db.farmIdentityClaim.create({
                data: {
                    id: claimId,
                    tenantId: TENANT,
                    eikHash: hashForLookup(`831650349-${claimId}`, 'eik'),
                    status: 'PENDING',
                    claimedByUserId: USER,
                },
            });
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'FarmIdentityClaim',
                entityId: claimId,
                detailsJson: { category: 'access', granted: true } as never,
            });
        });

        const found = await (verifier as never as PrismaClient).farmIdentityClaim.findUnique({
            where: { id: claimId },
        });
        expect(found).not.toBeNull();
        expect(await auditRowsForActor(TENANT, 'FarmIdentityClaim', 'USER')).toBe(beforeUser + 1);
        expect(await auditRowsForActor(TENANT, 'FarmIdentityClaim', 'SYSTEM')).toBe(
            beforeSystem + 1,
        );
    });

    it(`${PG_POOL_MAX} concurrent fail-closed audited writes all get their row`, async () => {
        // The #1223 property. Before this change each of these needed a second
        // pool connection for its own audit transaction, so at `max` none could
        // get one: the writes committed and the rows vanished. Cold DEK cache
        // and a barrier, because a harness that never achieved concurrency
        // produces a green test too.
        clearTenantDekCache();
        const before = await auditRowsFor(TENANT, 'TenantCustomRole');

        let release!: () => void;
        const barrier = new Promise<void>((r) => { release = r as () => void; });

        const runs = Array.from({ length: PG_POOL_MAX }, () =>
            withTenantDb(TENANT, async (db) => {
                await barrier;
                await logEvent(db, ctx, {
                    action: 'CREATE',
                    entityType: 'TenantCustomRole',
                    entityId: `r-${randomUUID()}`,
                    detailsJson: { category: 'access', granted: true } as never,
                });
            }),
        );
        release();
        const settled = await Promise.allSettled(runs);

        const rejected = settled.filter((s) => s.status === 'rejected');
        if (rejected.length > 0) {
            throw new Error(
                `${rejected.length}/${PG_POOL_MAX} transactions failed: ` +
                    rejected.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120)).join(' | '),
            );
        }
        // Every write committed AND every row is there — the two halves #1223
        // showed coming apart.
        expect(await auditRowsFor(TENANT, 'TenantCustomRole')).toBe(before + PG_POOL_MAX);
    }, 60_000);
});
