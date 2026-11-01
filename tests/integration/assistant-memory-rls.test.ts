/**
 * Assistant memory — the RLS policies, under `app_user` (#2671).
 *
 * TABLES ONLY shipped in this release, so there is no usecase to drive yet.
 * That makes this suite the whole proof, and the standing rule for a new model
 * is explicit: an integration test under `app_user` with NEGATIVE CONTROLS
 * (an outsider reads 0 rows; a forged writer gets 42501).
 *
 * ## §1 is the one that matters, and it is #1664 avoided rather than repeated
 *
 * `AssistantMemoryFact` carries TWO SELECT arms, one per session variable,
 * because the row is read from two different runners:
 *
 *   · the ASSISTANT reads the profile mid-answer, inside a tenant transaction
 *     -> `runInTenantContext` sets `app.actor_user_id`
 *   · «Какво помни асистентът» reads it person-scoped under /api/account/**
 *     -> `runInUserContext` sets `app.user_id`
 *
 * #1664 is what one arm costs: `UserBlock`'s policy keyed on `app.user_id`
 * while enforcement ran under `app.actor_user_id`, so it selected from an
 * empty view and returned false for every pair, always, with nothing erroring.
 * The two arms admit the SAME person in the two contexts, so they widen
 * nothing — and §1 proves both rather than asserting the SQL reads right.
 *
 * ## Why every assertion counts rows instead of expecting a throw
 *
 * P5.1's finding, and it applies to each negative below: with no permissive
 * policy for a command, the rows to change are selected by a USING clause that
 * is effectively false, so an UPDATE or DELETE affects ZERO rows and returns
 * normally. Only INSERT raises (42501, on the WITH CHECK). So a negative that
 * asserted "it threw" would pass for the wrong reason on two of the three.
 *
 * ## The positive control, which is what makes a zero mean anything
 *
 * A silently-unset session variable also produces zero. So §0 counts the same
 * rows through the PRIVILEGED client first: if that is not 1, every refusal
 * below is measuring an empty table rather than a policy.
 *
 * Raw SQL throughout, deliberately: these columns are in `ENCRYPTED_FIELDS`
 * and a read through the extended client would try to decrypt. The subject
 * here is the POLICY, and the encryption declarations have their own guards.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext, runInUserContext } from '@/lib/db-context';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const tenants: string[] = [];
const memberships: string[] = [];
const facts: string[] = [];
const conversations: string[] = [];

async function makeUser(label: string): Promise<string> {
    const id = `u-2671-${label}-${randomUUID()}`;
    const email = `${id}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, encryptField(email), hashForLookup(email),
    );
    users.push(id);
    return id;
}

async function makeTenantWith(userId: string): Promise<string> {
    const id = `t-2671-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Tenant"("id","name","slug","updatedAt") VALUES ($1,'Farm',$2,NOW())`,
        id, `f2671-${randomUUID()}`.slice(0, 40),
    );
    tenants.push(id);
    const mid = `tm-2671-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "TenantMembership"("id","tenantId","userId","role","status","updatedAt")
         VALUES ($1,$2,$3,'EDITOR','ACTIVE',NOW())`,
        mid, id, userId,
    );
    memberships.push(mid);
    return id;
}

async function makeFact(userId: string): Promise<string> {
    const id = `amf-2671-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "AssistantMemoryFact"
             ("id","userId","text","sourceQuote","sourceAt","updatedAt")
         VALUES ($1,$2,'отглежда пшеница','Отглеждам пшеница.',NOW(),NOW())`,
        id, userId,
    );
    facts.push(id);
    return id;
}

/** A conversation plus one turn, in `tenantId`. */
async function makeConversationWithTurn(tenantId: string, userId: string): Promise<string> {
    const cid = `ac-2671-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "AssistantConversation"("id","tenantId","userId") VALUES ($1,$2,$3)`,
        cid, tenantId, userId,
    );
    conversations.push(cid);
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "AssistantTurn"("id","tenantId","conversationId","role","content")
         VALUES ($1,$2,$3,'user','какво съм записал')`,
        `at-2671-${randomUUID()}`, tenantId, cid,
    );
    return cid;
}

const userCtx = (userId: string) => ({ userId, requestId: `r-${randomUUID()}` }) as never;
const tenantCtx = (userId: string, tenantId: string) =>
    ({ userId, tenantId, requestId: `r-${randomUUID()}`, role: 'EDITOR' }) as never;

/** Count this person's facts through whichever runner the caller opened. */
async function countFacts(db: unknown, userId: string): Promise<number> {
    const rows = await (db as PrismaClient).$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "AssistantMemoryFact" WHERE "userId" = $1`,
        userId,
    );
    return Number(rows[0].n);
}

describeFn('#2671 — assistant memory RLS', () => {
    let owner = ''; let outsider = '';
    let ownerTenant = ''; let outsiderTenant = '';
    let factId = '';

    beforeAll(async () => {
        await globalPrisma.$connect();
        owner = await makeUser('owner');
        outsider = await makeUser('outsider');
        ownerTenant = await makeTenantWith(owner);
        outsiderTenant = await makeTenantWith(outsider);
        factId = await makeFact(owner);
        await makeConversationWithTurn(ownerTenant, owner);
    });

    afterAll(async () => {
        const del = async (table: string, col: string, ids: string[]) => {
            if (ids.length === 0) return;
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[])`, ids,
            );
        };
        // Turns cascade from conversations; conversations and facts first.
        await del('AssistantConversation', 'id', conversations);
        await del('AssistantMemoryFact', 'id', facts);
        await del('TenantMembership', 'id', memberships);
        await del('Tenant', 'id', tenants);
        await del('User', 'id', users);
        await globalPrisma.$disconnect();
    });

    it('§0 CONTROL: the fixture row exists at all, read privileged', async () => {
        // Without this every refusal below could be measuring an empty table.
        expect(await countFacts(globalPrisma, owner)).toBe(1);
    });

    it('§1 the owner reads their own fact in BOTH contexts — the #1664 property', async () => {
        const viaUser = await runInUserContext(userCtx(owner), (db) => countFacts(db, owner));
        const viaTenant = await runInTenantContext(
            tenantCtx(owner, ownerTenant), (db) => countFacts(db, owner),
        );
        // Reported together, because 1-and-0 is the exact #1664 shape and a
        // bare `toBe(1)` on one of them would not show which arm is missing.
        expect({ viaUser, viaTenant }).toEqual({ viaUser: 1, viaTenant: 1 });
    });

    it('§2 an OUTSIDER reads zero, in both contexts', async () => {
        const viaUser = await runInUserContext(userCtx(outsider), (db) => countFacts(db, owner));
        const viaTenant = await runInTenantContext(
            tenantCtx(outsider, outsiderTenant), (db) => countFacts(db, owner),
        );
        expect({ viaUser, viaTenant }).toEqual({ viaUser: 0, viaTenant: 0 });
    });

    it('§3 app_user cannot INSERT a fact — 42501 on the missing WITH CHECK', async () => {
        // The one negative that RAISES, because INSERT is checked by
        // `WITH CHECK` and there is no permissive arm for it. This is what
        // stops a caller forging a fact about somebody else.
        const attempt = runInUserContext(userCtx(owner), (db) =>
            (db as PrismaClient).$executeRawUnsafe(
                `INSERT INTO "AssistantMemoryFact"
                     ("id","userId","text","sourceQuote","sourceAt","updatedAt")
                 VALUES ($1,$2,'forged','forged',NOW(),NOW())`,
                `amf-forge-${randomUUID()}`, owner,
            ),
        );
        await expect(attempt).rejects.toThrow(/42501|row-level security/i);
    });

    it('§4 app_user cannot DELETE its own fact — SILENTLY zero, not a throw', async () => {
        // P5.1's finding: with no permissive DELETE arm the statement affects
        // zero rows and returns normally. «Изтрий» therefore goes through the
        // privileged client in a usecase, which is also what lets rule 5 keep
        // the row as a tombstone instead of really deleting it.
        const affected = await runInUserContext(userCtx(owner), (db) =>
            (db as PrismaClient).$executeRawUnsafe(
                `DELETE FROM "AssistantMemoryFact" WHERE "id" = $1`, factId,
            ),
        );
        expect(affected).toBe(0);
        // And it is still there — the refusal was real, not a no-op delete of
        // a row that had already gone.
        expect(await countFacts(globalPrisma, owner)).toBe(1);
    });

    it('§MUTATION: dropping the actor arm reproduces #1664, and only that arm', async () => {
        /*
         * The proof that TWO arms are load-bearing rather than decorative,
         * run INSIDE the suite because the suite's database is a per-worker
         * clone — mutating it from outside is not possible, and a mutation
         * applied to the wrong database proves nothing (I tried the base at
         * :5435 first and found no policies there at all, which is the tell).
         *
         * Restored in `finally`, so a failing assertion cannot leave the
         * clone without the policy for the tests after it.
         */
        const dropped = await (async () => {
            await globalPrisma.$executeRawUnsafe(
                `DROP POLICY IF EXISTS memory_fact_owner_read_actor ON "AssistantMemoryFact"`,
            );
            const names = await globalPrisma.$queryRawUnsafe<Array<{ policyname: string }>>(
                `SELECT policyname FROM pg_policies WHERE tablename = 'AssistantMemoryFact'`,
            );
            return names.map((r) => r.policyname);
        })();
        // ASSERT APPLIED. A mutation that silently did not take would make
        // every number below a restatement of the passing case.
        expect(dropped).not.toContain('memory_fact_owner_read_actor');

        try {
            const viaTenant = await runInTenantContext(
                tenantCtx(owner, ownerTenant), (db) => countFacts(db, owner),
            );
            const viaUser = await runInUserContext(userCtx(owner), (db) => countFacts(db, owner));
            // THE #1664 SHAPE, exactly: the person's own row vanishes in the
            // context the assistant actually runs in, while the other context
            // still sees it. Nothing errors. That asymmetry is the whole
            // reason the second arm exists.
            expect({ viaTenant, viaUser }).toEqual({ viaTenant: 0, viaUser: 1 });
        } finally {
            await globalPrisma.$executeRawUnsafe(
                `CREATE POLICY memory_fact_owner_read_actor ON "AssistantMemoryFact"
                     FOR SELECT
                     USING ("userId" = current_setting('app.actor_user_id', true)::text)`,
            );
        }

        // And restored, so the mutation did not quietly weaken what follows.
        const back = await runInTenantContext(
            tenantCtx(owner, ownerTenant), (db) => countFacts(db, owner),
        );
        expect(back).toBe(1);
    });

    it('§5 a turn is TENANT-isolated, and its own tenant can read it', async () => {
        const mine = await runInTenantContext(tenantCtx(owner, ownerTenant), async (db) => {
            const r = await (db as PrismaClient).$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT count(*)::bigint AS n FROM "AssistantTurn"`,
            );
            return Number(r[0].n);
        });
        const theirs = await runInTenantContext(
            tenantCtx(outsider, outsiderTenant), async (db) => {
                const r = await (db as PrismaClient).$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT count(*)::bigint AS n FROM "AssistantTurn"`,
                );
                return Number(r[0].n);
            },
        );
        // Both directions: 1 proves the policy admits the owning farm, 0
        // proves it refuses the other. A pair of zeros would mean the tenant
        // variable was never set and the test proved nothing.
        expect({ mine, theirs }).toEqual({ mine: 1, theirs: 0 });
    });
});
