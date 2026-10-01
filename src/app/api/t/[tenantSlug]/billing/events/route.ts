import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { listBillingEvents } from '@/lib/entitlements-server';
import { jsonResponse } from '@/lib/api-response';
import { parseLimitParam } from '@/lib/validation/query-params';

/**
 * GET /api/t/[tenantSlug]/billing/events
 * Returns recent billing events for the tenant.
 * Gated by `admin.manage` (Epic D.3).
 * Query params: ?limit=20
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const url = new URL(req.url);
        // `parseInt('abc')` is NaN and `Math.min(NaN, 100)` is NaN, so the
        // ceiling never bound the one input that needed it — see
        // `parseLimitParam`. 20 stays the default, 100 the ceiling.
        const limit = parseLimitParam(url.searchParams.get('limit'), { max: 100 }) ?? 20;

        const events = await listBillingEvents(ctx.tenantId, limit);

        return jsonResponse({ events });
    }),
);
