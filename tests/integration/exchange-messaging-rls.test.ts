/**
 * `ExchangeThread` / `ExchangeMessage` RLS — two-party isolation on live chat.
 *
 * These tables need their own suite for the reason `exchange-inquiry-rls`
 * spells out: the `rls-coverage` inventory keys off a `tenantId` COLUMN, and
 * neither of these has one. They cannot: a thread is owned by NEITHER party
 * and read by BOTH, so whichever tenant we stamped on the row, the other could
 * not see it. The guard therefore never sees these tables, and a full guard
 * sweep passes with them completely unprotected — which it did, before this
 * file existed.
 *
 * That is the same shape as the bug the inquiry suite was written for: private
 * buyer↔seller messages readable by any tenant's session, with nothing
 * watching. Chat makes it worse, because the whole point of the table is that
 * people write things into it they would not say in public.
 *
 * Covered here:
 *   1. The inquirer reads the thread it opened.
 *   2. The SELLER reads that same thread — the disjunction case. A policy that
 *      only admitted the inquirer would pass a naive isolation test while
 *      leaving every seller unable to answer.
 *   3. An unrelated tenant reads NEITHER, including by direct id. A filtered
 *      list hides a row; RLS makes it unreachable.
 *   4. Messages inherit the thread's visibility — both parties read them, the
 *      outsider cannot.
 *   5. A party cannot send a message ATTRIBUTED TO the other party. This is
 *      the `WITH CHECK` on `senderTenantId`, and without it either side could
 *      forge words into the other's mouth in a record they both rely on.
 *   6. The outsider cannot insert into the thread at all.
 *   7. Superuser still sees everything, so sweeps, seeds and migrations keep
 *      working; a policy that broke them would be a false pass.
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

const SELLER = `t-exm-seller-${randomUUID()}`;
const BUYER = `t-exm-buyer-${randomUUID()}`;
const OUTSIDER = `t-exm-outsider-${randomUUID()}`;

const createdListings: string[] = [];
let USER_ID = '';

/** A listing owned by the seller, a thread opened by the buyer, one message each. */
async function seedThread() {
    const listingId = `exl-${randomUUID()}`;
    await globalPrisma.exchangeListing.create({
        data: {
            id: listingId,
            sellerTenantId: SELLER,
            sellerUserId: USER_ID,
            side: 'SELL',
            commodity: 'Wheat',
            quantityTonnes: 25,
            regionCode: 'BG-16',
            regionName: 'Plovdiv',
            lat: 42.15,
            lon: 24.75,
        },
    });
    createdListings.push(listingId);

    const threadId = `ext-${randomUUID()}`;
    await globalPrisma.exchangeThread.create({
        data: { id: threadId, listingId, inquirerTenantId: BUYER },
    });
    const buyerMsgId = `exm-${randomUUID()}`;
    await globalPrisma.exchangeMessage.create({
        data: {
            id: buyerMsgId, threadId, senderTenantId: BUYER,
            senderUserId: USER_ID, body: 'is it still available',
        },
    });
    return { listingId, threadId, buyerMsgId };
}

const readThread = (tenant: string, threadId: string) =>
    withTenantDb(tenant, async (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM "ExchangeThread" WHERE id = $1`,
            threadId,
        ),
    );

const readMessages = (tenant: string, threadId: string) =>
    withTenantDb(tenant, async (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM "ExchangeMessage" WHERE "threadId" = $1`,
            threadId,
        ),
    );

describeFn('ExchangeThread / ExchangeMessage RLS — two-party isolation', () => {
    beforeAll(async () => {
        const user = await globalPrisma.user.findFirst();
        if (!user) throw new Error('No seeded user — run the test seed first.');
        USER_ID = user.id;
    });

    afterAll(async () => {
        await globalPrisma.exchangeMessage.deleteMany({
            where: { thread: { listingId: { in: createdListings } } },
        });
        await globalPrisma.exchangeThread.deleteMany({
            where: { listingId: { in: createdListings } },
        });
        await globalPrisma.exchangeListing.deleteMany({
            where: { id: { in: createdListings } },
        });
        await globalPrisma.$disconnect();
    });

    it('the inquirer reads the thread it opened', async () => {
        const { threadId } = await seedThread();
        expect(await readThread(BUYER, threadId)).toHaveLength(1);
    });

    it('the SELLER reads that same thread — the disjunction case', async () => {
        // A single-equality policy on inquirerTenantId would pass every
        // isolation test in this file and leave sellers unable to reply.
        const { threadId } = await seedThread();
        expect(await readThread(SELLER, threadId)).toHaveLength(1);
    });

    it('an unrelated tenant reads NEITHER, even by direct id', async () => {
        // The direct-lookup leak: a missing `where` hides a row from a list,
        // RLS makes it unreachable however it is asked for.
        const { threadId } = await seedThread();
        expect(await readThread(OUTSIDER, threadId)).toHaveLength(0);
        expect(await readMessages(OUTSIDER, threadId)).toHaveLength(0);
    });

    it('messages inherit the thread visibility for BOTH parties', async () => {
        const { threadId } = await seedThread();
        expect(await readMessages(BUYER, threadId)).toHaveLength(1);
        expect(await readMessages(SELLER, threadId)).toHaveLength(1);
    });

    it('a party cannot send a message attributed to the OTHER party', async () => {
        // Without the WITH CHECK on senderTenantId, either side could forge
        // words into the other's mouth in a record they both rely on.
        const { threadId } = await seedThread();
        await expect(
            withTenantDb(SELLER, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "ExchangeMessage" (id, "threadId", "senderTenantId", "senderUserId", body, "createdAt")
                     VALUES ($1, $2, $3, $4, $5, now())`,
                    `exm-${randomUUID()}`, threadId, BUYER, USER_ID, 'forged',
                ),
            ),
        ).rejects.toThrow();
    });

    it('an outsider cannot insert into the thread at all', async () => {
        const { threadId } = await seedThread();
        await expect(
            withTenantDb(OUTSIDER, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "ExchangeMessage" (id, "threadId", "senderTenantId", "senderUserId", body, "createdAt")
                     VALUES ($1, $2, $3, $4, $5, now())`,
                    `exm-${randomUUID()}`, threadId, OUTSIDER, USER_ID, 'intrusion',
                ),
            ),
        ).rejects.toThrow();
    });

    it('a party CAN send as itself — the positive control', async () => {
        // Without this, a policy refusing every insert would pass the two
        // tests above and break the feature entirely.
        const { threadId } = await seedThread();
        await expect(
            withTenantDb(BUYER, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "ExchangeMessage" (id, "threadId", "senderTenantId", "senderUserId", body, "createdAt")
                     VALUES ($1, $2, $3, $4, $5, now())`,
                    `exm-${randomUUID()}`, threadId, BUYER, USER_ID, 'yes still available',
                ),
            ),
        ).resolves.toBeDefined();
    });

    it('superuser still sees everything, so sweeps and seeds keep working', async () => {
        const { threadId } = await seedThread();
        const rows = await globalPrisma.exchangeThread.findMany({ where: { id: threadId } });
        expect(rows).toHaveLength(1);
    });
});
