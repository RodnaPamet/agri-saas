/**
 * Reply to a channel post — P9.3b (#2937).
 *
 * Addressed by the POST id rather than `/channels/{channelId}/posts/{postId}`,
 * because the channel is derived from the parent row. A channel id in the path
 * would be redundant and could DISAGREE with the parent's — and then one of
 * the two has to win silently.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { replyToPost } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { CreateChannelReplySchema } from '@/lib/schemas';

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
