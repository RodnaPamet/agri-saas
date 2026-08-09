/**
 * GET /api/t/:tenantSlug/practices/:practiceId/page-data
 *
 * Single-call data contract for the practice detail page. Replaces
 * the previous client-side waterfall:
 *
 *   1. GET /practices/:id            (always)
 *   2. GET /practices/:id/sync       (gated on step 1, conditional)
 *
 * with one client→server round-trip. The legacy `/sync` endpoint is
 * retained — admin tools and the manual "Sync Now" action still use
 * it.
 *
 * See `getPracticePageData` for failure-mode semantics: a failed sync
 * lookup degrades to `syncStatus: null` rather than failing the
 * whole call.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getPracticePageData } from '@/app-layer/usecases/practice';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; practiceId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse(await getPracticePageData(ctx, params.practiceId));
    },
);
