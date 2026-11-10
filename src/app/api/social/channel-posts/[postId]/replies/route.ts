/**
 * Read and write ONE post's thread — P9.3b (#2937) and #2961.
 *
 * The GET is #2961: `replyToPost` had shipped with no reader at all. The feed
 * filters `parentPostId: null`, correctly, and nothing else returned a reply —
 * so a reply was written to a row no read path served, and the author posted
 * it into silence. The one escape was `alsoToChannel`, which writes a second
 * top-level row.
 *
 * Addressed by the POST id rather than `/channels/{channelId}/posts/{postId}`,
 * because the channel is derived from the parent row. A channel id in the path
 * would be redundant and could DISAGREE with the parent's — and then one of
 * the two has to win silently.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import {
    CHANNEL_FEED_MAX_PAGE_SIZE, readPostReplies, replyToPost,
} from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { CreateChannelReplySchema } from '@/lib/schemas';
import { parseLimitParam } from '@/lib/validation/query-params';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ postId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { postId } = await params;

        const url = new URL(req.url);
        // The SHARED helper, for the reason the feed route records at length:
        // `Number('abc')` is NaN, `??` does not catch it, and `Math.min`
        // propagates it, so `take: NaN` reaches Prisma and `?limit=abc` is a
        // 500 on a plain read.
        const limit = parseLimitParam(url.searchParams.get('limit'), {
            max: CHANNEL_FEED_MAX_PAGE_SIZE,
        });

        // `after`, not `before`: a thread reads OLDEST first, because it is a
        // conversation and the answers only make sense in the order given.
        // The feed is newest-first for the opposite reason. Same cursor shape,
        // opposite direction, and naming the parameter differently is what
        // stops a caller pasting one into the other.
        const afterRaw = url.searchParams.get('after');
        let after: Date | undefined;
        if (afterRaw !== null) {
            after = new Date(afterRaw);
            // REFUSED, never ignored. Ignoring returns page one, which a
            // paging client reads as having reached the end — and then as
            // duplicates when it has not. `INVALID_CURSOR` is the code the DM
            // inbox and the feed already use; a synonym would be two codes for
            // one condition.
            if (Number.isNaN(after.getTime())) {
                throw codedBadRequest('INVALID_CURSOR', 'after must be an ISO timestamp.');
            }
        }

        const thread = await readPostReplies(ctx, postId, { limit, after });
        return jsonResponse(thread);
    },
);

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ postId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { postId } = await params;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
        }
        const parsed = CreateChannelReplySchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'body is required.');
        }

        const reply = await replyToPost(ctx, postId, parsed.data);
        return jsonResponse(reply, { status: 201 });
    },
);
