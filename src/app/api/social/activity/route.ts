/**
 * `GET /api/social/activity` — «За Вас» (P9.7, #2941).
 *
 * What happened to the caller across every channel: mentions of them, and
 * replies to their posts.
 *
 * ## Person-scoped, so it is NOT under `/api/t/{slug}`
 *
 * A channel has no tenant, and the policies key on `app.user_id`, which only
 * `runInUserContext` sets. A tenant route would read ZERO ROWS WITH NO ERROR
 * (#1664), which is indistinguishable from "nothing has happened to you".
 *
 * ## No ETag
 *
 * The answer changes whenever anybody mentions or replies to the caller, and
 * this is not on the offline-persist allowlist. `jsonWithETag` is for reads
 * whose answer is stable for months.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { CHANNEL_FEED_MAX_PAGE_SIZE, readMyActivity } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { parseLimitParam } from '@/lib/validation/query-params';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req, { surface: 'social' });
    await assertFeatureEnabled('social.channels', ctx.userId);

    const url = new URL(req.url);
    // The SHARED helper: `Number('abc')` is NaN, `??` does not catch it, and
    // `Math.min` propagates it — so `take: NaN` would reach Prisma and
    // `?limit=abc` would be a 500 on a plain read.
    const limit = parseLimitParam(url.searchParams.get('limit'), {
        max: CHANNEL_FEED_MAX_PAGE_SIZE,
    });

    // `before`, newest-first, matching the channel feed. REFUSED rather than
    // ignored when unparseable: ignoring returns page one, which a paging
    // client reads as having reached the end, and then as duplicates when it
    // has not. `INVALID_CURSOR` is the code the feed and the DM inbox use; a
    // synonym would be two codes for one condition.
    const beforeRaw = url.searchParams.get('before');
    let before: Date | undefined;
    if (beforeRaw !== null) {
        before = new Date(beforeRaw);
        if (Number.isNaN(before.getTime())) {
            throw codedBadRequest('INVALID_CURSOR', 'before must be an ISO timestamp.');
        }
    }

    return jsonResponse(await readMyActivity(ctx, { limit, before }));
});
