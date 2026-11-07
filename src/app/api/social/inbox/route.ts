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
 * ## `?source=dm` narrows the halves, and it is a DISCLOSURE lever
 *
 * `listInbox` is person-scoped: its exchange half admits the caller only as
 * the inquirer or the listing's seller, deliberately not reproducing
 * `exchange_thread_audience`, which also admits either farm's OWNER/ADMIN. The
 * tenant-scoped exchange messaging screen has always shown an owner their
 * colleagues' threads, so backing that screen with this half would REMOVE rows
 * it shows today. P8.4 therefore asks for `?source=dm` and keeps the screen's
 * own tenant-scoped query for the other half. An absent param still returns
 * both, so P8.5's shape is unchanged.
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
import { codedBadRequest } from '@/lib/errors/types';
import type { InboxSource } from '@/app-layer/usecases/inbox';
import { parseLimitParam } from '@/lib/validation/query-params';

const SOURCES = ['dm', 'exchange'] as const;

/**
 * An UNRECOGNISED `?source` is a 400, never "both". Falling back to both would
 * answer a question the caller did not ask and, on a screen that asked for the
 * DM half only, would quietly add person-scoped exchange rows beside the
 * tenant-scoped ones the screen already fetched — the same row twice, from two
 * different audiences.
 */
function parseSources(raw: string | null): readonly InboxSource[] | undefined {
    if (raw === null) return undefined;
    const wanted = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (wanted.length === 0) {
        throw codedBadRequest('INVALID_SOURCE', 'Name at least one source.');
    }
    for (const w of wanted) {
        if (!(SOURCES as readonly string[]).includes(w)) {
            throw codedBadRequest('INVALID_SOURCE', 'That source is not one this inbox has.');
        }
    }
    return wanted as readonly InboxSource[];
}

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

    const sources = parseSources(req.nextUrl.searchParams.get('source'));

    const page = await listInbox(ctx, {
        ...(parsed === undefined ? {} : { limit: parsed }),
        ...(sources === undefined ? {} : { sources }),
        cursor: req.nextUrl.searchParams.get('cursor'),
    });
    return jsonResponse(page, { headers: { 'Cache-Control': 'no-store' } });
});
