import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { PriceOverrideDaySchema } from '@/app-layer/schemas/market-manual.schemas';
import {
    readOverrideForm,
    upsertOverrideDay,
} from '@/app-layer/usecases/market-price-overrides';

/**
 * The superuser price override — read the form, write a day (#1587).
 *
 * Owner ruling 2026-10-10: a typed price always wins over the API, on every
 * surface and for every farm, until it is cleared.
 *
 * ## The gate, and why it is session-ful
 *
 * `MarketPriceSeries` has no `tenantId` — every tenant reads the same rows — so
 * this is platform curation, not tenant work. It sits under
 * `/api/t/[tenantSlug]/admin/**` rather than `/api/admin/**` because
 * `assertPlatformSupport` gives the write a real `userId` and `tenantId`, which
 * is what `AuditLog` requires and an API-key path cannot supply.
 *
 * Both halves are load-bearing: `admin.manage` is held by the OWNER of EVERY
 * tenant, so alone it would hand any farm's owner the global price cache. And it
 * FAILS CLOSED — `isPlatformTenant` returns false while `PLATFORM_TENANT_SLUG`
 * is unset, so these routes 404 for everyone including the owner. That is why
 * they can ship before the platform farm exists: they land inert.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        const commodities = await readOverrideForm(ctx);
        return jsonResponse({ commodities });
    }),
);

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        const body = PriceOverrideDaySchema.parse(await req.json());

        // The header is honoured as well as the body field, per the #1587
        // clarification: a client sending it in one place should not have to
        // discover which. The body wins when both are present and differ —
        // it is the one inside the payload the client built.
        const headerKey = req.headers.get('Idempotency-Key');
        const clientMutationId = body.clientMutationId ?? headerKey ?? null;

        const result = await upsertOverrideDay(ctx, {
            // `T00:00:00Z` because the column is `@db.Date` and the point key is
            // `(seriesId, date)`. Parsing the bare string would be local-time in
            // some runtimes and shift the day across a timezone boundary.
            date: new Date(`${body.date}T00:00:00.000Z`),
            prices: body.prices,
            clientMutationId,
        });
        return jsonResponse(result);
    }),
);
