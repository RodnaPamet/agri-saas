/**
 * `InsuranceLead` RLS — cross-tenant isolation on `inquirerTenantId`. P1.7.
 *
 * ── why this table needed its own suite ──
 *
 * It holds one farm's contact PII — a free-text `message` they wrote, plus the
 * user and tenant who asked — and keys on `inquirerTenantId`, a plain FK that
 * is deliberately NOT a `tenantId` RLS column. The rls-coverage ratchet builds
 * its inventory from models WITH a `tenantId`, so this table sat outside it
 * entirely: `app_user` holds full DML on every table in the schema (migration
 * 20260323180000), and nothing beneath the usecase layer stopped a read.
 *
 * Exactly the shape `PromotionLead` was fixed for in 20260721090000, where the
 * guard's own comment calls it "the failure mode the ratchet exists to
 * prevent". `ExchangeInquiry` is the third instance.
 *
 * ── it was a MISSING BACKSTOP, not a live leak ──
 *
 * Stated precisely, because overstating it would be the easier story. All four
 * call sites in `src/app-layer/usecases/insurance.ts` already filtered
 * correctly — three reads carry `inquirerTenantId: ctx.tenantId` and the
 * create sets it — so no farm could read another's enquiries. What was absent
 * was the DB-side floor under that discipline.
 *
 * The comment at `insurance.ts:312` had the causality backwards: it offered the
 * ABSENCE of RLS as the reason one farm's key cannot return another's lead.
 * The safety came from the `where`. A reader who believed the comment would
 * have had no reason to add one.
 *
 * ── the shape of the assertions ──
 *
 * A write refused by RLS raises 42501 only when the row is VISIBLE. When
 * SELECT hides it the write affects zero rows and returns normally, so "it
 * threw" and "it did nothing" are different outcomes and only one is a
 * refusal. Each negative below therefore asserts the raised code or the ROW
 * COUNT — never merely that the call returned.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * The reader and the app must address the SAME database.
 *
 * `DB_URL` (this suite's own client) and `process.env.DATABASE_URL` (what the
 * app's prisma uses, and therefore what `withTenantDb` / `runInTenantContext`
 * write through) are resolved by DIFFERENT code: `db-helper` applies the
 * per-checkout slot unconditionally, while `jest.setup.js` repoints
 * `DATABASE_URL` at a per-worker clone only when globalSetup wrote a
 * `perWorker` marker. Under default workers they agree. Measured under
 * `--maxWorkers=1` in this checkout they do NOT:
 *
 *     reader  127.0.0.1:5435/agri_saas_test_cde5cee23
 *     app     127.0.0.1:5436/agri_saas        <- the DEV database
 *
 * A suite that seeds with one client and asserts through the other then reads a
 * database its write never reached. Here that happens to fail loudly because
 * 5436 is not listening, but on a machine with a dev database up it would be
 * silent — a count of zero that looks exactly like a clean pass, and writes
 * landing in development data.
 *
 * Found by Agrent backend 1 in `fanout-preflight-counts-v2.test.ts`, where it
 * made the positive control unable to pass locally. Asserted here so this
 * suite can never report a false negative for the same reason.
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
            `Reader and app address DIFFERENT databases, so this suite would ` +
                `assert against a database the app never wrote to:\n` +
                `  reader (DB_URL)            = ${reader}\n` +
                `  app (process.env.DATABASE_URL) = ${app}\n` +
                `Run without --maxWorkers=1, or make jest.setup.js repoint ` +
                `DATABASE_URL unconditionally.`,
        );
    }
}

const TENANT_A = `t-ilead-a-${randomUUID()}`;
const TENANT_B = `t-ilead-b-${randomUUID()}`;
const createdIds: string[] = [];

/**
 * Seed one lead as SUPERUSER, so the fixture is never subject to the policy
 * under test.
 *
 * No Tenant, User or Parcel row is needed: measured on the live schema,
 * `InsuranceLead` carries ZERO foreign-key constraints — `inquirerTenantId`
 * and `inquirerUserId` are plain columns and `parcelId` is documented as
 * "free-form id, no FK". That is the same property that let the table sit
 * outside the tenantId-keyed inventory.
 */
async function seedLead(tenantId: string): Promise<string> {
    const id = `ilead-${randomUUID()}`;
    await globalPrisma.insuranceLead.create({
        data: {
            id,
            inquirerTenantId: tenantId,
            inquirerUserId: `u-${randomUUID()}`,
            parcelId: `parcel-${randomUUID()}`,
            message: `quote request from ${tenantId}`,
        },
    });
    createdIds.push(id);
    return id;
}

describeFn('InsuranceLead RLS — cross-tenant isolation', () => {
    let LEAD_A = '';
    let LEAD_B = '';

    beforeAll(async () => {
        assertReaderAndAppAgree();
        await globalPrisma.$connect();
        LEAD_A = await seedLead(TENANT_A);
        LEAD_B = await seedLead(TENANT_B);
    });

    afterAll(async () => {
        await globalPrisma.insuranceLead.deleteMany({ where: { id: { in: createdIds } } });
        await globalPrisma.$disconnect();
    });

    it('the table is under FORCE RLS with both policies', async () => {
        // The precondition. Without FORCE, the table owner bypasses policies
        // silently and every isolation assertion below would pass for the
        // wrong reason.
        const rows = await globalPrisma.$queryRawUnsafe<
            Array<{ rls: boolean; forced: boolean; policies: bigint }>
        >(`
            SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                   count(p.polname) AS policies
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_policy p ON p.polrelid = c.oid
             WHERE n.nspname = current_schema() AND c.relname = 'InsuranceLead'
             GROUP BY 1, 2`);
        expect(rows).toHaveLength(1);
        expect(rows[0].rls).toBe(true);
        expect(rows[0].forced).toBe(true);
        expect(Number(rows[0].policies)).toBe(2);
    });

    it('app_user sees only its OWN tenant leads', async () => {
        const rows = await withTenantDb(TENANT_A, (tx) =>
            tx.insuranceLead.findMany({
                where: { id: { in: [LEAD_A, LEAD_B] } },
                select: { id: true, inquirerTenantId: true },
            }),
        );
        // Non-zero FIRST: "sees no more than its own" would pass on an empty
        // result and prove nothing.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map((r) => r.id)).toContain(LEAD_A);
        expect(rows.every((r) => r.inquirerTenantId === TENANT_A)).toBe(true);
    });

    it("app_user cannot read another tenant's lead by DIRECT id lookup", async () => {
        // The direct-lookup leak. A filtered list hides the row; RLS has to
        // make it unreachable even when the caller names its id.
        const rows = await withTenantDb(TENANT_A, (tx) =>
            tx.insuranceLead.findMany({ where: { id: LEAD_B }, select: { id: true } }),
        );
        expect(rows).toHaveLength(0);
    });

    it('B reads B — so the zero above is isolation, not a broken fixture', async () => {
        const rows = await withTenantDb(TENANT_B, (tx) =>
            tx.insuranceLead.findMany({ where: { id: LEAD_B }, select: { id: true } }),
        );
        expect(rows.map((r) => r.id)).toContain(LEAD_B);
    });

    it('app_user cannot INSERT a lead attributed to another tenant', async () => {
        // WITH CHECK refuses this one LOUDLY: the proposed row fails the
        // predicate, which is 42501 rather than a silent no-op.
        await expect(
            withTenantDb(TENANT_A, (tx) =>
                tx.insuranceLead.create({
                    data: {
                        id: `ilead-evil-${randomUUID()}`,
                        inquirerTenantId: TENANT_B,
                        inquirerUserId: `u-${randomUUID()}`,
                        parcelId: `parcel-${randomUUID()}`,
                        message: 'attributed to someone else',
                    },
                }),
            ),
        ).rejects.toThrow(/42501|row-level security/i);
    });

    it('app_user CAN insert its own, so the refusal is about attribution', async () => {
        // The positive control for the case above. Without it, a policy that
        // refused every insert would satisfy it.
        const id = `ilead-own-${randomUUID()}`;
        createdIds.push(id);
        await withTenantDb(TENANT_A, (tx) =>
            tx.insuranceLead.create({
                data: {
                    id,
                    inquirerTenantId: TENANT_A,
                    inquirerUserId: `u-${randomUUID()}`,
                    parcelId: `parcel-${randomUUID()}`,
                    message: 'my own lead',
                },
            }),
        );
        const back = await globalPrisma.insuranceLead.findUnique({ where: { id } });
        expect(back?.inquirerTenantId).toBe(TENANT_A);
    });

    it('app_user cannot RE-ATTRIBUTE its own lead to another tenant', async () => {
        // USING passes (the row is mine) and WITH CHECK fails (the proposed
        // row is not), so this is the loud half of the asymmetry.
        await expect(
            withTenantDb(TENANT_A, (tx) =>
                tx.insuranceLead.update({
                    where: { id: LEAD_A },
                    data: { inquirerTenantId: TENANT_B },
                }),
            ),
        ).rejects.toThrow(/42501|row-level security/i);

        // And it really did not move — read back OUTSIDE the policy.
        const back = await globalPrisma.insuranceLead.findUnique({ where: { id: LEAD_A } });
        expect(back?.inquirerTenantId).toBe(TENANT_A);
    });

    it("updating another tenant's lead is a silent ZERO, not an error", async () => {
        // The other half of the RLS shape, and the reason every negative here
        // names a code or a count: SELECT hides B's row from A, so this UPDATE
        // matches nothing and returns normally. Asserting "it threw" would
        // have been wrong, and asserting "it returned" would have proved
        // nothing at all.
        const affected = await withTenantDb(TENANT_A, (tx) =>
            tx.$executeRawUnsafe(
                `UPDATE "InsuranceLead" SET "message" = 'tampered' WHERE id = $1`,
                LEAD_B,
            ),
        );
        expect(affected).toBe(0);
        const back = await globalPrisma.insuranceLead.findUnique({ where: { id: LEAD_B } });
        expect(back?.message).not.toBe('tampered');
    });

    it('superuser still sees every tenant — the privileged bypass works', async () => {
        // FORCE RLS subjects the owner too, so without `superuser_bypass` the
        // seeds, migrations and any future platform-side lead digest would all
        // read zero rows. A policy that broke them would be a false pass.
        const rows = await globalPrisma.insuranceLead.findMany({
            where: { id: { in: [LEAD_A, LEAD_B] } },
            select: { inquirerTenantId: true },
        });
        const distinct = new Set(rows.map((r) => r.inquirerTenantId));
        expect(distinct.has(TENANT_A)).toBe(true);
        expect(distinct.has(TENANT_B)).toBe(true);
    });
});
