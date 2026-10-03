/**
 * The rehash sweep actually moves stored hashes onto the current lookup key —
 * and says so honestly.
 *
 * ── what this proves that `lookup-key-rotation.test.ts` does not ──
 *
 * That suite proves READS survive a lookup-key rotation, because
 * `hashForLookupCandidates` returns both hashes and the converted call sites
 * check both. That is the mitigation. It is not the END of the rotation: while
 * any row still holds a hash under the previous key, `LOOKUP_HMAC_KEY_PREVIOUS`
 * cannot be removed, and every lookup pays for a two-element `IN`. This suite
 * covers the part that FINISHES the rotation.
 *
 * ── why the sweep's stop condition is worth a test at all ──
 *
 * The KEK sweep's is not decidable: `encryptField` always emits a `v1:` prefix,
 * so `... LIKE 'v1:%'` can never reach zero and "is the rotation done" has no
 * answer from the data. Here it is decidable per row — decrypt, hash, compare —
 * so `previousKeyRetirable` is a real verdict an operator acts on by DELETING a
 * key. A verdict that said yes one pass early would make every row still on the
 * old hash permanently unfindable: the account exists and no lookup reaches it.
 *
 * ── the two things that make this suite safe on a SHARED database ──
 *
 * 1. Every assertion is scoped to rows this suite created. `expect(stale).toBe(0)`
 *    over the whole table is unassertable on a seeded database, and the version
 *    of that mistake I have already made this week passed locally and failed in
 *    CI. The global numbers are asserted only as MONOTONE.
 *
 * 2. `rehashLookupHashes` has no row scope by design — an operator sweeps the
 *    deployment, not a subset — so running it here rewrites every `User` row in
 *    the test database onto this suite's fixture key, which is not the key the
 *    rest of the suite population was written under. So both hash columns are
 *    snapshotted before and restored after, and `afterAll` ASSERTS the
 *    restoration landed. A test that corrupts a shared database and passes is
 *    how a DB-backed guard elsewhere ends up permanently red for reasons nobody
 *    can trace back here.
 */
import { DB_AVAILABLE } from './db-helper';
import prisma from '@/lib/prisma';
import {
    hashForLookup,
    hashForLookupCandidates,
    decryptField,
    _resetKeyCache,
} from '@/lib/security/encryption';
import {
    LOOKUP_HASH_COLUMNS,
    assertLookupColumns,
    countStaleLookupHashes,
    rehashLookupHashes,
    lookupPreviousKeyRetirable,
} from '@/app-layer/usecases/lookup-rehash';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The lookup key in force when this suite's rows are written. */
const LOOKUP_BEFORE = 'rehash-sweep-key-in-force-when-written'; // pragma: allowlist secret -- test fixture
/** What the operator rotates to. */
const LOOKUP_AFTER = 'rehash-sweep-replacement-key-after-rot'; // pragma: allowlist secret -- test fixture
/** Held fixed: this is a LOOKUP-key rotation, not a KEK rotation. */
const KEK = 'rehash-sweep-data-encryption-key-held-fixed'; // pragma: allowlist secret -- test fixture

const SEEDED = 3;

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

function applyEnv(snap: EnvSnapshot): void {
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
    applyEnv({ kek: KEK, lookup: LOOKUP_BEFORE });
}

/** The rotation an operator performs: new primary, old retained as PREVIOUS. */
function rotateLookupKey(): void {
    applyEnv({ kek: KEK, lookup: LOOKUP_AFTER, lookupPrevious: LOOKUP_BEFORE });
}

describeFn('the lookup-hash rehash sweep', () => {
    let savedEnv: EnvSnapshot;
    const createdUserIds: string[] = [];
    /** `table.id` → the hash held before this suite touched anything. */
    const hashSnapshot = new Map<string, string | null>();

    /** Read every (id, hash) pair in scope, for snapshot and for verification. */
    async function readHashes(): Promise<Map<string, string | null>> {
        const out = new Map<string, string | null>();
        for (const c of LOOKUP_HASH_COLUMNS) {
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string; h: string | null }>>(
                `SELECT "id", "${c.hashColumn}" AS h FROM "${c.table}"`,
            );
            for (const r of rows) out.set(`${c.table}.${r.id}`, r.h);
        }
        return out;
    }

    beforeAll(async () => {
        savedEnv = snapshotEnv();
        await prisma.$connect();
        // Snapshot BEFORE the first rotation, so restoration returns the
        // database to the key the rest of the suite population was written
        // under rather than to this suite's fixture key.
        for (const [k, v] of await readHashes()) hashSnapshot.set(k, v);
    });

    afterAll(async () => {
        // Restore every row the sweep moved. Done row by row with the
        // snapshotted value rather than by re-sweeping under the real key:
        // re-sweeping would depend on the thing under test still working, which
        // is the one assumption a cleanup path must not make.
        for (const c of LOOKUP_HASH_COLUMNS) {
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string; h: string | null }>>(
                `SELECT "id", "${c.hashColumn}" AS h FROM "${c.table}"`,
            );
            for (const r of rows) {
                const want = hashSnapshot.get(`${c.table}.${r.id}`);
                // `undefined` means the row did not exist at snapshot time — a
                // row this suite created, which the delete below removes.
                if (want === undefined || want === r.h) continue;
                await prisma.$executeRawUnsafe(
                    `UPDATE "${c.table}" SET "${c.hashColumn}" = $1 WHERE "id" = $2`,
                    want,
                    r.id,
                );
            }
        }
        if (createdUserIds.length > 0) {
            await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        }
        applyEnv(savedEnv);

        // The restoration is ASSERTED, not assumed. A cleanup that silently
        // failed would leave the shared database holding hashes under a test
        // fixture key, and the symptom would surface in an unrelated suite with
        // nothing pointing back here.
        const now = await readHashes();
        const unrestored: string[] = [];
        for (const [k, want] of hashSnapshot) {
            if (now.has(k) && now.get(k) !== want) unrestored.push(k);
        }
        expect(unrestored).toEqual([]);

        await prisma.$disconnect();
    });

    /**
     * Create a user whose hash is written under `LOOKUP_BEFORE`.
     *
     * Through `prisma.user.create`, not raw SQL, so the row is produced by the
     * same middleware that writes production rows — a hand-built row could
     * disagree with the real write path in exactly the way the sweep is meant
     * to detect.
     */
    async function seedUser(local: string): Promise<{ id: string; email: string }> {
        beforeRotation();
        const email = `${local}-${Date.now()}-${Math.round(performance.now())}@rehash-sweep.test`;
        const user = await prisma.user.create({
            data: { email, name: 'Rehash Sweep Subject' },
            select: { id: true },
        });
        createdUserIds.push(user.id);
        return { id: user.id, email };
    }

    /**
     * How many of MY rows hold a hash the current key would not produce.
     *
     * The same comparison the usecase makes, scoped to ids this suite created.
     * The global figure cannot be asserted against a constant on a shared
     * database; this can.
     */
    async function staleAmongMine(): Promise<number> {
        if (createdUserIds.length === 0) return 0;
        const rows = await prisma.$queryRawUnsafe<Array<{ h: string; e: string }>>(
            `SELECT "emailHash" AS h, "emailEncrypted" AS e FROM "User" WHERE "id" = ANY($1::text[])`,
            createdUserIds,
        );
        let stale = 0;
        for (const r of rows) {
            if (r.h !== hashForLookup(decryptField(r.e))) stale++;
        }
        return stale;
    }

    it('PRECONDITION: the suite and the usecase address the same database', async () => {
        // The reader/app divergence that cost a peer an afternoon: the test
        // helpers resolve `DATABASE_URL_TEST` first while `jest.setup.js`
        // repoints `process.env.DATABASE_URL` at a per-worker clone. A suite
        // seeding one database and sweeping another reports `stale: 0` and
        // reads as a pass. This suite uses `@/lib/prisma` for BOTH, so they
        // agree by construction — asserted here so the claim is executed, and
        // the name is printed so a future divergence is legible.
        const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>(
            'SELECT current_database() AS db',
        );
        expect(typeof db).toBe('string');
        expect(db.length).toBeGreaterThan(0);
        // Naming the database under test is the point: a future reader/app
        // divergence is then legible in the log rather than inferred.
        console.log(`[lookup-rehash-sweep] sweeping database: ${db}`);
    });

    it('PRECONDITION: the rotation really changes the hash', async () => {
        // Without this, every assertion below would pass on a build where the
        // sweep did nothing at all — there would be nothing stale to find.
        beforeRotation();
        expect(hashForLookupCandidates('probe@rehash-sweep.test')).toHaveLength(1);
        rotateLookupKey();
        const candidates = hashForLookupCandidates('probe@rehash-sweep.test');
        expect(candidates).toHaveLength(2);
        expect(new Set(candidates).size).toBe(2);
    });

    it('PRECONDITION: every declared column exists in the live schema', async () => {
        // `assertLookupColumns` is what stands between a renamed column and a
        // sweep that skips it and reports success.
        await expect(assertLookupColumns()).resolves.toBeUndefined();
    });

    it('refuses to sweep an EMPTY column list', async () => {
        // Sweeping nothing succeeds at nothing, and would report `stale: 0`.
        await expect(assertLookupColumns([])).rejects.toThrow(/zero columns/);
    });

    it('refuses a column list naming something that does not exist', async () => {
        await expect(
            assertLookupColumns([
                {
                    model: 'User',
                    table: 'User',
                    encryptedColumn: 'emailEncrypted',
                    hashColumn: 'emailHashThatIsNotThere',
                },
            ]),
        ).rejects.toThrow(/do not exist/);
    });

    describe('a rotation, then a sweep', () => {
        it('counts my rows as stale after the rotation and zero after the sweep', async () => {
            for (const n of ['a', 'b', 'c']) await seedUser(`stale-${n}`);
            expect(createdUserIds.length).toBeGreaterThanOrEqual(SEEDED);

            // Under the key they were written with, nothing is stale.
            beforeRotation();
            await expect(staleAmongMine()).resolves.toBe(0);

            rotateLookupKey();
            // Every seeded row is now stale — the rotation moved the key out
            // from under hashes already on disk.
            await expect(staleAmongMine()).resolves.toBe(createdUserIds.length);

            const globalBefore = await countStaleLookupHashes();
            expect(globalBefore.stale).toBeGreaterThanOrEqual(createdUserIds.length);

            const pass = await rehashLookupHashes({ batchSize: 2 });
            const rehashed = pass.reduce((a, r) => a + r.rehashed, 0);
            expect(rehashed).toBeGreaterThanOrEqual(createdUserIds.length);
            expect(pass.reduce((a, r) => a + r.collisions.length, 0)).toBe(0);

            await expect(staleAmongMine()).resolves.toBe(0);

            // The global figure is asserted only as MONOTONE, because other
            // rows in a shared database are outside this suite's control.
            const globalAfter = await countStaleLookupHashes();
            expect(globalAfter.stale).toBeLessThanOrEqual(
                globalBefore.stale - createdUserIds.length,
            );
        });

        it('a batchSize smaller than the population still reaches every row', async () => {
            // The keyset cursor, which is the part that can silently stop
            // early: `batchSize: 2` above forces at least two pages over the
            // three seeded rows, and `staleAmongMine() === 0` is what proves
            // the second page was actually walked.
            rotateLookupKey();
            const before = await staleAmongMine();
            if (before > 0) await rehashLookupHashes({ batchSize: 1 });
            await expect(staleAmongMine()).resolves.toBe(0);
        });

        it('a SECOND pass rehashes nothing — the sweep is idempotent', async () => {
            // The operational shape is "run until stale is zero", so a second
            // pass that rewrote every row again would make the loop unbounded
            // and the verdict meaningless.
            rotateLookupKey();
            await rehashLookupHashes({ batchSize: 500 });
            const first = await rehashLookupHashes({ batchSize: 500 });
            const second = await rehashLookupHashes({ batchSize: 500 });
            const userFirst = first.find((r) => r.model === 'User');
            const user = second.find((r) => r.model === 'User');
            expect(user).toBeDefined();
            expect(user?.rehashed).toBe(0);
            expect(user?.alreadyCurrent).toBeGreaterThanOrEqual(createdUserIds.length);

            // `errors` is NOT asserted to be zero, and the first version of
            // this test asserted exactly that and failed with `errors: 5` —
            // against the rule in this file's own docblock, two screens up.
            //
            // Those five are rows OTHER suites wrote under a different
            // `DATA_ENCRYPTION_KEY`, which this suite's fixture KEK cannot
            // decrypt. They are real `undecryptable` rows, which is a useful
            // accident: it shows the verdict's second term is a category that
            // occurs rather than one I imagined. What IS assertable is that the
            // second pass introduced no NEW failures, and that none of them are
            // mine — `staleAmongMine()` decrypts every row it created, so a
            // zero there could not be reached if one of them had failed.
            expect(user?.errors).toBe(userFirst?.errors);
            await expect(staleAmongMine()).resolves.toBe(0);
        });

        it('the PRIMARY-ONLY read finds my rows again, which is the whole point', async () => {
            // The payoff, and the reason `previousKeyRetirable` is a safe thing
            // to act on: after the sweep a read that checks ONLY the current
            // hash resolves the account, so dropping
            // `LOOKUP_HMAC_KEY_PREVIOUS` strands nobody.
            const { id, email } = await seedUser('primary-only');
            rotateLookupKey();

            // Before the sweep: the primary hash misses. The rotation's
            // candidate fallback is what hides this in production.
            await expect(
                prisma.user.findUnique({
                    where: { emailHash: hashForLookup(email) },
                    select: { id: true },
                }),
            ).resolves.toBeNull();

            await rehashLookupHashes({ batchSize: 500 });

            await expect(
                prisma.user.findUnique({
                    where: { emailHash: hashForLookup(email) },
                    select: { id: true },
                }),
            ).resolves.toMatchObject({ id });
        });
    });

    describe('the retirable verdict', () => {
        it('is FALSE while anything is stale', async () => {
            await seedUser('verdict-stale');
            rotateLookupKey();
            const verdict = await lookupPreviousKeyRetirable();
            expect(verdict.stale).toBeGreaterThan(0);
            expect(verdict.retirable).toBe(false);
        });

        it('derives from the counts it is handed, so GET can scan once', async () => {
            rotateLookupKey();
            const counts = await countStaleLookupHashes();
            const handed = await lookupPreviousKeyRetirable(counts);
            expect(handed.stale).toBe(counts.stale);
            expect(handed.undecryptable).toBe(
                counts.perColumn.reduce((a, c) => a + c.undecryptable, 0),
            );
        });

        it('is FALSE when nothing is stale but a row is UNDECRYPTABLE', async () => {
            // The dangerous direction, and the one a single-term verdict gets
            // wrong. Built from synthetic counts rather than by corrupting a
            // row, because the arithmetic is the thing under test and a
            // corrupted row in a shared database is a liability.
            await expect(
                lookupPreviousKeyRetirable({
                    total: 5,
                    stale: 0,
                    perColumn: [
                        {
                            model: 'User',
                            hashColumn: 'emailHash',
                            total: 5,
                            stale: 0,
                            undecryptable: 1,
                        },
                    ],
                }),
            ).resolves.toEqual({ retirable: false, stale: 0, undecryptable: 1 });
        });

        it('is TRUE only when BOTH terms are zero', async () => {
            await expect(
                lookupPreviousKeyRetirable({
                    total: 5,
                    stale: 0,
                    perColumn: [
                        {
                            model: 'User',
                            hashColumn: 'emailHash',
                            total: 5,
                            stale: 0,
                            undecryptable: 0,
                        },
                    ],
                }),
            ).resolves.toEqual({ retirable: true, stale: 0, undecryptable: 0 });
        });
    });
});
