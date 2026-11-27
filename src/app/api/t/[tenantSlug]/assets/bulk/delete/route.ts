/**
 * POST /api/t/:slug/assets/bulk/delete
 *
 * Bulk soft-delete assets (the assets table selection action-row). Permission
 * (ADMIN) + tenant isolation are enforced in `bulkDeleteAsset`. Body:
 * `{ assetIds: string[] }`. Returns `{ deleted: n }`.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { bulkDeleteAsset } from '@/app-layer/usecases/asset';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { BulkDeleteAssetSchema } from '@/lib/schemas';
import { jsonResponse } from '@/lib/api-response';


export const POST = withApiErrorHandling(
    withValidatedBody(
        BulkDeleteAssetSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await bulkDeleteAsset(ctx, body.assetIds);
            return jsonResponse(result);
        },
    ),
);
