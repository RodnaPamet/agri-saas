/**
 * #2948 stage 1 — the machine-tracking tables, asserted against the live
 * database.
 *
 * WHY THIS CARRIES THE WHOLE STAGE. The schema ships one release before any
 * code writes it, so there is no route to catch a mistake and no traffic to
 * reveal one. Migration 20260323180000's `ALTER DEFAULT PRIVILEGES` grants
 * `app_user` SELECT/INSERT/UPDATE/DELETE on every new table in `public`, so
 * these five are reachable by a tenant session the moment they exist — and
 * `MachinePosition` holds employee location data. The RLS and the composite
 * FKs are the only things standing between the first writer and a leak.
 *
 * ── every negative is paired with a positive, and that is not symmetry ──
 *
 * Under RLS, `current_setting('app.tenant_id', true)` on an unset session
 * yields NULL, every policy matches nothing, and a SELECT returns ZERO rows
 * with no error. So "the outsider saw 0" is satisfied perfectly by a harness
 * that never inserted anything, never opened a context, or pointed at the
 * wrong table name. P8.1 shipped exactly that: all three of its refusal cases
 * passed while an `infinite recursion` error meant nothing could insert at
 * all, and only a positive control found it.
 *
 * Every isolation test here therefore asserts the OWNER sees a non-zero count
 * in the same breath as the outsider seeing zero.
 *
 * ── where the SQLSTATE lives ──
 *
 * Prisma wraps a raw-query failure as `P2010` and the underlying SQLSTATE
 * survives only in the MESSAGE — `err.meta.code` is undefined. P5.1 matches
 * on the message for this reason, and reading `meta.code` is how its first
 * run reported seven failures that were all the instrument.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TABLES = [
    'MachineTracker',
    'MachinePosition',
    'WorkedParcel',
    'TaskAsset',
    'MachineGeofenceState',
] as const;

const tenantCtx = (userId: string, tenantId: string) =>
    ({ userId, tenantId, requestId: `r-${randomUUID()}`, role: 'EDITOR' }) as never;

/**
 * The SQLSTATE, read out of the message rather than `meta.code`. Returns the
 * raw message when no code is present, so a failure that is NOT a Postgres
 * error shows what it actually was instead of `undefined`.
 */
async function sqlstateOf(fn: () => Promise<unknown>): Promise<string> {
    try {
        await fn();
        return 'NO_ERROR';
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = msg.match(/\b(\d{5})\b/);
        return m ? m[1] : msg.slice(0, 160);
    }
}

/** Count rows of `table` visible through whichever runner the caller opened. */
async function visible(db: unknown, table: string, tenantId: string): Promise<number> {
    const rows = await (db as PrismaClient).$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}" WHERE "tenantId" = $1`,
        tenantId,
    );
    return Number(rows[0].n);
}

interface Farm {
    tenantId: string;
    userId: string;
    assetId: string;
    parcelId: string;
    taskId: string;
    locationId: string;
}

async function makeFarm(label: string): Promise<Farm> {
    const sfx = `${label}-${randomUUID().slice(0, 8)}`;
    const tenantId = `t-2948-${sfx}`;
    const userId = `u-2948-${sfx}`;
    const assetId = `a-2948-${sfx}`;
    const parcelId = `p-2948-${sfx}`;
    const taskId = `k-2948-${sfx}`;
    const locationId = `l-2948-${sfx}`;

    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Tenant" ("id","name","slug","createdAt","updatedAt")
         VALUES ($1,$2,$3,now(),now())`,
        tenantId,
        `Farm ${sfx}`,
        `farm-${sfx}`,
    );
    // The column is `emailEncrypted`, NOT `email`: `User.email` is
    // `@map("emailEncrypted")` because GAP-21 stores it encrypted at rest, and
    // `name` is `@map("nameEncrypted")` and optional, so it is omitted. Writing
    // `email` here is what this file's first run did, and it failed with 42703
    // — the P5.6a lesson verbatim: verify column names against the schema, not
    // against a green typecheck, because a raw query is invisible to `tsc`.
    // THREE things about this one insert, each of which cost a run:
    //
    //  - the column is `emailEncrypted`, NOT `email`. `User.email` is
    //    `@map("emailEncrypted")` (GAP-21, encrypted at rest), and `name` is
    //    `@map("nameEncrypted")` and optional, so it is omitted. Writing
    //    `email` fails with 42703 — the P5.6a lesson verbatim: verify column
    //    names against the schema, because a raw query is invisible to `tsc`.
    //  - `emailHash` is `String?` in the schema and NOT NULL in the DATABASE,
    //    one of this repo's deliberate divergences: it is declared optional so
    //    callers never set it, because `pii-middleware` derives it from
    //    `email` on every write. A RAW insert bypasses that middleware, so the
    //    fixture has to do the middleware's job.
    //  - so the value comes from the real `hashForLookup`, not a placeholder.
    //    A random string would satisfy the constraint and make the row
    //    unfindable by the lookup path, which is the shape that makes a
    //    fixture quietly unlike production.
    const email = `${sfx}@example.invalid`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id","emailEncrypted","emailHash","createdAt","updatedAt")
         VALUES ($1,$2,$3,now(),now())`,
        userId,
        encryptField(email),
        hashForLookup(email),
    );
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Asset" ("id","tenantId","name","type","createdAt","updatedAt")
         VALUES ($1,$2,$3,'TRACTOR',now(),now())`,
        assetId,
        tenantId,
        `Tractor ${sfx}`,
    );
    // `Parcel.locationId` is NOT NULL — a parcel belongs to a block — so the
    // fixture has to build the block first.
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Location" ("id","tenantId","name","createdAt","updatedAt")
         VALUES ($1,$2,$3,now(),now())`,
        locationId,
        tenantId,
        `Blok ${sfx}`,
    );
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Parcel" ("id","tenantId","locationId","name","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,now(),now())`,
        parcelId,
        tenantId,
        locationId,
        `Parcel ${sfx}`,
    );
    // `createdByUserId` is NOT NULL on Task.
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Task" ("id","tenantId","title","createdByUserId","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,now(),now())`,
        taskId,
        tenantId,
        `Spray ${sfx}`,
        userId,
    );
    return { tenantId, userId, assetId, parcelId, taskId, locationId };
}

/** A live tracker for an asset, returning its id. */
async function makeTracker(f: Farm, imei: string, id = `mt-${randomUUID().slice(0, 8)}`) {
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "MachineTracker"
           ("id","tenantId","assetId","imei","installedAt",
            "driversInformedAt","driversInformedByUserId","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,now(),now(),$5,now(),now())`,
        id,
        f.tenantId,
        f.assetId,
        imei,
        f.userId,
    );
    return id;
}

async function seedAllFive(f: Farm, trackerId: string) {
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "MachinePosition"
           ("id","tenantId","assetId","trackerId","recordedAt","lat","lon","createdAt")
         VALUES ($1,$2,$3,$4,now(),42.6977,23.3219,now())`,
        `mp-${randomUUID().slice(0, 8)}`,
        f.tenantId,
        f.assetId,
        trackerId,
    );
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "WorkedParcel"
           ("id","tenantId","assetId","parcelId","date","minutesWorked","derivedFrom","derivedAt")
         VALUES ($1,$2,$3,$4,CURRENT_DATE,120,'test-v1',now())`,
        `wp-${randomUUID().slice(0, 8)}`,
        f.tenantId,
        f.assetId,
        f.parcelId,
    );
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "TaskAsset" ("id","tenantId","taskId","assetId","createdAt")
         VALUES ($1,$2,$3,$4,now())`,
        `ta-${randomUUID().slice(0, 8)}`,
        f.tenantId,
        f.taskId,
        f.assetId,
    );
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "MachineGeofenceState"
           ("id","tenantId","assetId","lastEvaluatedAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,now(),now(),now())`,
        `gs-${randomUUID().slice(0, 8)}`,
        f.tenantId,
        f.assetId,
    );
}

describeFn('#2948 stage 1 — machine-tracking schema', () => {
    let owner: Farm;
    let outsider: Farm;
    let ownerTracker = '';

    beforeAll(async () => {
        owner = await makeFarm('own');
        outsider = await makeFarm('out');
        ownerTracker = await makeTracker(owner, `3500${Date.now()}`.slice(0, 15));
        await seedAllFive(owner, ownerTracker);
    }, 60_000);

    afterAll(async () => {
        // Reverse dependency order. Privileged client, so RLS does not hide
        // the rows being removed — a tenant-context delete would silently
        // affect zero and leave the base database dirty for the next suite.
        for (const t of ['MachinePosition', 'MachineGeofenceState', 'TaskAsset', 'WorkedParcel', 'MachineTracker']) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "${t}" WHERE "tenantId" = ANY($1::text[])`,
                [owner.tenantId, outsider.tenantId],
            );
        }
        for (const f of [owner, outsider]) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Task" WHERE "id" = $1`, f.taskId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Parcel" WHERE "id" = $1`, f.parcelId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Location" WHERE "id" = $1`, f.locationId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "id" = $1`, f.assetId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, f.userId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, f.tenantId);
        }
        await globalPrisma.$disconnect();
    }, 60_000);

    describe('§0 the control — the migration is actually applied', () => {
        it('all five tables exist, so nothing below passes over an absent table', async () => {
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ table_name: string }>>(
                `SELECT table_name FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
                TABLES as unknown as string[],
            );
            expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
        });

        it('the owner farm really has a row in each — the positive the negatives rest on', async () => {
            for (const t of TABLES) {
                expect(await visible(globalPrisma, t, owner.tenantId)).toBeGreaterThan(0);
            }
        });
    });

    describe('§1 RLS isolates every one of the five', () => {
        it.each(TABLES)('%s — the owner sees its rows and the outsider sees NONE', async (table) => {
            const mine = await runInTenantContext(
                tenantCtx(owner.userId, owner.tenantId),
                (db) => visible(db, table, owner.tenantId),
            );
            const theirs = await runInTenantContext(
                tenantCtx(outsider.userId, outsider.tenantId),
                (db) => visible(db, table, owner.tenantId),
            );
            // Both halves, in one test, deliberately: a zero on the right is
            // only meaningful beside a non-zero on the left.
            expect(mine).toBeGreaterThan(0);
            expect(theirs).toBe(0);
        });

        it('refuses an INSERT that forges another tenant on MachinePosition', async () => {
            const code = await sqlstateOf(() =>
                runInTenantContext(tenantCtx(outsider.userId, outsider.tenantId), (db) =>
                    (db as PrismaClient).$executeRawUnsafe(
                        `INSERT INTO "MachinePosition"
                           ("id","tenantId","assetId","recordedAt","lat","lon","createdAt")
                         VALUES ($1,$2,$3,now(),1,1,now())`,
                        `mp-forge-${randomUUID().slice(0, 8)}`,
                        owner.tenantId,
                        owner.assetId,
                    ),
                ),
            );
            // 42501 — insufficient_privilege, the WITH CHECK refusing it.
            expect(code).toBe('42501');
        });
    });

    describe('§2 the composite FK is the cross-tenant barrier', () => {
        it('refuses a position pointing at another tenant\'s asset', async () => {
            // The row claims the OUTSIDER's tenant and the OWNER's asset, so
            // RLS would admit it — only `[assetId, tenantId] -> Asset[id,
            // tenantId]` catches it. That is why the barrier is a composite FK
            // and not a `where` clause somebody has to remember, which matters
            // most on the ingest path, whose only input is an IMEI off the
            // public internet.
            const code = await sqlstateOf(() =>
                globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "MachinePosition"
                       ("id","tenantId","assetId","recordedAt","lat","lon","createdAt")
                     VALUES ($1,$2,$3,now(),1,1,now())`,
                    `mp-cross-${randomUUID().slice(0, 8)}`,
                    outsider.tenantId,
                    owner.assetId,
                ),
            );
            // 23503 — foreign_key_violation.
            expect(code).toBe('23503');
        });

        it('refuses a TaskAsset pairing one tenant\'s task with another\'s asset', async () => {
            const code = await sqlstateOf(() =>
                globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "TaskAsset" ("id","tenantId","taskId","assetId","createdAt")
                     VALUES ($1,$2,$3,$4,now())`,
                    `ta-cross-${randomUUID().slice(0, 8)}`,
                    owner.tenantId,
                    owner.taskId,
                    outsider.assetId,
                ),
            );
            expect(code).toBe('23503');
        });
    });

    describe('§3 one LIVE tracker per asset, and the index really is partial', () => {
        it('refuses a SECOND live tracker for the same asset', async () => {
            const code = await sqlstateOf(() => makeTracker(owner, `3510${Date.now()}`.slice(0, 15)));
            // 23505 — unique_violation, from the partial index.
            expect(code).toBe('23505');
        });

        it('ACCEPTS one once the first is marked removed — the control', async () => {
            // Without this the test above is equally satisfied by a PLAIN
            // unique index, which would make a replaced tracker unrecordable
            // and lose the history `removedAt` exists to keep.
            await globalPrisma.$executeRawUnsafe(
                `UPDATE "MachineTracker" SET "removedAt" = now() WHERE "id" = $1`,
                ownerTracker,
            );
            const replacement = `3520${Date.now()}`.slice(0, 15);
            const code = await sqlstateOf(() => makeTracker(owner, replacement));
            expect(code).toBe('NO_ERROR');

            // Put it back, so §1's per-table positives keep their row
            // whatever order jest runs these in.
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "MachineTracker" WHERE "imei" = $1`,
                replacement,
            );
            await globalPrisma.$executeRawUnsafe(
                `UPDATE "MachineTracker" SET "removedAt" = NULL WHERE "id" = $1`,
                ownerTracker,
            );
        });

        it('refuses two trackers sharing one IMEI, across DIFFERENT tenants', async () => {
            // The IMEI unique is deployment-wide, not per tenant: an IMEI is
            // globally unique by construction, and a per-tenant unique would
            // let two farms claim one device and make the tenant a position
            // resolves to depend on insertion order.
            const imei = `3530${Date.now()}`.slice(0, 15);
            expect(await sqlstateOf(() => makeTracker(outsider, imei))).toBe('NO_ERROR');
            expect(await sqlstateOf(() => makeTracker(owner, imei))).toBe('23505');
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "MachineTracker" WHERE "imei" = $1`, imei);
        });
    });

    describe('§4 the drivers-informed record is REQUIRED, not merely offered', () => {
        it('refuses a tracker with no driversInformedAt', async () => {
            // The owner's requirement is that drivers were told BEFORE the box
            // started reporting. A nullable column records an intention; a NOT
            // NULL one records the fact, and `POST /trackers` can then be a 400
            // rather than writing a row that quietly means nothing.
            const code = await sqlstateOf(() =>
                globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "MachineTracker"
                       ("id","tenantId","assetId","imei","installedAt",
                        "driversInformedByUserId","createdAt","updatedAt")
                     VALUES ($1,$2,$3,$4,now(),$5,now(),now())`,
                    `mt-noinform-${randomUUID().slice(0, 8)}`,
                    outsider.tenantId,
                    outsider.assetId,
                    `3540${Date.now()}`.slice(0, 15),
                    outsider.userId,
                ),
            );
            // 23502 — not_null_violation.
            expect(code).toBe('23502');
        });

        it('refuses a tracker with no driversInformedByUserId', async () => {
            const code = await sqlstateOf(() =>
                globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "MachineTracker"
                       ("id","tenantId","assetId","imei","installedAt",
                        "driversInformedAt","createdAt","updatedAt")
                     VALUES ($1,$2,$3,$4,now(),now(),now(),now())`,
                    `mt-nowho-${randomUUID().slice(0, 8)}`,
                    outsider.tenantId,
                    outsider.assetId,
                    `3550${Date.now()}`.slice(0, 15),
                ),
            );
            expect(code).toBe('23502');
        });
    });

    describe('§5 WorkedParcel is idempotent by key, not by a flag', () => {
        it('refuses a second row for the same (asset, parcel, day)', async () => {
            // The nightly derivation UPSERTs on this key, so a re-run cannot
            // double-count minutes. The unique index IS the idempotence —
            // there is no `derived` boolean for anything to forget to set.
            const code = await sqlstateOf(() =>
                globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "WorkedParcel"
                       ("id","tenantId","assetId","parcelId","date","minutesWorked","derivedFrom","derivedAt")
                     VALUES ($1,$2,$3,$4,CURRENT_DATE,99,'test-v2',now())`,
                    `wp-dup-${randomUUID().slice(0, 8)}`,
                    owner.tenantId,
                    owner.assetId,
                    owner.parcelId,
                ),
            );
            expect(code).toBe('23505');
        });
    });
});
