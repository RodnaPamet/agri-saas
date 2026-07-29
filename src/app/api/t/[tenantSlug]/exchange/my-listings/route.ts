import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listMyListings } from '@/app-layer/usecases/exchange';
import { toPublicListing, toPublicInquiry } from '@/lib/exchange/public-listing';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import type { NextRequest } from 'next/server';

/**
 * The caller-tenant's OWN listings (any status), each with its inquiries —
 * the seller's management view ("My listings"). Public projection: the
 * listing carries `isOwn: true`; inquiries expose only the coarse fields
 * (message / quantity / status), never the inquirer's tenant or user id.
 *
 * The parent listing is handed to `toPublicInquiry` as the inquiry's own
 * `listing` (it IS that inquiry's listing — the repository nests rather than
 * re-joins). The reveal gate needs it to recognise the viewer as the SELLER
 * side; without it a seller who accepted would see `counterpartyContact:
 * null` and the accept would complete nothing. `includeListing: false` keeps
 * it out of the wire shape, so the private `sellerContact` on that row is
 * read by the gate and never projected.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'EXCHANGE');
        const listings = await listMyListings(ctx);
        return jsonResponse(
            listings.map((l) => ({
                ...toPublicListing(l, ctx.tenantId),
                inquiries: l.inquiries.map((i) =>
                    toPublicInquiry({ ...i, listing: l }, ctx.tenantId, false),
                ),
            })),
        );
    },
);
