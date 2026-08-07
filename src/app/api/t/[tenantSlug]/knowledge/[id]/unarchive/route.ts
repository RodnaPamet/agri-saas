/**
 * POST /api/t/[tenantSlug]/knowledge/[id]/unarchive
 * Restore an ARCHIVED knowledge article. ADMIN-only (mirrors
 * evidence/[id]/unarchive — archive/unarchive stay ADMIN-gated, same as
 * `archiveArticle`).
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { unarchiveArticle } from '@/app-layer/usecases/knowledge';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await unarchiveArticle(ctx, params.id);
    return jsonResponse(result);
});
