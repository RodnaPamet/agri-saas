/**
 * P5.9 — a suspension takes effect on the NEXT request (#1600).
 *
 * The exit criterion is worded to forbid the test I would otherwise have
 * written: *"proven by a test that measures it rather than asserting the
 * mechanism exists."* A test that checks `suspendedAt` was set, or that
 * `isAccountSuspended` returns true, asserts the mechanism. What has to be
 * measured is that a request which SUCCEEDED before the suspension FAILS after
 * it, with no step in between.
 *
 * So each case here does the same three things: call through
 * `getSessionOrThrow` and observe it resolve, suspend, call again and observe
 * it refuse. The before-call is not decoration — without it, "refused after
 * suspension" is equally consistent with a session that never worked.
 *
 * `auth()` is mocked because the credential is not what is under test; the
 * database is real because `suspendedAt`, the session rows and the cache
 * invalidation are.
 */
/**
 * #1677 — these cases assert the CODE, not the message.
 *
 * They used `rejects.toThrow('ACCOUNT_SUSPENDED')`, which matches against the
 * message, and passed only because the message WAS the token. When #1677 gave
 * it an English sentence all six went red at once — looking like a suspension
 * regression and actually being six tests pinned to prose.
 *
 * What they mean is "this is the suspension refusal", and the code is the
 * stable subject for that: a client can translate a code, while the message is
 * the English fallback and is replaced per-locale by `localizeErrorPayload`
 * before any reader sees it. Asserting the code tests the contract; asserting
 * the message tested the wording.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({
    auth: () => auth(),
    authOptions: {},
    buildSessionClaims: jest.fn(),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { getSessionOrThrow } from '@/lib/auth';
import { suspendAccount, liftSuspension } from '@/app-layer/usecases/account-suspension';
import { invalidateSuspensionCache } from '@/lib/auth/suspension';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];

async function makeUser(): Promise<string> {
    const id = `u-p59-${randomUUID()}`;
    const email = `p59-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, encryptField(email), hashForLookup(email),
    );
    users.push(id);
    return id;
}

/** A live operational session row, so revocation has something to revoke. */
async function makeSession(userId: string): Promise<string> {
    const sessionId = `sess-p59-${randomUUID()}`;
    // `expiresAt` is REQUIRED with no database default, and the column is
    // `lastActiveAt` rather than `lastSeenAt` — both of which I got wrong
    // first, and both of which fail loudly rather than silently.
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "UserSession"
           ("id","sessionId","userId","createdAt","lastActiveAt","expiresAt")
         VALUES ($1,$2,$3,NOW(),NOW(),NOW() + INTERVAL '1 day')`,
        `usrow-${randomUUID()}`, sessionId, userId,
    );
    return sessionId;
}

/** Make `auth()` answer as this user, the way a signed-in request would. */
function signedInAs(userId: string): void {
    auth.mockResolvedValue({
        user: { id: userId, tenantId: null, role: 'READER', mfaPending: false },
    });
}

describeFn('P5.9 — a suspension takes effect on the next request (#1600)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    beforeEach(() => { auth.mockReset(); });

    afterAll(async () => {
        if (users.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "UserSession" WHERE "userId" = ANY($1::text[])`, users);
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "User" WHERE "id" = ANY($1::text[])`, users);
        }
        await globalPrisma.$disconnect();
    });

    it('MEASURES the window: resolves before, refuses after, nothing in between', async () => {
        const userId = await makeUser();
        signedInAs(userId);

        // Before. This is the control: without it, the refusal below is
        // equally consistent with a session that never worked.
        await expect(getSessionOrThrow()).resolves.toMatchObject({ userId });

        await suspendAccount({ userId, generation: 'current', reason: 'measured' });

        // After. No refresh, no re-login, no waiting — the very next call.
        await expect(getSessionOrThrow()).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });

    it('refuses with a DISTINCT code, not unauthorized', async () => {
        const userId = await makeUser();
        signedInAs(userId);
        await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });

        // A suspended person must be told their account was suspended, not
        // that they are signed out — a 401 would send them to a login page
        // that signs them back in and refuses again, naming nothing.
        await expect(getSessionOrThrow()).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
        await expect(getSessionOrThrow()).rejects.not.toThrow('Unauthorized');
    });

    it('stamps the operational session rows revoked, so the console agrees', async () => {
        const userId = await makeUser();
        await makeSession(userId);
        await makeSession(userId);

        const result = await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });

        expect(result.sessionsRevoked).toBe(2);
        const live = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "UserSession"
             WHERE "userId" = $1 AND "revokedAt" IS NULL`, userId);
        expect(Number(live[0].n)).toBe(0);
    });

    it('bumps sessionVersion too, so the SLOW path also ends the session', async () => {
        // Belt and braces, and deliberately redundant: if the per-request fast
        // path were ever bypassed, the throttled `sessionVersion` check still
        // revokes within its 5-minute window.
        const userId = await makeUser();
        const before = await globalPrisma.$queryRawUnsafe<Array<{ v: number }>>(
            `SELECT "sessionVersion" AS v FROM "User" WHERE "id" = $1`, userId);

        await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });

        const after = await globalPrisma.$queryRawUnsafe<Array<{ v: number }>>(
            `SELECT "sessionVersion" AS v FROM "User" WHERE "id" = $1`, userId);
        expect(after[0].v).toBe(before[0].v + 1);
    });

    it('is IDEMPOTENT and does not move the original timestamp', async () => {
        const userId = await makeUser();
        await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });
        const first = await globalPrisma.$queryRawUnsafe<Array<{ s: Date }>>(
            `SELECT "suspendedAt" AS s FROM "User" WHERE "id" = $1`, userId);

        const second = await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });

        expect(second.alreadySuspended).toBe(true);
        const again = await globalPrisma.$queryRawUnsafe<Array<{ s: Date }>>(
            `SELECT "suspendedAt" AS s FROM "User" WHERE "id" = $1`, userId);
        // That timestamp is what an appeal and a regulator date from, so
        // re-suspending must not quietly extend the record.
        expect(again[0].s.getTime()).toBe(first[0].s.getTime());
    });

    it('LIFTING restores access on the next request', async () => {
        const userId = await makeUser();
        signedInAs(userId);
        await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });
        await expect(getSessionOrThrow()).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });

        await liftSuspension({ userId, generation: 'current' });

        // An appeal upheld is exactly the moment a person should have their
        // account back — a stale cached verdict would hold them out for the
        // remaining TTL, which is why lifting invalidates it too.
        await expect(getSessionOrThrow()).resolves.toMatchObject({ userId });
    });

    it('does not suspend an account that does not exist', async () => {
        const result = await suspendAccount({
            userId: `u-p59-missing-${randomUUID()}`,
            generation: 'current',
            reason: 'repeat abuse',
        });
        expect(result.applied).toBe(false);
    });

    it('leaves OTHER accounts alone', async () => {
        const victim = await makeUser();
        const bystander = await makeUser();
        signedInAs(bystander);

        await suspendAccount({ userId: victim, generation: 'current', reason: 'repeat abuse' });

        // The check is keyed on the caller's own id; a shared key would be a
        // platform-wide outage dressed as a suspension.
        await expect(getSessionOrThrow()).resolves.toMatchObject({ userId: bystander });
    });

    it('refuses on a second consecutive request too', async () => {
        // NOTE what this does NOT prove. I wrote it as "a cached
        // NOT-suspended verdict cannot outlive the suspension" and it was
        // vacuous: there is no `REDIS_URL` in `.env.test`, so `getRedis()`
        // returns null here and the cache path — including its invalidation —
        // is dead code in this suite. Dropping the invalidation reddened
        // nothing.
        //
        // The cache is covered by `tests/unit/suspension-cache.test.ts` (the
        // helper) and `tests/unit/account-suspension-wiring.test.ts` (that
        // anybody calls it), both with Redis mocked so its availability is an
        // input rather than an accident of the environment.
        //
        // What this still earns: the refusal is not a one-shot. A check that
        // somehow consumed its own state would pass the measurement above and
        // fail here.
        const userId = await makeUser();
        signedInAs(userId);
        await expect(getSessionOrThrow()).resolves.toMatchObject({ userId });

        await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });

        await expect(getSessionOrThrow()).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
        await expect(getSessionOrThrow()).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });

    it('a stale cached SUSPENDED verdict is dropped by an explicit invalidation', async () => {
        // The symmetric case, driven directly: the helper both paths rely on
        // actually clears a positive verdict.
        const userId = await makeUser();
        signedInAs(userId);
        await suspendAccount({ userId, generation: 'current', reason: 'repeat abuse' });
        await expect(getSessionOrThrow()).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });

        await globalPrisma.$executeRawUnsafe(
            `UPDATE "User" SET "suspendedAt" = NULL WHERE "id" = $1`, userId);
        await invalidateSuspensionCache(userId);

        await expect(getSessionOrThrow()).resolves.toMatchObject({ userId });
    });
});
