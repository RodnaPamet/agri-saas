import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { analyzeParcelRisk } from '@/app-layer/usecases/parcel-risk';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * Per-parcel satellite risk analysis (#13) — GET /agro/parcel-analysis?parcelId=.
 * Returns mean NDVI/NDMI, the traffic-light risk levels derived from them, and
 * the date of the satellite pass they came from. No prose summary — see the
 * fork note in `@/app-layer/usecases/parcel-risk`. Degrades gracefully when
 * Earth Engine is unconfigured or a pass yields no clear pixels: the readings
 * are null and the levels are "unknown".
 */
const QuerySchema = z.object({ parcelId: z.string().min(1) }).strip();

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const query = QuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        const result = await analyzeParcelRisk(ctx, query.parcelId);
        return jsonResponse(result);
    },
);
