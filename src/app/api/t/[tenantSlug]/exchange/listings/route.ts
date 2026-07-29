import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listActiveListings, createListing } from '@/app-layer/usecases/exchange';
import { CreateListingSchema } from '@/app-layer/schemas/exchange.schemas';
import { toPublicListing } from '@/lib/exchange/public-listing';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { EXCHANGE_LISTING_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';

/**
 * Exchange listings — the cross-tenant browse feed + create (EXCHANGE module).
 *
 *   GET  → ACTIVE listings across ALL tenants, PUBLIC projection only
 *          (no sellerUserId, no raw owning-tenant id → an opaque `isOwn`
 *          flag instead; no encrypted/private fields — there are none).
 *   POST → publish a new listing owned by the caller's tenant. The usecase
 *          stamps sellerTenantId = ctx.tenantId (a tenant can only ever
 *          create its OWN listing) and derives region geo from regionCode.
 *
 * Read-tier rate limiting (GAP-17) applies automatically at the Edge for
 * `/api/t/<slug>/...` GETs. Browse is FREE (no plan gate) — the network
 * effect depends on open access; the per-tenant EXCHANGE module toggle is
 * the only gate, enforced here via `assertModuleEnabled`.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'EXCHANGE');
        const listings = await listActiveListings(ctx);
        return jsonWithETag(req, listings.map((l) => toPublicListing(l, ctx.tenantId)));
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateListingSchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'EXCHANGE');
            const listing = await createListing(ctx, {
                side: body.side,
                kind: body.kind,
                commodity: body.commodity,
                quantityTonnes: body.quantityTonnes,
                pricePerTonne: body.pricePerTonne ?? null,
                priceCurrency: body.priceCurrency,
                regionCode: body.regionCode,
                description: body.description ?? null,
                sellerDisplayName: body.sellerDisplayName ?? null,
                // PRIVATE — persisted here, withheld by `toPublicListing` (and
                // by every other listing projection). It only ever reaches a
                // browser through `toPublicInquiry`'s reveal gate, i.e. to the
                // ONE buyer whose inquiry this seller accepted.
                sellerContact: body.sellerContact ?? null,
                expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            });
            return jsonResponse(toPublicListing(listing, ctx.tenantId), { status: 201 });
        },
    ),
    // Tighter than the default 60/min: a listing is a public, cross-tenant
    // artefact — blunt bulk spam bursts (the per-tenant quota is the durable cap).
    { rateLimit: { config: EXCHANGE_LISTING_CREATE_LIMIT, scope: 'exchange-listing-create' } },
);
