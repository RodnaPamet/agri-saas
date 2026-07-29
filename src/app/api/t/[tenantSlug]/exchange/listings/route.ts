import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ExchangeSide, ExchangeKind } from '@prisma/client';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listActiveListings, createListing } from '@/app-layer/usecases/exchange';
import { LISTING_PAGE_SIZE, LISTING_PAGE_MAX } from '@/app-layer/repositories/exchange';
import { CreateListingSchema } from '@/app-layer/schemas/exchange.schemas';
import { toPublicListing } from '@/lib/exchange/public-listing';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import { badRequest } from '@/lib/errors/types';
import { parseCsvEnumParam, parseCsvIdParam } from '@/lib/validation/query-params';
import { regionCodesMatchingName } from '@/lib/geo/bulgaria-regions';
import { EXCHANGE_LISTING_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';

/**
 * Exchange listings — the cross-tenant browse feed + create (EXCHANGE module).
 *
 *   GET  → one CURSOR PAGE of ACTIVE listings across ALL tenants, filtered
 *          SERVER-SIDE, PUBLIC projection only (no sellerUserId, no raw
 *          owning-tenant id → an opaque `isOwn` flag instead; no
 *          encrypted/private fields — there are none). Shape:
 *          `{ rows, nextCursor }`.
 *   POST → publish a new listing owned by the caller's tenant. The usecase
 *          stamps sellerTenantId = ctx.tenantId (a tenant can only ever
 *          create its OWN listing) and derives region geo from regionCode.
 *
 * The facets used to be parsed nowhere: the route called `listActiveListings`
 * with no arguments and the client filtered the fetched array, so a "Wheat in
 * Dobrich" filter searched only the newest 100 offers nationwide and reported
 * its findings as the market. They are parsed here now — multi-select facets
 * arrive comma-joined (`?side=SELL,BUY`), so every one goes through
 * `parseCsvEnumParam` / `parseCsvIdParam` and a bad member is a clean 400
 * rather than a Prisma 500 the page would render as "no offers".
 *
 * Read-tier rate limiting (GAP-17) applies automatically at the Edge for
 * `/api/t/<slug>/...` GETs. Browse is FREE (no plan gate) — the network
 * effect depends on open access; the per-tenant EXCHANGE module toggle is
 * the only gate, enforced here via `assertModuleEnabled`.
 */

/** Parse a bounded non-negative numeric query param (tonnage bounds, limit). */
function parseNumberParam(raw: string | null, label: string, max: number): number | undefined {
    if (raw == null || raw.trim() === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > max) {
        throw badRequest(`Invalid ${label} value: "${raw}"`);
    }
    return n;
}

/** Free-text search cap — long enough for a crop + region, short enough that
 *  the ILIKE stays cheap. */
const SEARCH_MAX = 120;

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'EXCHANGE');

        const sp = req.nextUrl.searchParams;
        const rawSearch = (sp.get('q') ?? '').trim().slice(0, SEARCH_MAX);
        const search = rawSearch || undefined;

        const { rows, nextCursor } = await listActiveListings(
            ctx,
            {
                sides: parseCsvEnumParam(sp.get('side'), z.nativeEnum(ExchangeSide), 'side'),
                kinds: parseCsvEnumParam(sp.get('kind'), z.nativeEnum(ExchangeKind), 'kind'),
                // Commodity is free text on the listing (the create form lets a
                // seller type one), so it is an opaque multi-value param, not
                // an enum.
                commodities: parseCsvIdParam(sp.get('commodity'), 'commodity', { maxLength: 120 }),
                regionCodes: parseCsvIdParam(sp.get('region'), 'region', { maxLength: 16 }),
                minTonnes: parseNumberParam(sp.get('minTonnes'), 'minTonnes', 1_000_000),
                maxTonnes: parseNumberParam(sp.get('maxTonnes'), 'maxTonnes', 1_000_000),
                search,
                // Resolved from the oblast catalogue so "Пловдив" matches a row
                // whose stored `regionName` is the English "Plovdiv".
                searchRegionCodes: search ? regionCodesMatchingName(search) : undefined,
            },
            {
                limit: parseNumberParam(sp.get('limit'), 'limit', LISTING_PAGE_MAX) ?? LISTING_PAGE_SIZE,
                cursor: sp.get('cursor'),
            },
        );

        return jsonWithETag(req, {
            rows: rows.map((l) => toPublicListing(l, ctx.tenantId)),
            nextCursor,
        });
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
                // No currency pass-through: the marketplace is euro-denominated
                // and the schema accepts nothing else, so the usecase stamps it.
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
