import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAssets, listAssetsPaginated, createAsset, listAssetsWithDeleted } from '@/app-layer/usecases/asset';
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

    if (query.includeDeleted === 'true') {
        const assets = await listAssetsWithDeleted(ctx);
        return jsonResponse(assets);
    }

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listAssetsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: {
                type: query.type,
                status: query.status,
                criticality: query.criticality,
                q: query.q,
            },
        });
        return jsonResponse(result);
    }

    // Backward compat: return flat array
    const assets = await listAssets(ctx, {
        type: query.type,
        status: query.status,
        criticality: query.criticality,
        q: query.q,
    });
    return jsonResponse(assets);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateAssetSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const asset = await createAsset(ctx, body);
    return jsonResponse(asset, { status: 201 });
}));
