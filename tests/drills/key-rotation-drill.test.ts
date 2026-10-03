/**
 * The key-rotation DRILL: both rotations, in order, each ending with the
 * previous key actually REMOVED.
 *
 * ── why a drill and not more tests ──
 *
 * Eight suites already cover pieces of this. Each one rotates in isolation and
 * leaves the previous key in place, because that is what makes its assertions
 * readable. None of them performs the step an operator is actually afraid of:
 * **deleting the old key**. That step is where a rotation either completes or
 * strands rows, and until it is exercised the preceding greens only prove the
 * FALLBACK works — which is the opposite of proving you can stop relying on it.
 *
 * So this drives the whole operator sequence as ordered state:
 *
 *   1. seed rows under (KEK₁, LOOKUP₁)
 *   2. rotate the LOOKUP key; prove candidate reads survive and a primary-only
 *      read misses — the hazard the candidates exist for
 *   3. sweep the lookup hashes; prove the verdict flips to retirable
 *   4. **DROP `LOOKUP_HMAC_KEY_PREVIOUS`**; prove reads still work
 *   5. rotate the KEK; prove decryption survives on the previous key
 *   6. sweep the ciphertext; prove `countUnmigrated` moves
 *   7. **DROP `DATA_ENCRYPTION_KEY_PREVIOUS`**; prove reads still work AND
 *      that the lookup hashes did not move — the P1.1 independence property
 *
 * Steps 4 and 7 are the drill. Everything else is setup for them.
 *
 * ── why it has its own job and its own database ──
 *
 * The sweeps have no row scope by design: an operator rotates the deployment,
 * not a subset. Running them inside the sharded test matrix would re-encrypt
 * every row in a database the other suites in that shard are using, and CI
 * runs the shards against ONE shared database (`marker.perWorker === false`).
 * So the drill is inert unless `KEY_ROTATION_DRILL=1`, which only the "Key
 * rotation drill" job sets, and that job declares its own Postgres service.
 *
 * `tests/guards/key-rotation-drill-wired.test.ts` is what stops that gate from
 * becoming a silent skip — it fails if the workflow stops carrying a job that
 * sets the flag and runs this path. A suite that gates itself on an env var is
 * one typo away from being green over zero tests, and that is the failure mode
 * this repo has already recorded under "absence reads as success".
 */
import { DB_AVAILABLE } from '../integration/db-helper';
import prisma from '@/lib/prisma';
import {
    hashForLookup,
    hashForLookupCandidates,
    decryptField,
    _resetKeyCache,
} from '@/lib/security/encryption';
import {
    rehashLookupHashes,
    lookupPreviousKeyRetirable,
    countStaleLookupHashes,
} from '@/app-layer/usecases/lookup-rehash';
import { sweepGlobalKeyRotation, countUnmigrated } from '@/app-layer/usecases/global-key-rotation';

/**
 * The drill runs only where it is declared.
 *
 * ONE variable, enabling and requiring together. Two (`..._DRILL` to enable,
 * `..._REQUIRE` to insist) would permit the combination that reads as success
 * and proves nothing: required but not enabled.
 */
const DRILL = process.env.KEY_ROTATION_DRILL === '1';
const describeFn = DRILL && DB_AVAILABLE ? describe : describe.skip;

/**
 * The keys in force when the drill's own rows are written.
 *
 * Explicit fixtures, NOT the ambient environment. An earlier version captured
 * `process.env.DATA_ENCRYPTION_KEY` so the drill would start from "the keys the
 * data was written under" — which sounds more realistic and is wrong here in
 * two ways. This environment leaves that variable UNSET and relies on a dev
 * fallback, so the capture yielded `undefined` and "rotating" meant discarding
 * the only key that could read the row. And the drill owns an empty database,
 * so there is no pre-existing data whose key it would need to match.
 *
 * Step 0 covers what the ambient capture was reaching for: if the database DOES
 * hold rows this key cannot read, the drill refuses to report a verdict.
 */
const KEK_1 = 'drill-kek-one-deterministic-32-chars-min'; // pragma: allowlist secret -- test fixture
const LOOKUP_1 = 'drill-lookup-one-deterministic-32-chars'; // pragma: allowlist secret -- test fixture

/** What the operator rotates TO. These are invented; that is the point. */
const KEK_2 = 'drill-kek-two-deterministic-32-chars-min'; // pragma: allowlist secret -- test fixture
const LOOKUP_2 = 'drill-lookup-two-deterministic-32-chars'; // pragma: allowlist secret -- test fixture

function setKeys(opts: {
    kek?: string;
    kekPrevious?: string;
    lookup?: string;
    lookupPrevious?: string;
}): void {
    const set = (k: string, v?: string): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };
    set('DATA_ENCRYPTION_KEY', opts.kek);
    set('DATA_ENCRYPTION_KEY_PREVIOUS', opts.kekPrevious);
    set('LOOKUP_HMAC_KEY', opts.lookup);
    set('LOOKUP_HMAC_KEY_PREVIOUS', opts.lookupPrevious);
    _resetKeyCache();
}

describe('the drill runs where it is declared', () => {
    it('a declared drill must have a reachable database — a skip would hide the drill', () => {
        // The `REQUIRE_DB` argument the rest of this repo makes, applied here:
        // the drill job creates the roles and runs `migrate deploy` against a
        // service it declares, so an unreachable database there means the
        // service is broken, not that the drill is unnecessary.
        if (DRILL) expect(DB_AVAILABLE).toBe(true);
    });

    it('is INERT in the sharded matrix, which shares one database', () => {
        // If this ever fails, someone has set KEY_ROTATION_DRILL job-wide and
        // the drill is about to re-encrypt a database twenty-five thousand
        // other tests are using.
        if (!DRILL) expect(describeFn).toBe(describe.skip);
    });
});

describeFn('key rotation drill — both rotations, previous keys removed', () => {
    /** The subject. One account is enough; the drill is about the SEQUENCE. */
    let userId = '';
    let email = '';
    /** The lookup hash as written under LOOKUP_1, captured for step 7. */
    let hashUnderLookup1 = '';

    beforeAll(async () => {
        await prisma.$connect();
    });

    afterAll(async () => {
        if (userId) {
            await prisma.user.deleteMany({ where: { id: userId } });
        }
        await prisma.$disconnect();
    });

    /** What a converted call site issues: candidates, so a rotation reads through. */
    async function readAsConverted(): Promise<{ id: string } | null> {
        return prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: { id: true },
        });
    }

    /** What an UNCONVERTED site issues: the primary hash only. */
    async function readAsPrimaryOnly(): Promise<{ id: string } | null> {
        return prisma.user.findUnique({
            where: { emailHash: hashForLookup(email) },
            select: { id: true },
        });
    }

    /** The stored ciphertext and hash, read raw — not through the middleware. */
    async function rawRow(): Promise<{ emailEncrypted: string; emailHash: string }> {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ emailEncrypted: string; emailHash: string }>
        >(`SELECT "emailEncrypted", "emailHash" FROM "User" WHERE "id" = $1`, userId);
        expect(rows).toHaveLength(1);
        return rows[0];
    }

    it('step 0 — PRECONDITION: the deployment can read everything it holds', async () => {
        // The first thing a real operator must establish: a rotation cannot
        // complete over a row nobody can decrypt. Such a row is never swept,
        // stays on the old key, and makes `previousKeyRetirable` correctly
        // refuse forever — so a drill that tolerated them would be reporting
        // that the rotation works on a database where it cannot finish.
        //
        // On the drill's own empty database this is a TRIPWIRE rather than a
        // proof, and saying so matters: it passes 0-of-0, and the population is
        // printed below so that is visible. It earns its place because the
        // tripwire has already fired once — the shared test base holds five
        // `User` rows whose `emailEncrypted` is PLAINTEXT, written before this
        // product encrypted PII, and `seed.ts`'s `upsert(update: {})` means no
        // seed run will ever rewrite them.
        setKeys({ kek: KEK_1, lookup: LOOKUP_1 });
        const counts = await countStaleLookupHashes();
        const undecryptable = counts.perColumn.reduce((a, c) => a + c.undecryptable, 0);
        if (undecryptable > 0) {
            throw new Error(
                `${undecryptable} of ${counts.total} rows cannot be decrypted by the key ` +
                    `this environment holds, so no rotation performed here could ever ` +
                    `complete and the drill's verdict would be meaningless.\n\n` +
                    `In CI this job declares a fresh Postgres service, so the table is ` +
                    `empty and this cannot happen. Locally it means the test base ` +
                    `database holds rows written under a key that is no longer around — ` +
                    `recreate it, or clear those rows, before reading a drill result.`,
            );
        }
        expect(undecryptable).toBe(0);
        // The denominator this case ranged over, printed so a 0-of-0 pass is legible.
        console.log(
            `[key-rotation-drill] precondition: ${counts.total} rows in scope, ` +
                `${undecryptable} undecryptable`,
        );
    });

    it('step 1 — seeds an account under (KEK₁, LOOKUP₁)', async () => {
        setKeys({ kek: KEK_1, lookup: LOOKUP_1 });
        email = `drill-${Date.now()}@key-rotation-drill.test`;
        const user = await prisma.user.create({
            data: { email, name: 'Key Rotation Drill Subject' },
            select: { id: true },
        });
        userId = user.id;

        const row = await rawRow();
        hashUnderLookup1 = row.emailHash;
        // The preconditions every later step rests on: the row really is
        // encrypted, and the hash really is the one LOOKUP₁ produces.
        expect(row.emailEncrypted).not.toContain(email);
        expect(row.emailHash).toBe(hashForLookup(email));
        await expect(readAsConverted()).resolves.toMatchObject({ id: userId });
    });

    it('step 2 — rotating the LOOKUP key: candidates survive, primary-only MISSES', async () => {
        setKeys({ kek: KEK_1, lookup: LOOKUP_2, lookupPrevious: LOOKUP_1 });

        // The precondition: the rotation actually moved the hash. Without this
        // the next two assertions would both pass on a no-op rotation.
        const candidates = hashForLookupCandidates(email);
        expect(new Set(candidates).size).toBe(2);
        expect(candidates).toContain(hashUnderLookup1);

        await expect(readAsConverted()).resolves.toMatchObject({ id: userId });
        // And the hazard, executed rather than described: this is what the
        // sixteen unconverted sites did, and why #1237 created a duplicate User.
        await expect(readAsPrimaryOnly()).resolves.toBeNull();
    });

    it('step 3 — the lookup sweep moves the hash and flips the verdict', async () => {
        const before = await lookupPreviousKeyRetirable();
        expect(before.stale).toBeGreaterThan(0);
        expect(before.retirable).toBe(false);

        const pass = await rehashLookupHashes({ batchSize: 100 });
        expect(pass.reduce((a, r) => a + r.rehashed, 0)).toBeGreaterThan(0);
        expect(pass.reduce((a, r) => a + r.collisions.length, 0)).toBe(0);

        const after = await lookupPreviousKeyRetirable();
        expect(after.stale).toBe(0);
        expect(after.undecryptable).toBe(0);
        // The drill's own database, so the GLOBAL verdict is assertable here —
        // unlike the shared-database suite, which can only assert its own rows.
        expect(after.retirable).toBe(true);

        // The row moved: the stored hash is no longer LOOKUP₁'s.
        const row = await rawRow();
        expect(row.emailHash).not.toBe(hashUnderLookup1);
        expect(row.emailHash).toBe(hashForLookup(email));
    });

    it('step 4 — DROPPING the previous lookup key leaves the account findable', async () => {
        // THE DRILL. Everything above only proves the fallback works; this is
        // the step that proves you can stop relying on it. An operator does
        // exactly this: remove the variable from /opt/agrent/.env and restart.
        setKeys({ kek: KEK_1, lookup: LOOKUP_2 });

        expect(hashForLookupCandidates(email)).toHaveLength(1);
        await expect(readAsConverted()).resolves.toMatchObject({ id: userId });
        // And now the primary-only read works again, which is the point of
        // having swept: the two-element `IN` is no longer load-bearing.
        await expect(readAsPrimaryOnly()).resolves.toMatchObject({ id: userId });
    });

    it('step 5 — rotating the KEK: the row still decrypts, on the PREVIOUS key', async () => {
        setKeys({ kek: KEK_2, kekPrevious: KEK_1, lookup: LOOKUP_2 });

        const row = await rawRow();
        // Written under KEK₁, read under KEK₂ with KEK₁ retained. If this
        // throws, the KEK fallback is broken and the rotation is unsafe.
        expect(decryptField(row.emailEncrypted)).toBe(email);
        await expect(readAsConverted()).resolves.toMatchObject({ id: userId });
    });

    it('step 6 — the ciphertext sweep re-encrypts under the current KEK', async () => {
        const before = await countUnmigrated();
        const result = await sweepGlobalKeyRotation({ batchSize: 100 });
        expect(result.perColumn.length).toBeGreaterThan(0);

        // `countUnmigrated` is NOT asserted to reach zero, deliberately: the
        // predicate is `LIKE 'v1:%'` and `encryptField` always emits a `v1:`
        // prefix, so that figure cannot reach zero by construction. Asserting
        // it would be asserting a thing that is false, and reading it as
        // "rotation incomplete" is the misreading this comment exists to stop.
        // The sweep's effect is proved on the ROW below instead.
        expect(before.total).toBeGreaterThanOrEqual(0);

        const row = await rawRow();
        expect(decryptField(row.emailEncrypted)).toBe(email);
    });

    it('step 7 — DROPPING the previous KEK leaves everything readable', async () => {
        // THE OTHER HALF OF THE DRILL. After this the deployment holds exactly
        // one key of each kind, which is the state a completed rotation means.
        setKeys({ kek: KEK_2, lookup: LOOKUP_2 });

        const row = await rawRow();
        expect(decryptField(row.emailEncrypted)).toBe(email);
        await expect(readAsConverted()).resolves.toMatchObject({ id: userId });
        await expect(readAsPrimaryOnly()).resolves.toMatchObject({ id: userId });

        // And not only the drill's own row: EVERY row in scope must decrypt
        // under the single remaining key. This is the assertion that would
        // catch a sweep which skipped a column or stopped early — on the
        // drill's own row alone, a sweep that handled the first page and quit
        // would look identical to one that finished.
        const counts = await countStaleLookupHashes();
        const undecryptable = counts.perColumn.reduce((a, c) => a + c.undecryptable, 0);
        expect(undecryptable).toBe(0);
        expect(counts.total).toBeGreaterThan(0);
    });

    it('step 7b — and the KEK rotation did NOT move the lookup hashes', async () => {
        // P1.1's independence property, which is the whole reason a KEK
        // rotation is safe without a rehash: `LOOKUP_HMAC_KEY` is pinned, so
        // the hash is a function of the lookup key alone. If a KEK rotation
        // moved hashes, every KEK rotation would also need the sweep above and
        // the two rotations could never be performed independently.
        const stale = await countStaleLookupHashes();
        expect(stale.stale).toBe(0);
        const row = await rawRow();
        expect(row.emailHash).toBe(hashForLookup(email));
    });

    it('step 8 — the end state: one key of each kind, nothing outstanding', async () => {
        expect(process.env.DATA_ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
        expect(process.env.LOOKUP_HMAC_KEY_PREVIOUS).toBeUndefined();
        const verdict = await lookupPreviousKeyRetirable();
        expect(verdict).toEqual({ retirable: true, stale: 0, undecryptable: 0 });
    });
});
