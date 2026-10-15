/**
 * A listing published AS THE FARM, resolved live — P6.7 (#1816).
 *
 * ## Why this suite is the one that matters
 *
 * The attribution is not stored on the listing. `publishAsFarm` holds the
 * DECISION and the identity is read from the seller's `FarmBrand` on every
 * read, which is the owner's ruling and the reason the column exists at all.
 * A unit test can check the projection's branches; only this can check that
 * the resolution actually crosses the tenant boundary and that WITHDRAWING a
 * farm's page reaches listings nobody wrote to.
 *
 * ## The rule for this file
 *
 * Two TENANTS and nothing else. Everything after that goes through an
 * exported usecase — no `prisma.farmBrand.*` writes, no
 * `prisma.exchangeListing.*` writes. P6 has shipped a layer whose caller did
 * not exist four times (#1867, #1884, #1891, #1908); a suite that seeds the
 * rows the product is supposed to create cannot notice the fifth.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    createListing,
    listActiveListings,
    getListing,
} from '@/app-layer/usecases/exchange';
import {
    updateFarmBrand,
    claimFarmBrandHandle,
    recordFarmBrandConsent,
    setFarmBrandPublication,
} from '@/app-layer/usecases/public-farm-profile';
import { toPublicListing } from '@/lib/exchange/public-listing';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;

describeIfDb('a listing published as the farm', () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
    const tenants: string[] = [];
    const handles: string[] = [];
    const listingIds: string[] = [];

    beforeAll(async () => {
        await prisma.$connect();
    });

    afterAll(async () => {
        if (listingIds.length > 0) {
            await prisma.exchangeListing.deleteMany({ where: { id: { in: listingIds } } });
        }
        // Handles live in a GLOBAL unique namespace, so a suite that leaves
        // brands behind reserves names for every future run — which is how a
        // fixture passes exactly once.
        if (handles.length > 0) {
            await prisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        if (tenants.length > 0) {
            await prisma.farmBrand.deleteMany({ where: { tenantId: { in: tenants } } });
        }
        await prisma.$disconnect();
    });

    async function aTenant(label: string) {
        const tenantId = `paf-${randomUUID().slice(0, 8)}`;
        tenants.push(tenantId);
        await prisma.tenant.create({ data: { id: tenantId, name: label, slug: tenantId } });
        return makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });
    }

    /** Take a farm all the way to published, through the product's operations. */
    async function aPublishedFarm(ctx: ReturnType<typeof makeRequestContext>, name: string) {
        const handle = `p${randomUUID().slice(0, 8).replace(/-/g, '')}`;
        handles.push(handle);
        await updateFarmBrand(ctx, { displayName: name });
        await claimFarmBrandHandle(ctx, handle);
        await recordFarmBrandConsent(ctx, { textVersion: 'v1' });
        await setFarmBrandPublication(ctx, true);
        return handle;
    }

    async function aListing(ctx: ReturnType<typeof makeRequestContext>, publishAsFarm: boolean) {
        const listing = await createListing(ctx, {
            side: 'SELL',
            kind: 'CULTURE',
            commodity: 'wheat',
            quantityTonnes: 25,
            regionCode: 'BG-16',
            sellerDisplayName: 'Типизирано име',
            publishAsFarm,
        });
        listingIds.push(listing.id);
        return listing;
    }

    /** What a DIFFERENT tenant sees for this listing in the browse feed. */
    async function asSeenBy(
        viewer: ReturnType<typeof makeRequestContext>,
        listingId: string,
    ) {
        const { rows } = await listActiveListings(viewer, {}, { limit: 50 });
        const row = rows.find((r) => r.id === listingId);
        if (!row) throw new Error(`listing ${listingId} not in the feed`);
        return toPublicListing(row, viewer.tenantId);
    }

    it('shows the farm name and handle to another tenant, and reverts when the farm withdraws', async () => {
        const seller = await aTenant('Продавач');
        const viewer = await aTenant('Купувач');
        const handle = await aPublishedFarm(seller, 'Стопанство Победа');
        const listing = await aListing(seller, true);

        // ── attributed ──
        const attributed = await asSeenBy(viewer, listing.id);
        expect(attributed.sellerDisplayName).toBe('Стопанство Победа');
        expect(attributed.farmHandle).toBe(handle);

        // This is the assertion the bypass exists for: under the VIEWER's own
        // tenant context a read of `FarmBrand` returns at most the viewer's
        // own row, so without `runWithoutRls` the two lines above would see
        // the typed name and the feature would appear to work only for the
        // seller testing it.
        expect(attributed.sellerDisplayName).not.toBe('Типизирано име');

        // ── withdrawn: nothing is written to the listing ──
        await setFarmBrandPublication(seller, false);

        const afterWithdrawal = await asSeenBy(viewer, listing.id);
        expect(afterWithdrawal.farmHandle).toBeNull();
        // Falls back to what the seller typed, so the listing is never left
        // naming a page that has stopped answering.
        expect(afterWithdrawal.sellerDisplayName).toBe('Типизирано име');
    });

    it('does not attribute a listing whose seller did not ask, even with a published farm', async () => {
        // Per-listing, not per-tenant: having a public page must not name the
        // farm on every offer it posts.
        const seller = await aTenant('Мълчалив');
        const viewer = await aTenant('Наблюдател');
        await aPublishedFarm(seller, 'Стопанство Мълчание');
        const listing = await aListing(seller, false);

        const seen = await asSeenBy(viewer, listing.id);
        expect(seen.farmHandle).toBeNull();
        expect(seen.sellerDisplayName).toBe('Типизирано име');
    });

    it('attributes a listing posted BEFORE the farm was published', async () => {
        // The reason the write path accepts the flag whatever the publication
        // state: resolution is live, so the ORDER of two unrelated decisions
        // does not matter and nothing has to be back-filled.
        const seller = await aTenant('После');
        const viewer = await aTenant('Свидетел');
        const listing = await aListing(seller, true);

        const before = await asSeenBy(viewer, listing.id);
        expect(before.farmHandle).toBeNull();

        const handle = await aPublishedFarm(seller, 'Стопанство Закъснение');

        const after = await asSeenBy(viewer, listing.id);
        expect(after.farmHandle).toBe(handle);
        expect(after.sellerDisplayName).toBe('Стопанство Закъснение');
    });

    it('resolves on the deep-link path too, not only in the feed', async () => {
        // A shared link must show the same seller identity the feed does, or
        // the attribution depends on how the buyer arrived.
        const seller = await aTenant('Дълбок');
        const viewer = await aTenant('Линк');
        const handle = await aPublishedFarm(seller, 'Стопанство Връзка');
        const listing = await aListing(seller, true);

        const row = await getListing(viewer, listing.id);
        const seen = toPublicListing(row, viewer.tenantId);
        expect(seen.farmHandle).toBe(handle);
        expect(seen.sellerDisplayName).toBe('Стопанство Връзка');
    });

    it('carries the attribution on the CREATE response', async () => {
        // Otherwise the seller posts an attributed listing and the 201 reports
        // it as anonymous, which reads as the flag not having saved.
        const seller = await aTenant('Създател');
        const handle = await aPublishedFarm(seller, 'Стопанство Създаване');
        const listing = await aListing(seller, true);

        const seen = toPublicListing(listing, seller.tenantId);
        expect(seen.farmHandle).toBe(handle);
        expect(seen.sellerDisplayName).toBe('Стопанство Създаване');
    });
});
