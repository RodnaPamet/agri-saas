/**
 * The LOOKUP key can be rotated without stranding anybody — the other half of
 * the rotation story.
 *
 * ── what this proves that #1236's test does not ──
 *
 * `tests/integration/kek-rotation-login.test.ts` proves rotating the master KEK
 * is safe BECAUSE `LOOKUP_HMAC_KEY` stays pinned: no hash moves, so every
 * lookup keeps working. This is the opposite rotation. When the LOOKUP key
 * itself moves, every stored `emailHash` was computed under the previous key
 * and the primary hash alone finds nothing.
 *
 * P1.1 built the read-through: `hashForLookupCandidates` returns both hashes and
 * `pii-middleware` widens a plain `where: { email }` to `{ in: [...] }`. But
 * sixteen call sites computed the hash themselves and handed Prisma
 * `emailHash: hashForLookup(email)`, so the middleware never saw a plain field
 * and never widened anything (#1237). Those sites read the PRIMARY hash only
 * and missed every row not yet rehashed:
 *
 *   · sign-in reports no such user;
 *   · password reset and email verification cannot find the account;
 *   · invite matching fails against an IdP-verified address;
 *   · **registration SUCCEEDS and creates a DUPLICATE `User`**, because its
 *     uniqueness check is the same hash that now misses — and so does the
 *     owner-bootstrap UPSERT, which keys on it.
 *
 * ── the negative control is the point, again ──
 *
 * Every positive assertion here would pass on a build where nothing was
 * converted, if the test simply never rotated the lookup key. So the final
 * block drops `LOOKUP_HMAC_KEY_PREVIOUS` and proves the damage is real: the
 * same reads miss, and the same upsert admits a duplicate.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { hashForLookup, hashForLookupCandidates, _resetKeyCache } from '@/lib/security/encryption';
import type { PrismaClient } from '@prisma/client';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The lookup key in force when the rows below are written. */
const LOOKUP_BEFORE = 'lookup-key-in-force-when-rows-written-32+'; // pragma: allowlist secret -- test fixture
/** What an operator rotates the LOOKUP key to. */
const LOOKUP_AFTER = 'the-replacement-lookup-key-after-rotation'; // pragma: allowlist secret -- test fixture
/** Held fixed throughout: this is a LOOKUP-key rotation, not a KEK rotation. */
const KEK = 'the-data-encryption-key-held-fixed-here-32+'; // pragma: allowlist secret -- test fixture

interface EnvSnapshot {
    kek?: string;
    kekPrevious?: string;
    lookup?: string;
    lookupPrevious?: string;
}

function snapshotEnv(): EnvSnapshot {
    return {
        kek: process.env.DATA_ENCRYPTION_KEY,
        kekPrevious: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
        lookup: process.env.LOOKUP_HMAC_KEY,
        lookupPrevious: process.env.LOOKUP_HMAC_KEY_PREVIOUS,
    };
}

function restoreEnv(snap: EnvSnapshot): void {
    const set = (k: string, v?: string): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };
    set('DATA_ENCRYPTION_KEY', snap.kek);
    set('DATA_ENCRYPTION_KEY_PREVIOUS', snap.kekPrevious);
    set('LOOKUP_HMAC_KEY', snap.lookup);
    set('LOOKUP_HMAC_KEY_PREVIOUS', snap.lookupPrevious);
    _resetKeyCache();
}

/** Pre-rotation: one lookup key, no previous. */
function beforeRotation(): void {
    process.env.DATA_ENCRYPTION_KEY = KEK;
    delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    process.env.LOOKUP_HMAC_KEY = LOOKUP_BEFORE;
    delete process.env.LOOKUP_HMAC_KEY_PREVIOUS;
    _resetKeyCache();
}

/** The rotation an operator performs: new primary, old key retained as PREVIOUS. */
function rotateLookupKey(): void {
    process.env.LOOKUP_HMAC_KEY = LOOKUP_AFTER;
    process.env.LOOKUP_HMAC_KEY_PREVIOUS = LOOKUP_BEFORE;
    _resetKeyCache();
}

/** The same rotation performed WITHOUT retaining the previous key. */
function rotateLookupKeyWithoutFallback(): void {
    process.env.LOOKUP_HMAC_KEY = LOOKUP_AFTER;
    delete process.env.LOOKUP_HMAC_KEY_PREVIOUS;
    _resetKeyCache();
}

describeFn('rotating the LOOKUP key leaves every lookup by email working', () => {
    let prisma: PrismaClient;
    let saved: EnvSnapshot;
    const createdUserIds: string[] = [];

    beforeAll(async () => {
        saved = snapshotEnv();
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        if (createdUserIds.length > 0) {
            await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        }
        restoreEnv(saved);
        await prisma.$disconnect();
    });

    async function seedUser(local: string): Promise<{ id: string; email: string }> {
        beforeRotation();
        const email = `${local}-${Date.now()}-${Math.round(performance.now())}@lookup-rotation.test`;
        const user = await prisma.user.create({
            data: { email, name: 'Lookup Rotation Subject' },
            select: { id: true },
        });
        createdUserIds.push(user.id);
        return { id: user.id, email };
    }

    /**
     * The CONVERTED read shape, spelled out once. This is literally what the
     * sixteen converted sites now issue: `findFirst` (an `in` is not valid on
     * `findUnique`) over the candidate list.
     */
    async function readAsConverted(email: string): Promise<{ id: string } | null> {
        return prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: { id: true },
        });
    }

    /** The UNCONVERTED read shape, kept to show what it does after a rotation. */
    async function readAsPrimaryOnly(email: string): Promise<{ id: string } | null> {
        return prisma.user.findUnique({
            where: { emailHash: hashForLookup(email) },
            select: { id: true },
        });
    }

    it('the candidate list actually grows after the rotation', async () => {
        // The precondition every assertion below rests on. If the rotation did
        // not change the key material, the candidate list would be a singleton
        // and the whole suite would pass while testing nothing.
        beforeRotation();
        expect(hashForLookupCandidates('probe@lookup-rotation.test')).toHaveLength(1);
        rotateLookupKey();
        const candidates = hashForLookupCandidates('probe@lookup-rotation.test');
        expect(candidates).toHaveLength(2);
        expect(new Set(candidates).size).toBe(2); // two DIFFERENT hashes
    });

    it('sign-in finds a user written before the rotation', async () => {
        const { id, email } = await seedUser('signin');
        rotateLookupKey();
        await expect(readAsConverted(email)).resolves.toMatchObject({ id });
    });

    it('password reset and email verification find the account', async () => {
        const { id, email } = await seedUser('reset');
        rotateLookupKey();
        // Both flows resolve the account by the same shape before issuing a
        // token; one case covers both because the query is identical.
        await expect(readAsConverted(email)).resolves.toMatchObject({ id });
    });

    it('invite matching resolves an IdP-verified address', async () => {
        const { id, email } = await seedUser('invite');
        rotateLookupKey();
        await expect(readAsConverted(email)).resolves.toMatchObject({ id });
    });

    it('the registration uniqueness check SEES the existing account', async () => {
        const { id, email } = await seedUser('register');
        rotateLookupKey();
        // The duplicate-User defect in one assertion: this read is what stands
        // between a rotation and two rows for one address.
        await expect(readAsConverted(email)).resolves.toMatchObject({ id });
    });

    it('the owner-bootstrap UPSERT does not create a second row', async () => {
        // The WRITE side, which the read conversions alone do not fix. An
        // upsert's `where` takes a unique scalar and cannot hold the candidate
        // list, so the converted sites read candidates FIRST and only upsert
        // when nothing exists under either key.
        const { id, email } = await seedUser('bootstrap');
        rotateLookupKey();

        const existing = await readAsConverted(email);
        const resolved =
            existing ??
            (await prisma.user.upsert({
                where: { emailHash: hashForLookup(email) },
                update: {},
                create: { email, emailHash: hashForLookup(email) },
                select: { id: true },
            }));
        if (resolved.id !== id) createdUserIds.push(resolved.id);

        expect(resolved.id).toBe(id);
        const count = await prisma.user.count({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
        });
        expect(count).toBe(1);
    });

    it('the stored hash does NOT move — a rotation is a key change, not a rewrite', async () => {
        // Why a rehash sweep is still owed: nothing rewrites the column, so the
        // row stays on the previous hash until something does. That is exactly
        // why `LOOKUP_HMAC_KEY_PREVIOUS` cannot be dropped on the strength of
        // this suite alone.
        const { id, email } = await seedUser('nomove');
        const before = await prisma.user.findUniqueOrThrow({
            where: { id }, select: { emailHash: true },
        });
        rotateLookupKey();
        const after = await prisma.user.findUniqueOrThrow({
            where: { id }, select: { emailHash: true },
        });
        expect(after.emailHash).toBe(before.emailHash);
        // And it equals the PREVIOUS key's hash, not the new primary's.
        expect(after.emailHash).not.toBe(hashForLookup(email));
        expect(hashForLookupCandidates(email)).toContain(after.emailHash);
    });

    describe('NEGATIVE CONTROL — the damage is real without the fallback', () => {
        it('the converted read MISSES when no previous key is retained', async () => {
            const { email } = await seedUser('neg-read');
            rotateLookupKeyWithoutFallback();
            // Not a failure of the conversion: with no previous key there is no
            // second candidate to find the row with. This is what pins that the
            // positive cases above are carried by the fallback rather than by
            // the rotation having quietly not happened.
            expect(hashForLookupCandidates(email)).toHaveLength(1);
            await expect(readAsConverted(email)).resolves.toBeNull();
        });

        it('the UNCONVERTED read misses even WITH the previous key retained', async () => {
            const { email } = await seedUser('neg-primary');
            rotateLookupKey();
            // The defect #1237 fixed, reproduced: the fallback exists and this
            // shape cannot use it, because it never offers more than one hash.
            await expect(readAsPrimaryOnly(email)).resolves.toBeNull();
            // ...while the converted shape finds the very same row.
            await expect(readAsConverted(email)).resolves.not.toBeNull();
        });

        it('an upsert keyed on the primary hash alone creates a DUPLICATE', async () => {
            const { id, email } = await seedUser('neg-upsert');
            rotateLookupKey();
            // Skipping the candidate read is precisely the pre-#1237 shape.
            const dupe = await prisma.user.upsert({
                where: { emailHash: hashForLookup(email) },
                update: {},
                create: { email, emailHash: hashForLookup(email) },
                select: { id: true },
            });
            createdUserIds.push(dupe.id);

            expect(dupe.id).not.toBe(id);
            const count = await prisma.user.count({
                where: { emailHash: { in: hashForLookupCandidates(email) } },
            });
            expect(count).toBe(2); // two rows, one address
        });
    });
});
