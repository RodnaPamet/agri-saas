/**
 * At most one VERIFIED claim per ЕИК — and the database is what enforces it.
 *
 * ## Why this suite exists in the shape it does
 *
 * P3.4 says "unique only where `status='VERIFIED'`" and "collisions go to
 * DISPUTED". Both are easy to satisfy in a way that passes a sequential test
 * and admits two verified claims in production, so this file is built around
 * the two things a sequential test cannot see.
 *
 * **1. A pre-insert check is structurally blind.** RLS scopes reads to the
 * calling tenant, so "is this ЕИК already claimed?" run as `app_user` returns
 * ZERO rows exactly when the incumbent belongs to another farm — i.e. in the
 * only case the check exists for. That is asserted directly below, as the
 * justification for putting the rule in a constraint rather than in the
 * usecase. It is the RLS silent-zero shape: the query succeeds, returns
 * nothing, and the caller concludes the ЕИК is free.
 *
 * **2. Two claims arriving together both pass any read.** Neither is committed
 * when the other looks, so only the index serialises them. The concurrency
 * case fires both inserts without awaiting between them and asserts that
 * exactly one survives — testing the constraint rather than this file's own
 * ordering.
 *
 * ## What is deliberately NOT here
 *
 * The identical-response and timing properties (±50ms over 50 trials) belong
 * to the route, which lands with the claim usecase in a later PR. This table
 * ships first (expand-and-contract), so there is no route to measure yet.
 * Asserting them against a non-existent handler would be a green test for an
 * absent control.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * The reader and the app must address the SAME database.
 *
 * Lifted from `insurance-lead-rls.test.ts`, for the reason recorded there:
 * `DB_URL` applies the per-checkout slot unconditionally while
 * `process.env.DATABASE_URL` is only repointed when globalSetup wrote a
 * `perWorker` marker, so under `--maxWorkers=1` a suite can seed through one
 * client and assert through another. Here that would be worse than a false
 * negative: the concurrency case would report "exactly one insert survived"
 * having run both against a database whose index it never read.
 */
function assertReaderAndAppAgree(): void {
    const name = (u?: string): string => {
        if (!u) return '(unset)';
        const m = u.match(/@([^/]+)\/([^?]+)/);
        return m ? `${m[1]}/${m[2]}` : '(unparsed)';
    };
    const reader = name(DB_URL);
    const app = name(process.env.DATABASE_URL);
    if (reader !== app) {
        throw new Error(
            `Reader and app address DIFFERENT databases:\n` +
                `  reader (DB_URL)                = ${reader}\n` +
                `  app (process.env.DATABASE_URL) = ${app}\n` +
                `Run without --maxWorkers=1.`,
        );
    }
}

const TENANT_A = `t-fic-a-${randomUUID()}`;
const TENANT_B = `t-fic-b-${randomUUID()}`;
const createdIds: string[] = [];

/** A checksum-shaped 9-digit ЕИК. Only its hash is ever stored. */
function anEik(): string {
    return String(100000000 + Math.floor(Math.random() * 899999999));
}

/** Seed as SUPERUSER, so a fixture is never subject to the policy under test. */
async function seedClaim(
    tenantId: string,
    eikHash: string,
    status: 'PENDING' | 'VERIFIED' | 'DISPUTED' | 'REJECTED',
): Promise<string> {
    const id = `fic-${randomUUID()}`;
    await globalPrisma.farmIdentityClaim.create({
        data: {
            id,
            tenantId,
            eikHash,
            status,
            claimedByUserId: `u-${randomUUID()}`,
            ...(status === 'VERIFIED' ? { verifiedAt: new Date() } : {}),
        },
    });
    createdIds.push(id);
    return id;
}

describeFn('FarmIdentityClaim — one VERIFIED claim per ЕИК', () => {
    beforeAll(async () => {
        assertReaderAndAppAgree();
        await globalPrisma.$connect();
        // REAL Tenant rows, not bare id strings. The cases that write through
        // `withTenantDb` go via the app's extended client, so the audit
        // middleware runs and `AuditLog.tenantId` is a foreign key — without a
        // Tenant row the audit write fails with 23503 and is swallowed as a
        // logged error. The assertions still passed, which is the problem: the
        // suite would be reporting on a path whose audit leg never ran, and a
        // later decision to make `FarmIdentityClaim` fail-closed would turn
        // that silent failure into a confusing hard one.
        //
        // `globalPrisma` is a raw client with no audit or encryption
        // extension, so creating a Tenant through it is not itself audited —
        // which is why this does not need a tenant to exist first.
        await globalPrisma.tenant.create({
            data: { id: TENANT_A, name: 'FIC A', slug: TENANT_A },
        });
        await globalPrisma.tenant.create({
            data: { id: TENANT_B, name: 'FIC B', slug: TENANT_B },
        });
    });

    afterAll(async () => {
        // Claims only. The Tenant rows STAY, and they have to:
        //
        //   audit_log_immutable  BEFORE DELETE OR UPDATE ON "AuditLog"
        //   AuditLog_tenantId_fkey ... ON DELETE RESTRICT
        //
        // The audit log is immutable by trigger, so the rows these cases wrote
        // cannot be removed, and RESTRICT then forbids deleting the tenant they
        // point at. Any suite that writes through the audited client is
        // therefore unable to delete its own tenants — by design, not by
        // omission. `ai-usage-event-rls.test.ts` leaves its tenants for the
        // same reason. The ids are per-run UUIDs, so nothing collides across
        // runs.
        //
        // Prisma reports the trigger as "Foreign key constraint violated on
        // the (not available)", which is what sent the first version of this
        // hook looking for a foreign key that was never the problem.
        await globalPrisma.farmIdentityClaim.deleteMany({ where: { id: { in: createdIds } } });
        await globalPrisma.$disconnect();
    });

    // ── Controls ─────────────────────────────────────────────────────

    it('control: the table is under FORCE RLS with all three policies', async () => {
        // Without FORCE, the table owner bypasses policies silently and every
        // isolation assertion below would pass for the wrong reason.
        const rows = await globalPrisma.$queryRawUnsafe<
            Array<{ rls: boolean; forced: boolean; policies: bigint }>
        >(`
            SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                   count(p.polname) AS policies
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_policy p ON p.polrelid = c.oid
             WHERE n.nspname = current_schema() AND c.relname = 'FarmIdentityClaim'
             GROUP BY 1, 2`);
        expect(rows).toHaveLength(1);
        expect(rows[0].rls).toBe(true);
        expect(rows[0].forced).toBe(true);
        // tenant_isolation + tenant_isolation_insert + superuser_bypass.
        expect(Number(rows[0].policies)).toBe(3);
    });

    it('control: the unique index exists and is PARTIAL on VERIFIED', async () => {
        // A FULL unique index would also pass "two VERIFIED rows are refused"
        // while breaking the product: a farm could not retry a claim after a
        // dispute, and two farms could not both have a pending claim on an ЕИК
        // one of them will turn out to own. So the partiality is asserted, not
        // just the uniqueness.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ indexdef: string }>>(`
            SELECT indexdef FROM pg_indexes
             WHERE tablename = 'FarmIdentityClaim'
               AND indexname = 'FarmIdentityClaim_eikHash_verified_key'`);
        expect(rows).toHaveLength(1);
        expect(rows[0].indexdef).toMatch(/UNIQUE/i);
        expect(rows[0].indexdef).toMatch(/WHERE/i);
        expect(rows[0].indexdef).toMatch(/VERIFIED/);
    });

    // ── The rule ─────────────────────────────────────────────────────

    it('a second VERIFIED claim on one ЕИК is refused', async () => {
        const hash = hashForLookup(anEik(), 'eik');
        await seedClaim(TENANT_A, hash, 'VERIFIED');

        await expect(seedClaim(TENANT_B, hash, 'VERIFIED')).rejects.toMatchObject({
            code: 'P2002',
        });
    });

    it('but PENDING claims pile up freely on the same ЕИК', async () => {
        // The positive control for partiality. If this ever starts failing,
        // the index has been widened and two farms can no longer both ask.
        const hash = hashForLookup(anEik(), 'eik');
        await seedClaim(TENANT_A, hash, 'PENDING');
        await seedClaim(TENANT_B, hash, 'PENDING');
        await seedClaim(TENANT_B, hash, 'DISPUTED');

        const n = await globalPrisma.farmIdentityClaim.count({ where: { eikHash: hash } });
        expect(n).toBe(3);
    });

    it('a PENDING claim may coexist with the VERIFIED one', async () => {
        // The state the collision handler produces: an incumbent holds
        // VERIFIED, a late claimant's row survives as DISPUTED alongside it.
        const hash = hashForLookup(anEik(), 'eik');
        await seedClaim(TENANT_A, hash, 'VERIFIED');
        await seedClaim(TENANT_B, hash, 'DISPUTED');

        const rows = await globalPrisma.farmIdentityClaim.findMany({
            where: { eikHash: hash },
            select: { tenantId: true, status: true },
        });
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.status === 'VERIFIED')).toHaveLength(1);
    });

    // ── Why it must be the index and not a pre-check ─────────────────

    it('app_user CANNOT see another tenant’s VERIFIED claim — the silent zero', async () => {
        // THE JUSTIFICATION for the constraint. A usecase that checked
        // "already claimed?" before inserting would run this query and get
        // nothing, then insert happily. The check is not merely racy; it is
        // blind, and it is blind in exactly the cross-tenant case it exists to
        // catch.
        const hash = hashForLookup(anEik(), 'eik');
        await seedClaim(TENANT_A, hash, 'VERIFIED');

        const seenByB = await withTenantDb(TENANT_B, (tx) =>
            tx.farmIdentityClaim.findMany({ where: { eikHash: hash }, select: { id: true } }),
        );
        expect(seenByB).toHaveLength(0);

        // ...and A sees its own, so the zero is isolation rather than a
        // fixture that never landed.
        const seenByA = await withTenantDb(TENANT_A, (tx) =>
            tx.farmIdentityClaim.findMany({ where: { eikHash: hash }, select: { id: true } }),
        );
        expect(seenByA).toHaveLength(1);
    });

    it('app_user cannot plant a claim attributed to another farm', async () => {
        // THIS CASE HAS NO TEETH ON ITS OWN, and the next one is not optional.
        //
        // Measured by dropping policies against the live database: with BOTH
        // `tenant_isolation` and `tenant_isolation_insert` gone, this case
        // still passes. FORCE RLS is on and the only surviving policy is
        // `superuser_bypass`, which is false for `app_user` — so every access
        // is denied and the insert is refused for a reason that has nothing to
        // do with attribution. A refusal is not evidence of a correct refusal.
        //
        // The pair is what carries the meaning: this case says a foreign
        // attribution is refused, and the one below says an own-tenant insert
        // is NOT — which is what fails under total denial. Do not delete the
        // positive control to save a round trip.
        const hash = hashForLookup(anEik(), 'eik');
        await expect(
            withTenantDb(TENANT_A, (tx) =>
                tx.farmIdentityClaim.create({
                    data: {
                        id: `fic-evil-${randomUUID()}`,
                        tenantId: TENANT_B,
                        eikHash: hash,
                        status: 'PENDING',
                        claimedByUserId: `u-${randomUUID()}`,
                    },
                }),
            ),
        ).rejects.toThrow(/42501|row-level security/i);
    });

    it('app_user CAN claim for itself, so the refusal is about attribution', async () => {
        // Positive control: a policy that refused every insert would satisfy
        // the case above.
        const id = `fic-own-${randomUUID()}`;
        createdIds.push(id);
        await withTenantDb(TENANT_A, (tx) =>
            tx.farmIdentityClaim.create({
                data: {
                    id,
                    tenantId: TENANT_A,
                    eikHash: hashForLookup(anEik(), 'eik'),
                    status: 'PENDING',
                    claimedByUserId: `u-${randomUUID()}`,
                },
            }),
        );
        const found = await globalPrisma.farmIdentityClaim.findUnique({ where: { id } });
        expect(found).not.toBeNull();
    });

    // ── The race ─────────────────────────────────────────────────────

    it('two CONCURRENT verified claims: exactly one survives', async () => {
        // The case a sequential test cannot distinguish from a pre-check.
        // Both inserts are in flight before either commits, so no read-based
        // guard could separate them — whichever loses, loses to the index.
        const hash = hashForLookup(anEik(), 'eik');

        const results = await Promise.allSettled([
            seedClaim(TENANT_A, hash, 'VERIFIED'),
            seedClaim(TENANT_B, hash, 'VERIFIED'),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter(
            (r): r is PromiseRejectedResult => r.status === 'rejected',
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        // The loser must lose for the RIGHT reason. Without this the case
        // would pass if one insert failed on a connection error, a timeout, or
        // a typo in the fixture.
        expect(rejected[0].reason).toMatchObject({ code: 'P2002' });

        // And the database agrees with the promises.
        const verified = await globalPrisma.farmIdentityClaim.count({
            where: { eikHash: hash, status: 'VERIFIED' },
        });
        expect(verified).toBe(1);
    });

    it('the incumbent is never demoted by a later claimant', async () => {
        // The griefing case. "Collisions go to DISPUTED" has a reading in
        // which BOTH rows go to DISPUTED, which is even-handed and lets
        // anyone who can type a verified farm's ЕИК knock it out of verified
        // status at will. The claim is not evidence against the incumbent, so
        // only the arriving claim is disputed.
        const hash = hashForLookup(anEik(), 'eik');
        const incumbent = await seedClaim(TENANT_A, hash, 'VERIFIED');

        await expect(seedClaim(TENANT_B, hash, 'VERIFIED')).rejects.toMatchObject({
            code: 'P2002',
        });
        // The arriving claim lands as DISPUTED instead — what the usecase will
        // do on catching P2002.
        await seedClaim(TENANT_B, hash, 'DISPUTED');

        const still = await globalPrisma.farmIdentityClaim.findUnique({
            where: { id: incumbent },
            select: { status: true, verifiedAt: true },
        });
        expect(still?.status).toBe('VERIFIED');
        expect(still?.verifiedAt).not.toBeNull();
    });
});
