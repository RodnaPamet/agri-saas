/**
 * `ExchangeInquiry` RLS — two-party isolation on the marketplace's private
 * messages.
 *
 * Why this table needed its own suite: the Exchange is the one surface in the
 * product with NO RLS safety net. Its tables are deliberately global so tenants
 * can read each other's offers, and `inquirerTenantId` is a plain FK rather
 * than a `tenantId` RLS column — so the rls-coverage inventory, which keys off
 * `tenantId`, never saw this table. `grep -c "Exchange"` on that file returned
 * 0, while migration 20260323180000 granted `app_user` full DML on every
 * table. Private buyer↔seller messages were readable by any tenant's session,
 * with nothing watching.
 *
 * The interesting difference from its twin `PromotionLead`: a lead belongs to
 * ONE tenant, but an inquiry legitimately has TWO parties. The inquirer wrote
 * it; the seller owns the listing it targets and must be able to read and
 * respond. So the policy is a disjunction, and "correct" here means BOTH
 * parties can reach the row and nobody else can — a policy that only admitted
 * the inquirer would pass a naive isolation test while breaking every seller's
 * inbox.
 *
 * Covered here:
 *   1. The inquirer reads its own inquiry.
 *   2. The SELLER reads an inquiry on its own listing — written by someone
 *      else. This is the case a single-equality policy would break.
 *   3. An unrelated third tenant reads neither, including by direct id (the
 *      direct-lookup leak: a filtered list hides a row, RLS makes it
 *      unreachable).
 *   4. A tenant cannot INSERT an inquiry attributed to another tenant.
 *   5. A tenant cannot re-attribute its own inquiry to another tenant.
 *   6. The seller can UPDATE the status — the respondToInquiry path, which
 *      WITH CHECK must admit or accept/decline breaks at the database.
 *   7. Superuser still sees everything, so the expiry sweep and seeds keep
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

/** Seller, buyer, and a bystander who must see nothing. */
const SELLER = `t-exq-seller-${randomUUID()}`;
const BUYER = `t-exq-buyer-${randomUUID()}`;
const OUTSIDER = `t-exq-outsider-${randomUUID()}`;

const createdListings: string[] = [];
let USER_ID = '';

/**
 * Seed a listing owned by `sellerTenantId` plus one inquiry from
 * `inquirerTenantId`.
 *
 * `ExchangeInquiry` carries `@@unique([listingId, inquirerTenantId])`, so a
 * fresh listing per case keeps the cases independent and means no test depends
 * on another's rows surviving.
 *
 * Inserted as superuser so the fixture is never subject to the policy under
 * test.
 */
async function seedInquiry(sellerTenantId: string, inquirerTenantId: string) {
    const listingId = `exl-${randomUUID()}`;
    await globalPrisma.exchangeListing.create({
        data: {
            id: listingId,
            sellerTenantId,
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

    const inquiryId = `exq-${randomUUID()}`;
    await globalPrisma.exchangeInquiry.create({
        data: {
            id: inquiryId,
            listingId,
            inquirerTenantId,
            inquirerUserId: USER_ID,
            message: `interest from ${inquirerTenantId}`,
        },
    });
    return { listingId, inquiryId };
}

describeFn('ExchangeInquiry RLS — two-party isolation', () => {
    beforeAll(async () => {
        const user = await globalPrisma.user.findFirst();
        if (!user) throw new Error('No seeded user — run the test seed first.');
        USER_ID = user.id;
    });

    afterAll(async () => {
        await globalPrisma.exchangeInquiry.deleteMany({
            where: { listingId: { in: createdListings } },
        });
        await globalPrisma.exchangeListing.deleteMany({
            where: { id: { in: createdListings } },
        });
        await globalPrisma.$disconnect();
    });

    it('the inquirer reads its own inquiry', async () => {
        const { inquiryId } = await seedInquiry(SELLER, BUYER);

        const rows = await withTenantDb(BUYER, async (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "ExchangeInquiry" WHERE id = $1`,
                inquiryId,
            ),
        );
        expect(rows).toHaveLength(1);
    });

    it('the SELLER reads an inquiry on its own listing, written by someone else', async () => {
        // The case a single-equality policy would silently break: every
        // seller's inbox goes empty while an isolation test still passes.
        const { inquiryId } = await seedInquiry(SELLER, BUYER);

        const rows = await withTenantDb(SELLER, async (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string; message: string }>>(
                `SELECT id, message FROM "ExchangeInquiry" WHERE id = $1`,
                inquiryId,
            ),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].message).toContain(BUYER);
    });

    it('an unrelated tenant reads neither, including by direct id', async () => {
        const { inquiryId } = await seedInquiry(SELLER, BUYER);

        const rows = await withTenantDb(OUTSIDER, async (tx) =>
            tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "ExchangeInquiry" WHERE id = $1`,
                inquiryId,
            ),
        );
        expect(rows).toHaveLength(0);
    });

    it('a tenant cannot INSERT an inquiry attributed to another tenant', async () => {
        const listingId = `exl-${randomUUID()}`;
        await globalPrisma.exchangeListing.create({
            data: {
                id: listingId,
                sellerTenantId: SELLER,
                sellerUserId: USER_ID,
                side: 'SELL',
                commodity: 'Barley',
                quantityTonnes: 10,
                regionCode: 'BG-16',
                regionName: 'Plovdiv',
                lat: 42.15,
                lon: 24.75,
            },
        });
        createdListings.push(listingId);

        await expect(
            withTenantDb(OUTSIDER, async (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "ExchangeInquiry"
                       (id, "listingId", "inquirerTenantId", "inquirerUserId", message, status, "createdAt")
                     VALUES ($1, $2, $3, $4, 'forged', 'PENDING', now())`,
                    `exq-forged-${randomUUID()}`,
                    listingId,
                    BUYER,
                    USER_ID,
                ),
            ),
        ).rejects.toThrow();
    });

    it('a tenant cannot re-attribute its own inquiry to another tenant', async () => {
        const { inquiryId } = await seedInquiry(SELLER, BUYER);

        await expect(
            withTenantDb(BUYER, async (tx) =>
                tx.$executeRawUnsafe(
                    `UPDATE "ExchangeInquiry" SET "inquirerTenantId" = $1 WHERE id = $2`,
                    OUTSIDER,
                    inquiryId,
                ),
            ),
        ).rejects.toThrow();
    });

    it('the seller CAN update the status — the respondToInquiry path', async () => {
        // WITH CHECK is evaluated against the NEW row on UPDATE, so a policy
        // whose write half admitted only the inquirer would make every
        // accept/decline fail at the database with a policy violation.
        const { inquiryId } = await seedInquiry(SELLER, BUYER);

        await withTenantDb(SELLER, async (tx) =>
            tx.$executeRawUnsafe(
                `UPDATE "ExchangeInquiry" SET status = 'ACCEPTED' WHERE id = $1`,
                inquiryId,
            ),
        );

        const row = await globalPrisma.exchangeInquiry.findUnique({ where: { id: inquiryId } });
        expect(row?.status).toBe('ACCEPTED');
    });

    it('superuser still sees every tenant — the bypass works', async () => {
        // The expiry sweep, seeds and migrations all run privileged. A policy
        // that broke them would look like a pass here and fail in production.
        const { inquiryId } = await seedInquiry(SELLER, BUYER);
        const row = await globalPrisma.exchangeInquiry.findUnique({ where: { id: inquiryId } });
        expect(row).not.toBeNull();
    });
});
