import type { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { withdrawListing, fulfillListing, getListing } from '@/app-layer/usecases/exchange';
import { UpdateListingStatusSchema } from '@/app-layer/schemas/exchange.schemas';
import { toPublicListing } from '@/lib/exchange/public-listing';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * Read ONE listing by id (EXCHANGE module) — the deep-link / shared-link path.
 *
 *   GET → the PUBLIC projection of any tenant's listing (404 if missing).
 *
 * The browse feed only holds the current page, so a shared or emailed link to
 * a single listing needs this to fetch it standalone and open the detail Sheet.
 * The read is global by design (like the feed); `isOwn` is derived per viewer.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; listingId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'EXCHANGE');
        const listing = await getListing(ctx, params.listingId);
        return jsonResponse(toPublicListing(listing, ctx.tenantId));
    },
);

/**
 * Update one of the caller-tenant's OWN listings.
 *
 *   PATCH { action: 'WITHDRAWN' | 'FULFILLED' } → flip lifecycle status.
 *
 * The usecase re-loads the listing and asserts ctx.tenantId ===
 * sellerTenantId (the cross-tenant write guard) before mutating.
 *
 * ── WITHDRAW is deliberately NOT module-gated ────────────────────────────
 * The EXCHANGE toggle governs PARTICIPATION in the marketplace — browsing,
 * posting, marking a sale. It does not govern CUSTODY of rows you already
 * posted. Gating withdraw was the second half of the module-opt-out defect:
 * a tenant that switched EXCHANGE off kept its listings public (the browse
 * query had no seller-side check) and simultaneously lost the only endpoint
 * that could take them down. The read-side exclusion now hides those rows,
 * and this exemption gives the seller back the ability to clean up — the
 * two fixes are complements, not alternatives.
 *
 * FULFILLED stays gated: marking a sale is a claim about a transaction in a
 * market the tenant has left, and it feeds the "sold" statistics. Withdrawing
 * asserts nothing.
 */
export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateListingStatusSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; listingId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            if (body.action === 'WITHDRAWN') {
                return jsonResponse(await statusOf(withdrawListing(ctx, params.listingId)));
            }
            await assertModuleEnabled(ctx, 'EXCHANGE');
            return jsonResponse(await statusOf(fulfillListing(ctx, params.listingId)));
        },
    ),
);

async function statusOf(p: Promise<{ id: string; status: string }>) {
    const updated = await p;
    return { id: updated.id, status: updated.status };
}
