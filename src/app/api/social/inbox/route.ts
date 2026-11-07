/**
 * `GET /api/social/inbox` — one inbox, DMs and Борса deals (P8.5, #2799).
 *
 * ## Person-scoped, so it lives here and not under `/api/t/[tenantSlug]/`
 *
 * The DM half's policies key on `app.user_id`, which only `runInUserContext`
 * sets, and the list spans every farm the caller is a party in — so there is
 * no single tenant for a tenant route to enter with. #1664 is what a tenant
 * route would produce: zero rows, no error, indistinguishable from an empty
 * inbox.
 *
 * ## It returns a cursor and refuses a broken one
 *
 * `?limit` is clamped and `?cursor` is opaque. An unreadable cursor is a 400
 * rather than a silent first page: restarting a client's scroll looks like
 * duplicated rows, which reads as a render bug and sends somebody to the wrong
 * layer.
 *
 * ## `no-store`
 *
 * The same rule as the DM routes: `PERSISTABLE_PATHS` is an allowlist, and an
 * inbox preview is message text — a stranger's words on a phone that may be
 * lost, sold or handed on. No entry is added, and `swr-persist-allowlist`
 * keeps it that way.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { listInbox, INBOX_PAGE_SIZE } from '@/app-layer/usecases/inbox';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { parseLimitParam } from '@/lib/validation/query-params';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req, { surface: 'social' });
    await assertFeatureEnabled('social.direct-messages', ctx.userId);

    // Through `parseLimitParam`, not a hand-rolled `Number()`.
    // `limit-param-nan-safe` refused the first version of this route for
    // exactly that: `Number('abc')` is NaN, `??` does not catch NaN, and
    // Math.min/max propagate it, so `take: NaN` reaches Prisma and the route
    // 500s on `?limit=abc`.
    //
    // The shared helper also throws the DISCRIMINATED `INVALID_LIMIT` that
    // `localizeErrorPayload` can translate — `errors.INVALID_LIMIT` is an
    // object keyed by `reason` in both catalogues, not a sentence. My first
    // version threw a flat code and added a flat catalogue entry beside the
    // existing object, which is a duplicate JSON key that the i18n checks do
    // not flag.
    const parsed = parseLimitParam(req.nextUrl.searchParams.get('limit'), {
        max: INBOX_PAGE_SIZE,
    });

    const page = await listInbox(ctx, {
        ...(parsed === undefined ? {} : { limit: parsed }),
        cursor: req.nextUrl.searchParams.get('cursor'),
    });
    return jsonResponse(page, { headers: { 'Cache-Control': 'no-store' } });
});
