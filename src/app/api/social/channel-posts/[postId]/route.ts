/**
 * `GET /api/social/channel-posts/{postId}` — one post, for the permalink (#3030).
 *
 * ## Why it did not already exist
 *
 * #3030 says "the read path is built; this is a page over it". Measured, that
 * was not quite true: `readPostReplies` reads the parent only to VALIDATE it
 * and returns the replies alone, and the feed returns top-level posts for a
 * CHANNEL. Nothing returned a single post by id, which is exactly what a
 * permalink is.
 *
 * ## A removed post answers 200, not 404
 *
 * `readPost` goes through `toPostView`, so a post hidden by any of the three
 * removal columns comes back present, with an empty body and no author. That
 * is deliberate: the link may be sitting in somebody's push notification from
 * before the removal, and a 404 would read as "that never existed" rather than
 * "that is gone". The row's existence is not the secret — its content is, and
 * the collapse is what withholds it.
 *
 * A genuinely absent id is `CHANNEL_POST_NOT_FOUND`. The distinction is
 * meaningful here because `channel_post_select` admits any authenticated
 * caller, so a null row is an absent row rather than a policy refusal.
 *
 * ## A REPLY is readable by its own id
 *
 * Unlike `…/replies`, which refuses a reply as a parent because a thread is one
 * level deep (P9.3b). A push for a reply names the REPLY, so a permalink to one
 * is a legitimate thing to hold — the response carries `parentPostId` so a page
 * can show the parent for context.
 *
 * ## No ETag, unlike the library reads
 *
 * A post's reply count and its removal state both change, and this is not on
 * the offline-persist allowlist — a channel is the surface a farmer refreshes,
 * not one they carry. `jsonWithETag` is for reads whose answer is stable for
 * months.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { readPost } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ postId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { postId } = await params;

        return jsonResponse(await readPost(ctx, postId));
    },
);
