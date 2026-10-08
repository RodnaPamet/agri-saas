import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listTaskParcels } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * `GET /api/t/{tenantSlug}/tasks/{taskId}/parcels` — the parcels a task
 * touches, for a display-only map.
 *
 * Wrapped in `{ parcels }` rather than returned as a bare array. A bare array
 * has nowhere to grow: the sibling `/links` returns one and is now the route
 * that cannot gain a field without a breaking change. An object costs a client
 * one key today and leaves room for a count or a bounds later.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const parcels = await listTaskParcels(ctx, params.taskId);
    return jsonResponse({ parcels });
});
