/**
 * `ExchangeBlock` RLS — the asymmetry that a single policy cannot express.
 *
 * Like `ExchangeThread`, this table has no `tenantId` column, so the
 * `rls-coverage` inventory never sees it and a full guard sweep passes with it
 * unprotected. Unlike the thread, its two parties need DIFFERENT rights on the
 * same row, and that is the whole reason this file exists:
 *
 *   - the BLOCKED tenant must be able to READ the row naming them. The refusal
 *     is enforced inside their own request, so a row they cannot see cannot
 *     refuse them and the block would silently never fire;
 *   - the blocked tenant must NOT be able to DELETE it, or blocking is a
 *     formality anyone can undo on themselves.
 *
 * A single `POLICY ... USING (...)` cannot do that: one USING clause governs
 * SELECT *and* DELETE, so widening the read to make enforcement work would
 * hand the blocked tenant the eraser. Hence separate per-command policies —
 * and hence this suite, because the two halves look identical in a schema
 * diff and only a live database tells them apart.
 *
 * Note how "cannot delete" is asserted. A DELETE filtered by RLS does not
 * raise: it removes ZERO rows and reports success. Asserting `rejects` would
 * pass against a policy that permitted the delete outright, so what is checked
 * is that the row is STILL THERE afterwards.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantDb } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SELLER = `t-exb-seller-${randomUUID()}`;
const BUYER = `t-exb-buyer-${randomUUID()}`;
const OUTSIDER = `t-exb-outsider-${randomUUID()}`;

const created: string[] = [];

/**
 * One block, against a FRESH blocked tenant each time.
 *
 * Reusing a single pair tripped the `(sellerTenantId, blockedTenantId)` unique
 * index on the second seed — which is the index doing its job, but it made
 * five tests fail for a reason that had nothing to do with the policies they
 * were written to check.
 */
async function seedBlock(): Promise<{ id: string; blocked: string }> {
    const id = `exb-${randomUUID()}`;
    const blocked = `t-exb-blocked-${randomUUID()}`;
    await globalPrisma.exchangeBlock.create({
        data: { id, sellerTenantId: SELLER, blockedTenantId: blocked },
    });
    created.push(id);
    return { id, blocked };
}

/** Rows of `ExchangeBlock` visible to `tenant`, by id. */
const visibleTo = (tenant: string, id: string) =>
    withTenantDb(tenant, async (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM "ExchangeBlock" WHERE id = $1`,
            id,
        ),
    );

describeFn('ExchangeBlock RLS', () => {
    afterAll(async () => {
        if (created.length) {
            await globalPrisma.exchangeBlock.deleteMany({ where: { id: { in: created } } });
        }
        await globalPrisma.$disconnect();
    });

    it('the seller reads the blocks it created', async () => {
        const { id } = await seedBlock();
        expect(await visibleTo(SELLER, id)).toHaveLength(1);
    });

    it('the BLOCKED tenant reads the row naming them — enforcement depends on it', async () => {
        const { id, blocked } = await seedBlock();
        // Not a leak: this is what lets their own open/send be refused. They
        // learn they are blocked the moment they try anything anyway.
        expect(await visibleTo(blocked, id)).toHaveLength(1);
    });

    it('an unrelated tenant reads NOTHING', async () => {
        const { id } = await seedBlock();
        expect(await visibleTo(OUTSIDER, id)).toHaveLength(0);
    });

    it('the blocked tenant CANNOT delete the row — the split that matters', async () => {
        const { id, blocked } = await seedBlock();
        // No throw: a DELETE filtered by RLS removes zero rows and succeeds.
        await withTenantDb(blocked, async (tx) =>
            tx.$executeRawUnsafe(`DELETE FROM "ExchangeBlock" WHERE id = $1`, id),
        );
        // The row is what the assertion is about, not the statement's outcome.
        const survivors = await globalPrisma.exchangeBlock.findMany({ where: { id } });
        expect(survivors).toHaveLength(1);
    });

    it('the SELLER can delete it — the positive control for the same statement', async () => {
        // Without this, a policy refusing every delete would pass the test
        // above and make unblocking impossible.
        const { id } = await seedBlock();
        await withTenantDb(SELLER, async (tx) =>
            tx.$executeRawUnsafe(`DELETE FROM "ExchangeBlock" WHERE id = $1`, id),
        );
        expect(await globalPrisma.exchangeBlock.findMany({ where: { id } })).toHaveLength(0);
    });

    it('a tenant cannot forge a block attributed to someone else as seller', async () => {
        await expect(
            withTenantDb(BUYER, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "ExchangeBlock" (id, "sellerTenantId", "blockedTenantId", "createdAt")
                     VALUES ($1, $2, $3, now())`,
                    `exb-${randomUUID()}`, SELLER, OUTSIDER,
                ),
            ),
        ).rejects.toThrow();
    });

    it('a seller CAN insert its own block — the positive control', async () => {
        const id = `exb-${randomUUID()}`;
        created.push(id);
        await expect(
            withTenantDb(SELLER, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "ExchangeBlock" (id, "sellerTenantId", "blockedTenantId", "createdAt")
                     VALUES ($1, $2, $3, now())`,
                    id, SELLER, OUTSIDER,
                ),
            ),
        ).resolves.toBeDefined();
    });

    it('superuser still sees everything, so sweeps and seeds keep working', async () => {
        const { id } = await seedBlock();
        expect(await globalPrisma.exchangeBlock.findMany({ where: { id } })).toHaveLength(1);
    });
});
