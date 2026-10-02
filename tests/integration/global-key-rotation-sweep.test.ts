/**
 * After the global sweep, `DATA_ENCRYPTION_KEY_PREVIOUS` can be removed without
 * losing data. That sentence is the whole point of this file, and before P1.1 +
 * this sweep it was not true of a single production row.
 *
 * ── the two things being proved together ──
 *
 * 1. **The sweep moves master-KEK ciphertext onto the new key**, including the
 *    columns the per-tenant job cannot reach — `User` and `Account` have no
 *    `tenantId`, and the whole PII manifest is absent from `ENCRYPTED_FIELDS`.
 * 2. **It does not touch the lookup HASH.** `emailHash` derives from
 *    `LOOKUP_HMAC_KEY`, pinned by P1.1, so a KEK rotation leaves it alone and
 *    nothing needs rehashing. If that were wrong, every sign-in would break and
 *    registration would start minting duplicates.
 *
 * ── and the control, which is what makes the rest mean anything ──
 *
 * Every positive assertion below would also pass on a build where the sweep did
 * nothing — if the test simply never removed the previous key. So a third row
 * is inserted AFTER the sweep, crafted under the old key, representing a value
 * the sweep never saw. With `_PREVIOUS` gone the swept rows decrypt and that one
 * does NOT. Same removal, opposite outcomes, in one run.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    encryptField,
    decryptField,
    hashForLookup,
    isV1UnderPrimaryKey,
    _resetKeyCache,
} from '@/lib/security/encryption';
import {
    sweepGlobalKeyRotation,
    countUnmigrated,
    type SweepFilter,
} from '@/app-layer/usecases/global-key-rotation';

/**
 * This test's own columns, and the scoping is NOT cosmetic.
 *
 * An unfiltered sweep re-encrypts every master-KEK value in the database it is
 * pointed at. Correct in production; destructive here — jest clones one
 * database per WORKER and several suites share it in sequence, so an unscoped
 * run would rewrite unrelated suites' rows under this file's test key and they
 * would fail to decrypt afterwards. Caught by the full-suite sweep: run alone
 * this file passed 8/8, and in the full run it failed on totals that included
 * other suites' rows.
 *
 * It also means NO AGGREGATE ZERO is assertable from here, and column-scoping
 * is not enough to fix that: other suites' `User` and `Account` rows live in
 * the very columns this test sweeps, encrypted under the dev fallback key.
 * Measured in the full run — 42 of them, which the sweep correctly counts as
 * errors (it cannot decrypt them) and as `remaining` (they are not on the
 * primary key). Both numbers are RIGHT and neither is about this test.
 *
 * So `totalErrors === 0` and `remaining === 0` are production signals, not test
 * assertions: production has one key history, so there is no foreign ciphertext
 * and the figures do reach zero. Here the headline property is proved per-ROW
 * instead — what the rows themselves do when the previous key is removed —
 * which is a stronger claim than a count anyway.
 */
const MINE: readonly SweepFilter[] = [
    { model: 'User', column: 'emailEncrypted' },
    { model: 'User', column: 'nameEncrypted' },
    { model: 'Account', column: 'accessTokenEncrypted' },
];

const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** The KEK in force when the rows are written. */
const K_OLD = 'the-outgoing-master-kek-32-chars-or-more!!'; // pragma: allowlist secret -- test fixture
/** What the operator rotates TO. */
const K_NEW = 'the-incoming-master-kek-32-chars-or-more!!'; // pragma: allowlist secret -- test fixture
/** Pinned by P1.1 and INDEPENDENT of both KEKs — that is the mechanism. */
const K_LOOKUP = 'the-pinned-lookup-key-32-chars-or-more!!!!'; // pragma: allowlist secret -- test fixture

interface Subject {
    id: string;
    email: string;
    emailHash: string;
    token: string;
}

describeFn('the global sweep makes the previous KEK retirable', () => {
    const saved = { ...process.env };
    const createdUsers: string[] = [];
    const createdAccounts: string[] = [];
    let swept: Subject;
    let sweptToo: Subject;

    function useKeys(primary: string, previous?: string): void {
        process.env.DATA_ENCRYPTION_KEY = primary;
        if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
        else process.env.DATA_ENCRYPTION_KEY_PREVIOUS = previous;
        process.env.LOOKUP_HMAC_KEY = K_LOOKUP;
        _resetKeyCache();
    }

    /**
     * Insert a user + OAuth account with ciphertext under whatever KEK is
     * primary RIGHT NOW. Raw SQL so neither middleware intervenes — the whole
     * question is which bytes are in the column.
     */
    async function seedSubject(label: string): Promise<Subject> {
        const id = `u-gkr-${label}-${randomUUID()}`;
        const email = `gkr-${label}-${randomUUID()}@sweep.test`;
        const token = `oauth-access-token-${label}-${randomUUID()}`;
        const emailHash = hashForLookup(email);
        await raw.$executeRawUnsafe(
            `INSERT INTO "User"("id","emailEncrypted","emailHash","nameEncrypted","updatedAt")
             VALUES ($1,$2,$3,$4,NOW())`,
            id,
            encryptField(email),
            emailHash,
            encryptField(`Name ${label}`),
        );
        createdUsers.push(id);

        // `Account` is the other tenantId-less PII model, and its columns hold
        // third-party OAuth credentials — the most consequential thing in the
        // population the old sweep could not reach.
        const accountId = `a-gkr-${label}-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "Account"("id","userId","type","provider","providerAccountId","accessTokenEncrypted")
             VALUES ($1,$2,'oauth','google',$3,$4)`,
            accountId,
            id,
            `pa-${randomUUID()}`,
            encryptField(token),
        );
        createdAccounts.push(accountId);

        return { id, email, emailHash, token };
    }

    async function columnOf(table: string, column: string, id: string): Promise<string> {
        const rows = await raw.$queryRawUnsafe<Array<{ v: string }>>(
            `SELECT "${column}" AS v FROM "${table}" WHERE id = $1`,
            id,
        );
        return rows[0].v;
    }

    beforeAll(async () => {
        await raw.$connect();
        // Written under the OLD key, as production rows were.
        useKeys(K_OLD);
        swept = await seedSubject('a');
        sweptToo = await seedSubject('b');
    });

    afterAll(async () => {
        if (createdAccounts.length) {
            await raw.$executeRawUnsafe(`DELETE FROM "Account" WHERE id = ANY($1::text[])`, createdAccounts);
        }
        if (createdUsers.length) {
            await raw.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1::text[])`, createdUsers);
        }
        process.env = { ...saved };
        _resetKeyCache();
        await raw.$disconnect();
    });

    it('before the sweep, the rotated-to key CANNOT read the rows', async () => {
        useKeys(K_NEW, K_OLD);
        const cipher = await columnOf('User', 'emailEncrypted', swept.id);
        // Still a `v1:` envelope — which is exactly why `LIKE 'v1:%'` cannot
        // serve as a progress signal and `isV1UnderPrimaryKey` has to exist.
        expect(cipher.startsWith('v1:')).toBe(true);
        expect(isV1UnderPrimaryKey(cipher)).toBe(false);
        // The previous-key fallback is what keeps the product working meanwhile.
        expect(decryptField(cipher)).toBe(swept.email);

        const { total } = await countUnmigrated(MINE);
        expect(total).toBeGreaterThanOrEqual(4); // 2 users x (email, name) at least
    });

    it('the sweep reports work, and reports that a rotation was in flight', async () => {
        useKeys(K_NEW, K_OLD);
        const result = await sweepGlobalKeyRotation({ batchSize: 50, only: MINE });

        // `rotationInFlight: false` would mean the run could not have migrated
        // anything off an old key — a rewritten count from such a run reads
        // like progress it is not making.
        expect(result.rotationInFlight).toBe(true);
        // `filtered` is what stops a scoped run's zero being read as
        // "the previous key is retirable deployment-wide".
        expect(result.filtered).toBe(true);
        expect(result.columns).toBe(MINE.length);
        expect(result.totalRewritten).toBeGreaterThanOrEqual(4);
        // NOT `totalErrors === 0` / `remaining === 0`: see the MINE docblock.
        // Other suites' rows in these same columns are encrypted under the dev
        // fallback key, so the sweep correctly counts them as undecryptable and
        // unmigrated. Asserting zero here would be asserting that this test runs
        // alone, which it does not.
        //
        // What IS assertable is that MY rows were moved, and the next test reads
        // them back column by column.
        expect(result.perColumn.map((c) => `${c.model}.${c.column}`).sort()).toEqual([
            'Account.accessTokenEncrypted',
            'User.emailEncrypted',
            'User.nameEncrypted',
        ]);
    });

    it('every swept column now reads under the PRIMARY key alone', async () => {
        useKeys(K_NEW, K_OLD);
        for (const s of [swept, sweptToo]) {
            for (const [table, column] of [
                ['User', 'emailEncrypted'],
                ['User', 'nameEncrypted'],
            ] as const) {
                expect(isV1UnderPrimaryKey(await columnOf(table, column, s.id))).toBe(true);
            }
        }
        // And `Account` — the tenantId-less model holding OAuth credentials.
        for (const accountId of createdAccounts) {
            expect(isV1UnderPrimaryKey(await columnOf('Account', 'accessTokenEncrypted', accountId))).toBe(true);
        }
    });

    it('THE LOOKUP HASH IS UNCHANGED — nothing needed rehashing', async () => {
        useKeys(K_NEW, K_OLD);
        const rows = await raw.$queryRawUnsafe<Array<{ emailHash: string }>>(
            `SELECT "emailHash" FROM "User" WHERE id = $1`,
            swept.id,
        );
        // The P1.1 payoff. Had the lookup hash tracked the KEK, this value would
        // have had to move too — and nothing in the rotation path rehashes it,
        // which is the defect P1.1 removed.
        expect(rows[0].emailHash).toBe(swept.emailHash);
        // And it still equals what the running code computes for that address.
        expect(hashForLookup(swept.email)).toBe(swept.emailHash);
    });

    it('a second sweep is a no-op — it converges instead of churning forever', async () => {
        useKeys(K_NEW, K_OLD);
        const again = await sweepGlobalKeyRotation({ batchSize: 50, only: MINE });
        // Every row is already under the primary key, so nothing is rewritten.
        // The old job's `LIKE 'v1:%'` filter would have re-encrypted all of
        // them again and reported it as work.
        expect(again.totalRewritten).toBe(0);
        expect(again.totalAlreadyPrimary).toBeGreaterThanOrEqual(4);
        // `remaining` still counts other suites' foreign ciphertext — see above.
        // `totalRewritten === 0` is the convergence claim, and it is the one
        // that fails if the already-under-primary check is removed.
    });

    it('DECISIVE: with _PREVIOUS removed the swept rows still decrypt', async () => {
        useKeys(K_NEW); // no previous key at all
        for (const s of [swept, sweptToo]) {
            expect(decryptField(await columnOf('User', 'emailEncrypted', s.id))).toBe(s.email);
        }
        for (const accountId of createdAccounts.slice(0, 2)) {
            expect(decryptField(await columnOf('Account', 'accessTokenEncrypted', accountId))).toMatch(
                /^oauth-access-token-/,
            );
        }
        // No aggregate assertion: the decrypts above ARE the property. A count
        // over these columns necessarily includes other suites' rows.
    });

    it('CONTROL: a row the sweep never saw does NOT survive that removal', async () => {
        // Crafted under the OLD key and inserted AFTER the sweep, so it stands
        // for a column the sweep missed. Without this, every assertion above
        // would also pass on a build where the sweep did nothing.
        useKeys(K_OLD);
        const unsweptCipher = encryptField('never-swept@sweep.test');
        const unsweptHash = hashForLookup('never-swept@sweep.test');
        const id = `u-gkr-unswept-${randomUUID()}`;
        await raw.$executeRawUnsafe(
            `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt") VALUES ($1,$2,$3,NOW())`,
            id,
            unsweptCipher,
            unsweptHash,
        );
        createdUsers.push(id);

        useKeys(K_NEW); // no previous key
        const cipher = await columnOf('User', 'emailEncrypted', id);
        expect(isV1UnderPrimaryKey(cipher)).toBe(false);
        expect(() => decryptField(cipher)).toThrow();

        // And `countUnmigrated` SEES it — so the completion signal is not a
        // constant that happens to read zero.
        const { total } = await countUnmigrated(MINE);
        expect(total).toBeGreaterThanOrEqual(1);
    });
});

describe('the DB gate is visible when it skips', () => {
    it('says so rather than passing silently', () => {
        if (!DB_AVAILABLE) {
            console.warn(
                '[global-key-rotation-sweep] SKIPPED — no database. This is the only place ' +
                    '"DATA_ENCRYPTION_KEY_PREVIOUS is retirable after the sweep" is proved; the ' +
                    'unit tests cover the column union and the predicate, neither of which ' +
                    'establishes that a real row survives the removal. INTEGRATION_REQUIRE_DB=1 ' +
                    'makes absence a failure.',
            );
        }
        expect(typeof DB_AVAILABLE).toBe('boolean');
    });
});
