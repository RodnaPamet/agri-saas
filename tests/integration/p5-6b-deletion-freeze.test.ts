/**
 * #1655 — the freeze the privacy notice has been promising.
 *
 * ## What was wrong, and why no test caught it
 *
 * `privacy.deleteRequest` tells people in both locales that asking to be
 * deleted means their account "stops being visible to other farms straight
 * away". The request wrote `deletionRequestedAt`, bumped `sessionVersion` and
 * revoked sessions — and nothing read that column outside the erasure path. So
 * ACTIVE listings stayed in the marketplace for the full 30 days.
 *
 * `privacy-notice-matches-erasure.test.ts` was green throughout, correctly: it
 * ranges over `RETAINED_MODELS` — what SURVIVES erasure — and a grace-period
 * claim is not in that population. A guard green on one axis while the other
 * is false.
 *
 * ## Suppression is asserted as an ABSENCE from SOMEBODY ELSE'S query
 *
 * Reading back `suppressedForDeletionAt` would prove the column was written and
 * nothing about visibility — the browse filter could be missing entirely and
 * such a test would pass. So every case here builds a SECOND farm and asserts
 * what that farm can see.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    requestAccountDeletion,
    cancelAccountDeletion,
} from '@/app-layer/usecases/account-erasure';
import { ExchangeRepository } from '@/app-layer/repositories/exchange';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const tenants: string[] = [];
const listings: string[] = [];

async function makeTenant(label: string): Promise<string> {
    const id = `t-1655-${label}-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Tenant"("id","name","slug","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, `Farm ${label}`, `f1655-${randomUUID()}`.slice(0, 40),
    );
    tenants.push(id);
    return id;
}

async function makeUser(): Promise<string> {
    const id = `u-1655-${randomUUID()}`;
    const email = `i1655-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, encryptField(email), hashForLookup(email),
    );
    users.push(id);
    return id;
}

async function makeListing(
    tenantId: string, userId: string, status = 'ACTIVE',
): Promise<string> {
    const id = `el-1655-${randomUUID()}`;
    // Column names and enum types DERIVED from `prisma/schema/exchange.prisma`,
    // not guessed: my first version invented `ExchangeListingKind` and
    // `Commodity`, and Postgres answered `42704 type does not exist`. `kind` is
    // `ExchangeKind`, `commodity` is a plain String, and `regionCode` /
    // `regionName` / `lat` / `lon` are all NOT NULL.
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ExchangeListing"
           ("id","sellerTenantId","sellerUserId","side","kind","commodity",
            "quantityTonnes","regionCode","regionName","lat","lon",
            "status","updatedAt")
         VALUES ($1,$2,$3,'SELL'::"ExchangeSide",'CULTURE'::"ExchangeKind",
                 'wheat',100,'BG-PVN','Pleven',43.4,24.6,
                 $4::"ExchangeListingStatus",NOW())`,
        id, tenantId, userId, status,
    );
    listings.push(id);
    return id;
}

/**
 * What another farm sees, THROUGH THE REAL BROWSE QUERY.
 *
 * My first version of this helper re-stated the filter in raw SQL
 * (`AND "suppressedForDeletionAt" IS NULL`). It passed — and so did all seven
 * cases with the production filter DELETED, measured. It was asserting that the
 * column had been written, which is the one thing the suppression code
 * obviously does, and nothing about whether any reader honours it. A control
 * that cannot express the failure is green for ever.
 *
 * So this calls `ExchangeRepository.listActiveListings`, the method the
 * marketplace feed actually runs. Deleting the filter now reddens.
 */
async function visibleToOthers(listingId: string): Promise<boolean> {
    const rows = await ExchangeRepository.listActiveListings(
        globalPrisma as never,
        {},
        { limit: 200 },
    );
    return rows.rows.some((r: { id: string }) => r.id === listingId);
}

async function statusOf(listingId: string): Promise<string> {
    const rows = await globalPrisma.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT "status"::text AS s FROM "ExchangeListing" WHERE "id" = $1`, listingId,
    );
    return rows[0].s;
}

describeFn('#1655 — requesting deletion withholds the account', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterAll(async () => {
        const del = async (t: string, c: string, ids: string[]) => {
            if (ids.length) {
                await globalPrisma.$executeRawUnsafe(
                    `DELETE FROM "${t}" WHERE "${c}" = ANY($1::text[])`, ids);
            }
        };
        await del('ExchangeListing', 'id', listings);
        await del('UserSession', 'userId', users);
        await del('User', 'id', users);
        await del('Tenant', 'id', tenants);
        await globalPrisma.$disconnect();
    });

    it('hides an ACTIVE listing from other farms', async () => {
        const tenant = await makeTenant('seller');
        const seller = await makeUser();
        const listing = await makeListing(tenant, seller);

        expect(await visibleToOthers(listing)).toBe(true);

        const result = await requestAccountDeletion(seller);

        expect(result.applied).toBe(true);
        expect(result.listingsSuppressed).toBe(1);
        // THE ASSERTION. Not "the column was written" — what another farm sees.
        expect(await visibleToOthers(listing)).toBe(false);
    });

    it('does NOT rewrite the status, so the restore has something to restore', async () => {
        const tenant = await makeTenant('seller');
        const seller = await makeUser();
        const listing = await makeListing(tenant, seller);

        await requestAccountDeletion(seller);

        // Hidden, but still ACTIVE underneath. Reusing `WITHDRAWN` would have
        // destroyed the information the restore needs and conflated a platform
        // action with the seller's own decision.
        expect(await statusOf(listing)).toBe('ACTIVE');
    });

    it('restores it on cancel', async () => {
        const tenant = await makeTenant('seller');
        const seller = await makeUser();
        const listing = await makeListing(tenant, seller);

        await requestAccountDeletion(seller);
        expect(await visibleToOthers(listing)).toBe(false);

        const cancelled = await cancelAccountDeletion(seller);

        expect(cancelled.wasRequested).toBe(true);
        expect(cancelled.listingsRestored).toBe(1);
        expect(await visibleToOthers(listing)).toBe(true);
    });

    it('restores EXACTLY what it hid — a self-withdrawn listing stays withdrawn', async () => {
        // THE FAILURE MODE I EXPECT A REFACTOR TO INTRODUCE. The obvious
        // implementation of "restore" is to set the person's listings ACTIVE,
        // which resurrects one they had deliberately taken down — a worse
        // outcome than the bug this whole change fixes.
        const tenant = await makeTenant('seller');
        const seller = await makeUser();
        const live = await makeListing(tenant, seller, 'ACTIVE');
        const withdrawn = await makeListing(tenant, seller, 'WITHDRAWN');

        const req = await requestAccountDeletion(seller);
        // Only the ACTIVE one was ever hidden.
        expect(req.listingsSuppressed).toBe(1);

        await cancelAccountDeletion(seller);

        expect(await statusOf(live)).toBe('ACTIVE');
        expect(await visibleToOthers(live)).toBe(true);
        expect(await statusOf(withdrawn)).toBe('WITHDRAWN');
        expect(await visibleToOthers(withdrawn)).toBe(false);
    });

    it('asking twice does not restamp, and suppresses nothing the second time', async () => {
        const tenant = await makeTenant('seller');
        const seller = await makeUser();
        await makeListing(tenant, seller);

        const first = await requestAccountDeletion(seller);
        const second = await requestAccountDeletion(seller);

        expect(first.listingsSuppressed).toBe(1);
        expect(second.alreadyRequested).toBe(true);
        // Idempotent: a second request must not restart the grace period, and
        // must not restamp a suppression either — the restore keys on the
        // column being set, not on its value, but a moved timestamp would make
        // the audit question "when was this hidden" unanswerable.
        expect(second.listingsSuppressed).toBe(0);
        expect(first.erasesAt).toBe(second.erasesAt);
    });

    it('leaves OTHER sellers untouched', async () => {
        // The `where` clause is the only thing scoping this, exactly like the
        // export — so the test that matters is a second person's rows.
        const tenantA = await makeTenant('a');
        const tenantB = await makeTenant('b');
        const sellerA = await makeUser();
        const sellerB = await makeUser();
        const mine = await makeListing(tenantA, sellerA);
        const theirs = await makeListing(tenantB, sellerB);

        await requestAccountDeletion(sellerA);

        expect(await visibleToOthers(mine)).toBe(false);
        expect(await visibleToOthers(theirs)).toBe(true);
    });

    it('a cancel by one person does not restore another person’s suppression', async () => {
        const tenantA = await makeTenant('a');
        const tenantB = await makeTenant('b');
        const sellerA = await makeUser();
        const sellerB = await makeUser();
        const listingA = await makeListing(tenantA, sellerA);
        const listingB = await makeListing(tenantB, sellerB);

        await requestAccountDeletion(sellerA);
        await requestAccountDeletion(sellerB);
        await cancelAccountDeletion(sellerA);

        expect(await visibleToOthers(listingA)).toBe(true);
        // Still hidden: the restore is scoped to one person, which a shared
        // `deleted-user` style flag would not have been.
        expect(await visibleToOthers(listingB)).toBe(false);
    });
});
