import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { ManualPriceSeriesSchema } from '@/app-layer/schemas/market-manual.schemas';
import { upsertPlatformPriceOverride } from '@/app-layer/usecases/market-manual-prices';

/**
 * A superuser's daily price override, which wins for EVERY farm (#1587).
 *
 * Owner ruling 2026-10-10: a typed price always wins over the API, on every
 * surface, until it is cleared — a manual override, not a stale-only fallback.
 * Chosen over "API unless missing or stale" and over "newest wins".
 *
 * ## Why this is a separate route from `../market-prices`
 *
 * The two writes are the same shape and share one implementation, but they make
 * different CLAIMS, and a route is the honest place to draw that line:
 *
 *   · `market-prices` fills a gap — no free feed publishes MAP at all, and the
 *     Pink Sheet carries neither MAP nor ammonium nitrate. Nothing to outrank.
 *   · this one overrides a LIVE feed for every tenant.
 *
 * Folding the override into the existing route behind a flag would mean one
 * permission, one audit action and one spec entry covering both, and the
 * blast radius of the second is categorically larger. They also want different
 * audit actions, which the usecase emits (`MARKET_PRICE_OVERRIDE_UPSERT` vs
 * `MARKET_PRICE_MANUAL_UPSERT`) so the trail can tell them apart later.
 *
 * ## The gate, and why it is the same one
 *
 * `MarketPriceSeries` has no `tenantId` — every tenant reads the same rows — so
 * this is platform curation. Both halves matter: `admin.manage` is held by the
 * OWNER of EVERY tenant, so alone it would hand any farm's owner the global
 * price cache; `assertPlatformSupport` is what makes it real, and it FAILS
 * CLOSED — `isPlatformTenant` returns false while `PLATFORM_TENANT_SLUG` is
 * unset, and the route 404s for everyone including the owner.
 *
 * That is deliberate and is why this can ship before the platform farm exists.
 * It lands INERT. Shippable and exercisable are different things.
 *
 * ## Units
 *
 * The caller supplies `unit`. The nine crops and fertilisers are EUR/t and
 * diesel alone is EUR/l — the owner's answer when asked directly, after #1587
 * had recorded "EUR per tonne, diesel included" via a relay. The usecase does
 * not special-case diesel; it refuses a SECOND denomination for a commodity
 * that already has one, which is the check that actually protects the figure.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        const body = ManualPriceSeriesSchema.parse(await req.json());
        const result = await upsertPlatformPriceOverride(ctx, body);
        return jsonResponse(result, { status: 201 });
    }),
);
