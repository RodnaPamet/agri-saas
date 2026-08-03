import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getMarketNews } from '@/app-layer/usecases/trends-news';
import { TrendNewsQuerySchema } from '@/app-layer/schemas/trends.schemas';

/**
 * GET /api/t/[tenantSlug]/trends/news?cursor=
 *
 * Returns one newest-first page of the GLOBAL agri-news cache
 * (`{ items, nextCursor }`). Tenant-authed (getTenantCtx) — read-tier rate
 * limiting applies at the edge. The payload is tenant-agnostic and Redis-cached
 * (15 min) inside the usecase. Attribution-first: only title + snippet + source
 * + link are served; the UI links OUT to the publisher.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        // Authenticate + gate tenant access (payload itself is tenant-agnostic).
        await getTenantCtx(params, req);

        const query = TrendNewsQuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        const payload = await getMarketNews(query.cursor);
        return jsonResponse(payload);
    },
);
