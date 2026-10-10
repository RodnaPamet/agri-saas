import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { clearPlatformPriceOverride } from '@/app-layer/usecases/market-manual-prices';

/**
 * Clear a superuser's price override, handing authority back to the feed
 * (#1587).
 *
 * ## Clearing nothing returns 200, not 404
 *
 * `cleared: false`. A superuser clearing an override that was never set, or was
 * already cleared, has got exactly the outcome they wanted — the feed is
 * authoritative. A 404 would make an idempotent retry look like a failure, and
 * a client retrying a clear is the normal case rather than the odd one.
 *
 * ## The commodity is a PATH segment, deliberately
 *
 * Not a query parameter. `CFNetwork` logs the full URL including the query
 * string, unsuppressably, so the iOS client cannot keep anything in a query out
 * of its logs — and while a commodity name is not personal data, the rule here
 * is that identifiers go in the path so the next identifier to be added does not
 * arrive in the query by precedent.
 *
 * Any spelling the vocabulary resolves is accepted and normalised; one it does
 * not cover is a 400 naming the value, never a silent no-op. "Cleared nothing"
 * and "cleared a commodity you misspelled" must not look the same.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; commodity: string }>(
        'admin.manage',
        async (_req: NextRequest, { params }, ctx) => {
            assertPlatformSupport(ctx);
            const result = await clearPlatformPriceOverride(ctx, params.commodity);
            return jsonResponse(result, { status: 200 });
        },
    ),
);
