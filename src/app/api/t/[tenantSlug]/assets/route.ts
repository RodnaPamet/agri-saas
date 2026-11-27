import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAssets, listAssetsPaginated, createAsset } from '@/app-layer/usecases/asset';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateAssetSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { csvEnumField } from '@/lib/validation/query-params';
import { AssetType, AssetStatus, Criticality } from '@prisma/client';
import { jsonResponse } from '@/lib/api-response';

const AssetQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    // These three facets are `multiple: true` in filter-defs, and
    // `toApiSearchParams` comma-joins a multi-select into ONE param. Read
    // as a scalar they reached Prisma as the literal "TRACTOR,HARVESTER"
    // and threw PrismaClientValidationError → 500. csvEnumField splits and
    // validates every member (400 on a bad one) and yields an ARRAY.
    type: csvEnumField(z.nativeEnum(AssetType)),
    status: csvEnumField(z.nativeEnum(AssetStatus)),
    criticality: csvEnumField(z.nativeEnum(Criticality)),
    q: z.string().optional().transform(normalizeQ),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = AssetQuerySchema.parse(sp);

    // #3272 — ONE filter set, built once, honoured by both branches.
    //
    // `includeDeleted` used to be an early `return` ABOVE this line, so a
    // caller sending it alongside a filter, a search term or a cursor got
    // every asset on the farm and no indication that its parameters had been
    // discarded. It is a filter now; the ADMIN gate it carries lives in the
    // usecase (`assertMayIncludeDeleted`).
    const filters = {
        type: query.type,
        status: query.status,
        criticality: query.criticality,
        q: query.q,
        includeDeleted: query.includeDeleted === 'true',
    };

    // The remaining branch is about the ENVELOPE only, and both sides now
    // return the same row shape.
    if (query.limit || query.cursor) {
        const result = await listAssetsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters,
        });
        return jsonResponse(result);
    }

    // Backward compat: a bare array, capped at ASSET_LIST_CAP.
    const assets = await listAssets(ctx, filters);
    return jsonResponse(assets);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateAssetSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const asset = await createAsset(ctx, body);
    return jsonResponse(asset, { status: 201 });
}));
