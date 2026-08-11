import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { ManualPriceSeriesSchema } from '@/app-layer/schemas/market-manual.schemas';
import { upsertManualPriceSeries } from '@/app-layer/usecases/market-manual-prices';

/**
 * Hand-entered market prices for the GLOBAL price cache.
 *
 * `MarketPriceSeries` has no `tenantId` — every tenant reads the same rows —
 * so this is platform curation, not tenant work: a tenant-facing write would
 * let one farm set the fertiliser price every other farm sees. It sits under
 * `/api/t/[tenantSlug]/admin/**` rather than `/api/admin/**` because the gate
 * is session-ful, and that is the whole point: `assertPlatformSupport` gives
 * the write a real `userId` and `tenantId`, which is what `AuditLog` requires
 * and the API-key path cannot supply.
 *
 * Both halves of the gate are load-bearing. `admin.manage` is held by the
 * OWNER of EVERY tenant, so on its own it would hand any farm's owner the
 * global price cache; `assertPlatformSupport` is the check that makes it real.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        const body = ManualPriceSeriesSchema.parse(await req.json());
        const result = await upsertManualPriceSeries(ctx, body);
        return jsonResponse(result, { status: 201 });
    }),
);
