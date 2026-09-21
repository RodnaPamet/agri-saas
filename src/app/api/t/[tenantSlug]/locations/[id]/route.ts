import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getLocation, updateLocation, deleteLocation } from '@/app-layer/usecases/location';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdateLocationSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { toLocationListItemDTO } from '@/lib/dto/location.dto';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const location = await getLocation(ctx, params.id);
    return jsonResponse(toLocationListItemDTO(location));
});

export const PUT = withApiErrorHandling(withValidatedBody(UpdateLocationSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const location = await updateLocation(ctx, params.id, body);
    return jsonResponse({ success: true, location: toLocationListItemDTO(location) });
}));

export const PATCH = PUT;

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await deleteLocation(ctx, params.id);
    return jsonResponse({ success: true });
});
