/**
 * The DATABASE enforces each push transport's shape (#1764).
 *
 * ## Why this is a constraint and not a validator
 *
 * `PushSubscription` now holds two transports in one table — Web Push rows
 * with an `endpoint`/`p256dh`/`auth`, and APNs rows with a `deviceToken`. That
 * is the shape worth having, because every notification sender resolves a
 * recipient by `[tenantId, userId]` and nothing else, and splitting the table
 * would split that lookup.
 *
 * #1764 expected a cost for it: the three Web Push columns go nullable, which
 * "weakens the Web Push rows' own constraint". They do go nullable, and the
 * constraint is NOT weakened, because `PushSubscription_web_shape` requires
 * them whenever `platform = WEB`. This suite is what makes that claim
 * checkable rather than asserted in a migration comment — and it tests the
 * CHECKs rather than the usecase, because a usecase-level validator cannot
 * protect a row written by a job, a future second writer, or a direct SQL fix
 * at 2am.
 *
 * ## The asymmetry in the unique indexes is the subtle part
 *
 * `PushSubscription_tenantId_userId_endpoint_key` was left alone deliberately.
 * Postgres treats NULLs as DISTINCT in a unique index, so it keeps
 * constraining Web Push rows exactly as before and ignores APNs rows entirely
 * — which is why this migration needed to drop nothing and is strictly
 * additive. That property is load-bearing and invisible from the schema, so
 * both halves of it are asserted: two APNs rows for one user are ALLOWED
 * (their endpoints are both NULL), and two with the same device token are NOT
 * (the partial `PushSubscription_ios_identity` index).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const made: string[] = [];
let tenantId = '';
let userId = '';

/** Raw insert, so the CHECKs are tested rather than Prisma's own typing. */
async function insert(cols: Record<string, string | null>): Promise<string> {
    const id = `ps-${randomUUID()}`;
    const row: Record<string, string | null> = {
        id, tenantId, userId, ...cols,
    };
    const keys = Object.keys(row);
    const names = keys.map((k) => `"${k}"`).join(',');
    const params = keys.map((_, i) => `$${i + 1}`).join(',');
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "PushSubscription"(${names}) VALUES (${params})`,
        ...keys.map((k) => row[k]),
    );
    made.push(id);
    return id;
}

const WEB = { platform: 'WEB', endpoint: null, p256dh: 'k', auth: 'a', deviceToken: null };
const TOKEN = 'a'.repeat(64);

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    tenantId = `t-ps-${randomUUID()}`;
    userId = `u-ps-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Tenant"("id","name","slug","updatedAt") VALUES ($1,$2,$3,NOW())`,
        tenantId, 'Push Shape', `push-shape-${randomUUID()}`,
    );
    // `emailEncrypted` and `emailHash` are NOT NULL — my first version wrote
    // id + updatedAt only, `beforeAll` threw, and all fourteen cases failed
    // at once. A fixture that cannot be created is indistinguishable from a
    // constraint that refuses everything.
    const email = `push-shape-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt","uiLanguage")
         VALUES ($1,$2,$3,NOW(),'bg')`,
        userId, encryptField(email), hashForLookup(email),
    );
});

afterAll(async () => {
    if (DB_AVAILABLE) {
        for (const id of made) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE "id"=$1`, id);
        }
        if (userId) await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id"=$1`, userId);
        if (tenantId) await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id"=$1`, tenantId);
    }
    await globalPrisma.$disconnect();
});

describeFn('a WEB row still needs everything it always needed', () => {
    it('accepts a complete Web Push row', async () => {
        // The control: if this failed, every refusal below would be
        // meaningless because nothing of this shape could be written at all.
        await expect(insert({ ...WEB, endpoint: `https://push.example.test/${randomUUID()}` }))
            .resolves.toBeTruthy();
    });

    it.each(['endpoint', 'p256dh', 'auth'])('refuses a WEB row with a null %s', async (col) => {
        // The column is nullable in the schema — this is the CHECK, not the
        // column definition, and it is the whole answer to #1764's expected
        // cost.
        const row = { ...WEB, endpoint: `https://push.example.test/${randomUUID()}` };
        (row as Record<string, string | null>)[col] = null;
        await expect(insert(row)).rejects.toThrow(/web_shape|violates check/i);
    });

    it('refuses a WEB row carrying a device token', async () => {
        // Mutual exclusion, not just presence. A row with both transports'
        // fields would make the deliverer's per-row dispatch ambiguous, and an
        // ambiguous fan-out sends to the wrong transport silently.
        await expect(insert({
            ...WEB,
            endpoint: `https://push.example.test/${randomUUID()}`,
            deviceToken: TOKEN,
        })).rejects.toThrow(/web_shape|violates check/i);
    });
});

describeFn('an IOS row needs a token and nothing else', () => {
    it('accepts a token-only row', async () => {
        await expect(insert({
            platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: `${randomUUID()}`,
        })).resolves.toBeTruthy();
    });

    it('refuses an IOS row with no token', async () => {
        await expect(insert({
            platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: null,
        })).rejects.toThrow(/ios_shape|violates check/i);
    });

    it.each(['endpoint', 'p256dh', 'auth'])('refuses an IOS row carrying %s', async (col) => {
        const row: Record<string, string | null> = {
            platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: `${randomUUID()}`,
        };
        row[col] = col === 'endpoint' ? 'https://push.example.test/x' : 'v';
        await expect(insert(row)).rejects.toThrow(/ios_shape|violates check/i);
    });
});

describeFn('the two unique indexes do not interfere', () => {
    it('allows MANY ios rows for one user — their endpoints are all NULL', async () => {
        // The property that let the existing unique index stay untouched, and
        // the reason this migration is strictly additive. Postgres treats
        // NULLs as distinct, so `[tenantId, userId, endpoint]` does not
        // collapse a person's phones into one row. If this failed, every APNs
        // user would be limited to a single device and the cause would be an
        // index nobody changed.
        await expect(insert({
            platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: `${randomUUID()}`,
        })).resolves.toBeTruthy();
        await expect(insert({
            platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: `${randomUUID()}`,
        })).resolves.toBeTruthy();
    });

    it('refuses the SAME device token twice for one user', async () => {
        const token = `${randomUUID()}`;
        await insert({ platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: token });
        await expect(insert({
            platform: 'IOS', endpoint: null, p256dh: null, auth: null, deviceToken: token,
        })).rejects.toThrow(/ios_identity|duplicate key/i);
    });

    it('still refuses the same web endpoint twice for one user', async () => {
        // The pre-existing guarantee, asserted because this migration touched
        // the columns it is built on. Nullability must not have turned a real
        // constraint into a no-op.
        const endpoint = `https://push.example.test/${randomUUID()}`;
        await insert({ ...WEB, endpoint });
        await expect(insert({ ...WEB, endpoint })).rejects.toThrow(/endpoint_key|duplicate key/i);
    });
});

describeFn('the platform column cannot hold a value nobody handles', () => {
    it('refuses an unknown platform', async () => {
        // An enum rather than TEXT + CHECK, so the type is the guard. Pinned
        // because a future "just make it a string" would silently admit a
        // platform the deliverer has no branch for, and a row nobody can send
        // to looks exactly like a row nobody has subscribed.
        await expect(insert({
            platform: 'ANDROID', endpoint: null, p256dh: null, auth: null, deviceToken: TOKEN,
        })).rejects.toThrow(/invalid input value for enum|PushPlatform/i);
    });
});
