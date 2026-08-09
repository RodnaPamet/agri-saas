import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { getAssetKpiCounts } from '@/app-layer/usecases/asset';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { csvEnumField } from '@/lib/validation/query-params';
import { AssetType, AssetStatus, Criticality } from '@prisma/client';

/**
 * GET /api/t/:slug/assets/kpi — the four header-card counts, computed in
 * the DATABASE over the whole filtered set.
 *
 * Separate from the list read on purpose: the cards describe the entire
 * matching population, the list describes a page of it. Deriving the
 * cards from the loaded rows is correct only while the list is
 * unbounded — the moment it pages, "Total" quietly becomes "total on
 * this page", which is a wrong number wearing the costume of a right
 * one.
 *
 * Takes the SAME filter params as the list so the cards always describe
 * the set the user is looking at.
 */
const AssetKpiQuerySchema = z
    .object({
        type: csvEnumField(z.nativeEnum(AssetType)),
        status: csvEnumField(z.nativeEnum(AssetStatus)),
        criticality: csvEnumField(z.nativeEnum(Criticality)),
        q: z.string().optional().transform(normalizeQ),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const query = AssetKpiQuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        const counts = await getAssetKpiCounts(ctx, query);
        return jsonWithETag(req, counts);
    },
);
