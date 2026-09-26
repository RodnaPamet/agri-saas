import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listUnits } from '@/app-layer/usecases/catalog';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { UnitQuerySchema } from '@/app-layer/schemas/catalog.schemas';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const query = UnitQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
    const units = await listUnits(ctx, query.measure);
    return jsonResponse(units);
});
