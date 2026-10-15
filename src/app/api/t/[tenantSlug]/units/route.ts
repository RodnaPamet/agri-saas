import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listUnits } from '@/app-layer/usecases/catalog';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';
import { UnitQuerySchema } from '@/app-layer/schemas/catalog.schemas';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const query = UnitQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
    const units = await listUnits(ctx, query.measure);
    // An ETag-bearing response rather than a plain one (#1845). This read is now
    // on `PERSISTABLE_PATHS`, so a phone keeps it across launches and
    // revalidates on open — and without an ETag that revalidation is a
    // FULL body, not a 304. That is the whole cost argument the 24h age
    // rests on, and CLAUDE.md's rule for a cacheable list GET.
    return jsonWithETag(req, units);
});
