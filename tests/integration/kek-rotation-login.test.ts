/**
 * The master KEK can be rotated without stranding anybody. Proved, not argued.
 *
 * ── the defect this exists for ──
 *
 * `hashForLookup` derived its HMAC key from `DATA_ENCRYPTION_KEY`, and the
 * rotation job (`src/app-layer/jobs/key-rotation.ts`) re-encrypts `v1:`
 * ciphertexts and re-wraps per-tenant DEKs — it contains zero references to
 * that hash path. So every `User.emailHash` in the database was computed under
 * the old key, and after a rotation every lookup by email missed.
 *
 * The failure was NOT a clean error, which is what made it expensive:
 *
 *   · sign-in reports no such user;
 *   · password reset, email verification, invite redemption and SCIM matching
 *     all fail to find existing accounts;
 *   · **registration SUCCEEDS and creates a DUPLICATE `User`**, because its
 *     uniqueness check is the same `emailHash` that now misses.
 *
 * Silent data corruption, not an outage. CLAUDE.md therefore carried a banner
 * saying the master KEK must not be rotated at all.
 *
 * ── why this is an INTEGRATION test and not a unit test ──
 *
 * The unit tests (`tests/unit/lookup-key-bootstrap.test.ts`) prove the derived
 * BYTES do not move. That is necessary and not sufficient: the claim that
 * matters is that a row written before the rotation is still FOUND after it,
 * through the real Prisma client, the real `pii-middleware` WHERE rewrite and
 * the real `@unique` constraint. A hash that matches in a unit test and a row
 * that is reachable are different propositions, and the duplicate-user half
 * can only be observed against a database with the constraint in place.
 *
 * ── the negative control is the point ──
 *
 * Every assertion below would also pass on a build where nothing was fixed, if
 * the test simply never rotated the key. So the final block UNPINS the lookup
 * key and proves the damage is real and reproducible: with the bootstrap in
 * play, the same rotation makes the user unfindable and lets a duplicate in.
 * A green run of the positive half alone would be worthless.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { hashForLookup, _resetKeyCache } from '@/lib/security/encryption';
import type { PrismaClient } from '@prisma/client';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The KEK in force when the rows below are written. */
const KEK_BEFORE = 'kek-in-force-when-the-rows-were-written-32+'; // pragma: allowlist secret -- test fixture
/** What an operator rotates TO — e.g. after a key exposure. */
const KEK_AFTER = 'the-replacement-kek-after-a-rotation-32+++++'; // pragma: allowlist secret -- test fixture

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

/** Put the process in the pre-rotation state. */
function beforeRotation(pinLookupKey: boolean): void {
    process.env.DATA_ENCRYPTION_KEY = KEK_BEFORE;
    delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
    if (pinLookupKey) process.env.LOOKUP_HMAC_KEY = KEK_BEFORE;
    else delete process.env.LOOKUP_HMAC_KEY;
    delete process.env.LOOKUP_HMAC_KEY_PREVIOUS;
    _resetKeyCache();
}

/**
 * Perform the rotation an operator would: new primary, old key as PREVIOUS so
 * existing ciphertext still decrypts. `LOOKUP_HMAC_KEY` is deliberately NOT
 * touched — leaving it behind is the entire mechanism.
 */
function rotateKek(): void {
    process.env.DATA_ENCRYPTION_KEY = KEK_AFTER;
    process.env.DATA_ENCRYPTION_KEY_PREVIOUS = KEK_BEFORE;
    _resetKeyCache();
}

describeFn('rotating the master KEK leaves every lookup by email working', () => {
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

    /** Write a user under the PRE-rotation keys and return its id + email. */
    async function seedUser(local: string, pinLookupKey: boolean): Promise<{ id: string; email: string }> {
        beforeRotation(pinLookupKey);
        const email = `${local}-${Date.now()}@kek-rotation.test`;
        const user = await prisma.user.create({
            data: { email, name: 'Rotation Subject' },
            select: { id: true },
        });
        createdUserIds.push(user.id);
        return { id: user.id, email };
    }

    it('PINNED: a user written before the rotation is still found after it', async () => {
        const { id, email } = await seedUser('pinned-find', true);

        rotateKek();

        // TWO shapes, because the product uses both and they reach the hash
        // column by different routes:
        //
        //   · `emailHash: hashForLookup(email)` — what all sixteen explicit
        //     call sites do (`credentials.ts:188`, `:218`, `:255`, …). These
        //     compute the hash THEMSELVES, so the middleware never sees the
        //     plain field and never rewrites anything.
        //   · `where: { email }` — what NextAuth's PrismaAdapter and the
        //     usecases that pass a plain address do; `pii-middleware` rewrites
        //     it. `findUnique` cannot take it (the Prisma schema has no unique
        //     `email`), so that path is a `findFirst`.
        const byHash = await prisma.user.findUnique({
            where: { emailHash: hashForLookup(email) },
            select: { id: true },
        });
        expect(byHash?.id).toBe(id);

        const byPlain = await prisma.user.findFirst({ where: { email }, select: { id: true } });
        expect(byPlain?.id).toBe(id);
    });

    it('PINNED: registration does not create a duplicate after the rotation', async () => {
        const { id, email } = await seedUser('pinned-dup', true);

        rotateKek();

        // `/api/auth/register`'s uniqueness check is this lookup, in exactly
        // this shape. If it misses, the route proceeds and writes a second row
        // for the same person — the expensive half of the original defect.
        const existing = await prisma.user.findUnique({
            where: { emailHash: hashForLookup(email) },
            select: { id: true },
        });
        expect(existing?.id).toBe(id);

        // And the constraint itself still refuses, which is the backstop that
        // would have contained the damage if the lookup were wrong.
        await expect(
            prisma.user.create({ data: { email, name: 'Impostor' }, select: { id: true } }),
        ).rejects.toThrow();

        const count = await prisma.user.count({ where: { email } });
        expect(count).toBe(1);
    });

    it('PINNED: the stored hash is byte-identical before and after', async () => {
        beforeRotation(true);
        const email = 'stability@kek-rotation.test';
        const before = hashForLookup(email);
        rotateKek();
        expect(hashForLookup(email)).toBe(before);
    });

    it('PINNED: the row is reachable by every shape the product uses', async () => {
        const { id, email } = await seedUser('pinned-shapes', true);
        rotateKek();

        // findUnique by hash — the sixteen explicit call sites.
        expect(
            (await prisma.user.findUnique({
                where: { emailHash: hashForLookup(email) },
                select: { id: true },
            }))?.id,
        ).toBe(id);
        // findFirst on the plain field — the middleware-rewrite path.
        expect((await prisma.user.findFirst({ where: { email }, select: { id: true } }))?.id).toBe(id);
        // { equals } — the shape some usecases build.
        expect(
            (await prisma.user.findFirst({ where: { email: { equals: email } }, select: { id: true } }))?.id,
        ).toBe(id);
        // { in } — SCIM and invite matching batch addresses.
        const many = await prisma.user.findMany({ where: { email: { in: [email] } }, select: { id: true } });
        expect(many.map((u) => u.id)).toEqual([id]);
        // count — the uniqueness pre-checks.
        expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('PINNED: the ciphertext is still readable, via the previous-KEK fallback', async () => {
        const { id, email } = await seedUser('pinned-plaintext', true);
        rotateKek();

        // Separate property from the hash: the EMAIL column is ciphertext under
        // the old KEK, and `decryptField` falls back on an AES-GCM auth
        // failure. If this regressed, a found row would decrypt to nothing and
        // the fix would be half a fix.
        const found = await prisma.user.findUnique({ where: { id }, select: { email: true } });
        expect(found?.email).toBe(email);
    });

    describe('NEGATIVE CONTROL — the damage is real when the key is NOT pinned', () => {
        it('bootstrapped: the same rotation makes the user unfindable', async () => {
            const { id, email } = await seedUser('unpinned-find', false);

            rotateKek();
            // Still unpinned, so the lookup key moved with the KEK.
            expect(process.env.LOOKUP_HMAC_KEY).toBeUndefined();

            const found = await prisma.user.findUnique({
                where: { emailHash: hashForLookup(email) },
                select: { id: true },
            });
            // This is the original defect, reproduced on demand. Without this
            // assertion every test above would also pass on a build where
            // nothing was fixed.
            expect(found).toBeNull();
            // The middleware path misses identically — it derives from the same
            // material, so neither route is a way out.
            expect(await prisma.user.findFirst({ where: { email }, select: { id: true } })).toBeNull();

            // And the row is still THERE — nothing was deleted, it is merely
            // unreachable by email, which is why the failure was silent.
            const byId = await prisma.user.findUnique({ where: { id }, select: { id: true } });
            expect(byId?.id).toBe(id);
        });

        it('bootstrapped: registration would create a DUPLICATE', async () => {
            const { id, email } = await seedUser('unpinned-dup', false);

            rotateKek();

            // The uniqueness pre-check misses...
            expect(
                await prisma.user.findUnique({
                    where: { emailHash: hashForLookup(email) },
                    select: { id: true },
                }),
            ).toBeNull();

            // ...and the create SUCCEEDS, because the `@unique` constraint is
            // on the HASH, and the hash is now a different value. Two rows,
            // one person, no error anywhere. This is the assertion that makes
            // the banner's "silent data corruption" wording literal.
            const impostor = await prisma.user.create({
                data: { email, name: 'Impostor' },
                select: { id: true },
            });
            createdUserIds.push(impostor.id);
            expect(impostor.id).not.toBe(id);

            // Both rows exist, and only the NEW one is findable.
            const nowFound = await prisma.user.findUnique({
                where: { emailHash: hashForLookup(email) },
                select: { id: true },
            });
            expect(nowFound?.id).toBe(impostor.id);
        });
    });
});

describe('the DB gate is visible when it skips', () => {
    it('says so rather than passing silently', () => {
        if (!DB_AVAILABLE) {
            // No eslint-disable: `no-console` does not apply under tests/, so a
            // directive here would be unused — itself a lint finding.
            console.warn(
                '[kek-rotation-login] SKIPPED — no database. This suite is the only ' +
                    'place the duplicate-User half of the P1.1 defect is observable, ' +
                    'because it needs the @unique constraint. A green run without it ' +
                    'proves the derived bytes are stable and NOTHING about reachability. ' +
                    'Set INTEGRATION_REQUIRE_DB=1 to make absence a failure.',
            );
        }
        expect(typeof DB_AVAILABLE).toBe('boolean');
    });
});
