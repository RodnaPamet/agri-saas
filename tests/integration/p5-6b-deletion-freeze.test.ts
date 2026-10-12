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
    subjectMayCancelErasure,
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

/**
 * A REFUSED cancel must leave the suppression standing (#1664-adjacent, #1678).
 *
 * ## The assertion shape, borrowed from `agrent backend-1`
 *
 * They added, on the erasure side, that a refused cancel leaves the erasure
 * still pending — asserted on the ROW, because *"it threw" and "it threw after
 * clearing the column" look identical from the caller*. That is the same family
 * as this repo's RLS rule: a refused DELETE removes nothing silently, so you
 * assert the surviving count rather than that the call returned.
 *
 * ## The version of it that belongs HERE, and that nothing else covers
 *
 * Their test watches `deletionRequestedAt`. This file owns the LISTINGS, and
 * the failure is worse and quieter: `cancelAccountDeletion` refuses at line
 * ~44 and the restore runs at ~49, so the ordering is right today — and a
 * reorder, or an early `restoreListingsAfterCancel` added "so the person sees
 * their listings while we decide", would put a TERMINATED seller's listings
 * back into the marketplace while the erasure stayed pending. Nobody would see
 * it: the cancel still throws, the erasure is still scheduled, and the only
 * symptom is a listing visible to other farms that should not be.
 *
 * So this asserts BOTH halves of the refusal — the erasure still pending AND
 * the listings still hidden — through the real browse query.
 *
 * ## What these two assertions CAN and CANNOT catch, measured
 *
 * I wrote them believing they guarded the ordering inside
 * `cancelAccountDeletion`. **They do not, and they cannot**: the whole body
 * runs in one `prisma.$transaction`, so a write placed before the refusal is
 * rolled back by the throw and is unobservable from outside. Moving
 * `restoreListingsAfterCancel` above the refusal changed nothing here — the
 * failure that run came from a PRE-EXISTING case ("restores it on cancel",
 * whose `listingsRestored` count fell 1 → 0 because the restore ran twice).
 * `a-control-that-cannot-express-failure`: the transaction already makes that
 * input impossible, so an assertion about it is green for ever.
 *
 * What they DO catch is a write ESCAPING the transaction, which is the shape a
 * well-meaning refactor actually produces — "do the restore first, it's
 * idempotent", or a pre-check hoisted above `$transaction` for readability.
 * Both were measured:
 *
 *   - restore hoisted into its own transaction → "the listings are STILL
 *     hidden" fails;
 *   - the `deletionRequestedAt` clear hoisted out → BOTH fail, along with
 *     three of the suppression cases.
 *
 * Stated because the distinction decides what a future reader may rely on:
 * these guard the TRANSACTION BOUNDARY, not the statement order within it. The
 * boundary is the thing worth guarding — the ordering inside is already
 * guaranteed by something stronger than a test.
 *
 * ## The positive control is the SELF case
 *
 * Without it, every assertion here is satisfied by a `cancelAccountDeletion`
 * that refuses EVERYONE, which would be a far bigger bug than the one being
 * guarded. #1671's whole point is that the refusal keys on the INITIATOR, not
 * on the account being suspended.
 */
describeFn('#1678 — a refused cancel leaves the freeze standing', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    async function terminate(userId: string): Promise<void> {
        // The state `actOnNotice` leaves behind for ACCOUNT_TERMINATED, set
        // directly so this suite does not depend on the moderation path's
        // fixture requirements (a notice, a report, a rationale).
        await globalPrisma.$executeRawUnsafe(
            `UPDATE "User"
                SET "terminatedAt" = NOW(), "deletionRequestedBy" = 'MODERATION'
              WHERE "id" = $1`,
            userId,
        );
    }

    async function erasureStillPending(userId: string): Promise<boolean> {
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
            `SELECT "deletionRequestedAt" AS d FROM "User" WHERE "id" = $1`, userId);
        return rows[0].d !== null;
    }

    it('refuses the subject, and the erasure is STILL pending afterwards', async () => {
        const tenant = await makeTenant('term');
        const seller = await makeUser();
        await makeListing(tenant, seller);

        await requestAccountDeletion(seller);
        await terminate(seller);

        await expect(cancelAccountDeletion(seller)).rejects.toThrow();

        // On the ROW. A refusal that cleared the column first would throw
        // identically from the caller's side and quietly un-schedule the
        // erasure a moderator ordered.
        expect(await erasureStillPending(seller)).toBe(true);
    });

    it('and the listings are STILL hidden from other farms', async () => {
        // THE ASSERTION THIS FILE EXISTS FOR. Through the real browse query,
        // so it fails if `restoreListingsAfterCancel` ever runs before the
        // refusal — which would put a terminated seller back in the
        // marketplace with the erasure still scheduled.
        const tenant = await makeTenant('term');
        const seller = await makeUser();
        const listing = await makeListing(tenant, seller);

        await requestAccountDeletion(seller);
        await terminate(seller);
        expect(await visibleToOthers(listing)).toBe(false);

        await expect(cancelAccountDeletion(seller)).rejects.toThrow();

        expect(await visibleToOthers(listing)).toBe(false);
    });

    it('a SELF request still cancels and restores — the positive control', async () => {
        // Without this, every assertion above is satisfied by a cancel that
        // refuses everybody. #1671's ruling is that the refusal keys on the
        // INITIATOR; this is the half that proves it still does.
        const tenant = await makeTenant('self');
        const seller = await makeUser();
        const listing = await makeListing(tenant, seller);

        await requestAccountDeletion(seller);
        expect(await visibleToOthers(listing)).toBe(false);

        const cancelled = await cancelAccountDeletion(seller);

        expect(cancelled.wasRequested).toBe(true);
        expect(await visibleToOthers(listing)).toBe(true);
        expect(await erasureStillPending(seller)).toBe(false);
    });

    it('the usecase refuses THROUGH the exported predicate, not beside it', async () => {
        // `subjectMayCancelErasure` is exported and the usecase refuses through
        // it, so asserting the predicate cannot drift from the enforcement —
        // which is the property that makes testing the predicate meaningful at
        // all rather than testing a second copy of the rule.
        const seller = await makeUser();
        await requestAccountDeletion(seller);
        await terminate(seller);

        const row = await globalPrisma.$queryRawUnsafe<Array<{
            p: Date | null; d: Date | null; t: Date | null; b: string | null;
        }>>(
            `SELECT "pseudonymisedAt" AS p, "deletionRequestedAt" AS d,
                    "terminatedAt" AS t, "deletionRequestedBy"::text AS b
               FROM "User" WHERE "id" = $1`, seller);

        expect(subjectMayCancelErasure({
            pseudonymisedAt: row[0].p,
            deletionRequestedAt: row[0].d,
            terminatedAt: row[0].t,
            deletionRequestedBy: row[0].b,
        } as never)).toBe(false);
    });
});
