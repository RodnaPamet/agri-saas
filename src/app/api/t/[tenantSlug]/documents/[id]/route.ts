/**
 * DELETE /api/t/[tenantSlug]/documents/[id]
 *
 * The uploader or an admin. The bytes go; the row survives as a tombstone with
 * `purgeReason: DELETED`, who and when, and its `name` CLEARED — see
 * `deleteFarmDocument` for the owner ruling behind that asymmetry with expiry.
 */
import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { deleteFarmDocument } from '@/app-layer/usecases/farm-documents';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';

export const DELETE = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const row = await deleteFarmDocument(ctx, params.id);
        return jsonResponse(row);
    },
);
