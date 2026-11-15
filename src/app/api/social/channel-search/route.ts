/**
 * `GET /api/social/channel-search` — search channel posts (P9.7, #2941).
 *
 * ## Person-scoped, so NOT under `/api/t/{slug}`
 *
 * A channel has no tenant and the policies key on `app.user_id`, which only
 * `runInUserContext` sets — a tenant route would read zero rows with no error
 * (#1664).
 *
 * ## `scope` is a RELEVANCE lever, so an unrecognised value is a 400
 *
 * Not a silent fallback. Defaulting an unknown scope to `joined` would answer
 * a narrower question than the caller asked and look like an empty result; the
 * response echoes the scope it used for the same reason.
 *
 * Contrast `/api/social/inbox`, where `?source` is a DISCLOSURE lever and an
 * unrecognised value is refused because a fallback would mix two audiences.
 * Here nothing is disclosed either way — every channel post is readable by
 * every authenticated caller — so the refusal is about answering the right
 * question rather than about who may see what. Worth not conflating: the same
 * 400 for two different reasons.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import {
    CHANNEL_FEED_MAX_PAGE_SIZE,
    searchChannelPosts,
    type ChannelSearchScope,
} from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { parseLimitParam } from '@/lib/validation/query-params';

const SCOPES: readonly ChannelSearchScope[] = ['joined', 'all'];

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req, { surface: 'social' });
    await assertFeatureEnabled('social.channels', ctx.userId);

    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? '';

    const scopeRaw = url.searchParams.get('scope');
    if (scopeRaw !== null && !SCOPES.includes(scopeRaw as ChannelSearchScope)) {
        throw codedBadRequest('INVALID_SCOPE', 'scope must be joined or all.');
    }
    const scope = (scopeRaw ?? undefined) as ChannelSearchScope | undefined;

    const limit = parseLimitParam(url.searchParams.get('limit'), {
        max: CHANNEL_FEED_MAX_PAGE_SIZE,
    });

    // Same cursor contract as the feed and «За Вас»: refused when
    // unparseable, never ignored — ignoring returns page one, which a paging
    // client reads as the end and then as duplicates.
    const beforeRaw = url.searchParams.get('before');
    let before: Date | undefined;
    if (beforeRaw !== null) {
        before = new Date(beforeRaw);
        if (Number.isNaN(before.getTime())) {
            throw codedBadRequest('INVALID_CURSOR', 'before must be an ISO timestamp.');
        }
    }

    return jsonResponse(await searchChannelPosts(ctx, { q, scope, limit, before }));
});
