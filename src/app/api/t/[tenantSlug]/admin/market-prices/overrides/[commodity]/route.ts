import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { clearOverride } from '@/app-layer/usecases/market-price-overrides';

/**
 * Clear one commodity's override, handing authority back to the feed (#1587).
 *
 * **Marks cleared; does not delete.** The typed history survives and so does the
 * audit trail of what was typed (contract §5(b)). The read path excludes a
 * cleared series and its stamped points, so "cleared" and "absent from the
 * payload" are the same thing to a client without the rows going anywhere.
 *
 * Clearing nothing is a 200 with `cleared: false`. A superuser clearing an
 * override that was never set has exactly the outcome they wanted, and a client
 * retrying a clear is the normal case rather than the odd one.
 *
 * The commodity is a PATH segment and not a query parameter. CFNetwork logs the
 * full URL including the query string, unsuppressably, so the rule here is that
 * identifiers go in the path — a commodity name is not personal data, but the
 * next identifier added should not arrive in the query by precedent.
 *
 * A request body is ignored, per the contract.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; commodity: string }>(
        'admin.manage',
        async (_req: NextRequest, { params }, ctx) => {
            assertPlatformSupport(ctx);
            const result = await clearOverride(ctx, params.commodity);
            return jsonResponse(result);
        },
    ),
);
