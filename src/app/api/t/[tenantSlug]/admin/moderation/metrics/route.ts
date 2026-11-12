import { NextRequest } from 'next/server';

import { moderationHandlingStats } from '@/app-layer/usecases/moderation';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseModerationWindowDays } from '@/lib/validation/query-params';

/**
 * The handling-time reading, for a PERSON — #2735, PR 4.
 *
 * ## Why the console needs it rather than only a script
 *
 * P5's exit criterion is a MEDIAN HANDLING TIME, and this is the figure it is
 * measured on. A number nobody can see without holding
 * `PLATFORM_ADMIN_API_KEY` is a number nobody checks — which is the #2844 shape
 * rather than the Edge-severance one: a complete, reachable mechanism that
 * nothing offers anybody.
 *
 * ## The window is BOUNDED and the parser is SHARED
 *
 * `parseModerationWindowDays` moved to `@/lib/validation/query-params` in this
 * change: the figure is now read through two doors, and two local copies of the
 * bound is the #1664 shape — one spelling moves, the doors answer different
 * questions, and nothing fails. Its own docblock carries the reason for the
 * ceiling (a lifetime median hides a regression) and notes that it DEFAULTS on
 * bad input rather than throwing, which is the weaker choice preserved from the
 * keyed route rather than changed in passing.
 *
 * ## It reads NOTHING per-person
 *
 * `moderationHandlingStats` groups by status and measures elapsed time. It
 * returns no reporter, no subject and no moderator — so unlike the triage queue
 * there is nothing here to withhold, and the reading is safe to render whole.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);
            const url = new URL(req.url);
            const windowDays = parseModerationWindowDays(url.searchParams.get('windowDays'));
            return jsonResponse(await moderationHandlingStats(windowDays));
        },
    ),
);
