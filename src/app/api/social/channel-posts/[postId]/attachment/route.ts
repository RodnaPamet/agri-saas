/**
 * `GET /api/social/channel-posts/[postId]/attachment` — serve a channel
 * post's photograph or voice note (P9.6, #2940).
 *
 * ## MEMBERSHIP, which is narrower than the post itself
 *
 * `channel_post_select` is public to any authenticated caller — P9.1's whole
 * argument is that nobody joins a channel they cannot look into first — so the
 * post's text and even its `attachmentKey` are readable by anybody signed in.
 * The BYTES are not: `readChannelAttachment` requires a membership row, and the
 * reason is the voice note rather than the photograph. A recording carries the
 * speaker's VOICE, which is a different class of personal data from their
 * words.
 *
 * The consequence for a client: a non-member reading a channel gets a post
 * whose text is there and whose media is 404. The UI must not render a broken
 * player or a placeholder for them — agrent-ios #2943 owns that, and it is
 * stated in the migration too because it is invisible from the schema.
 *
 * ## `no-store`, and therefore no ETag
 *
 * The DM photo route's reasoning, unchanged: these bytes must not sit in a
 * shared cache on a phone that may be lost, sold or handed on, and nothing is
 * added to `PERSISTABLE_PATHS`. With no caching there is nothing to revalidate
 * against, so there is no ETag either.
 */
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { readChannelAttachment } from '@/app-layer/usecases/channel-media';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params }: { params: Promise<{ postId: string }> },
    ): Promise<Response> => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);

        const { postId } = await params;
        const object = await readChannelAttachment(ctx, postId);

        return new Response(Readable.toWeb(object.stream) as ReadableStream, {
            status: 200,
            headers: {
                // The SNIFFED type recorded at upload. The image stripper
                // preserves format, so a channel can hold a JPEG and a PNG,
                // and an audio container is stored as it arrived.
                'Content-Type': object.mime,
                'Cache-Control': 'no-store',
                // What stops a browser deciding for itself what caller-supplied
                // bytes are. It goes WITH the stored type rather than instead
                // of it: a wrong stored type plus `nosniff` is a broken file
                // rather than a silently-corrected one, which is why the type
                // is recorded per post.
                'X-Content-Type-Options': 'nosniff',
            },
        });
    },
);
