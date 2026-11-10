/**
 * Post to a channel — P9.3a (#2937).
 *
 * The three access rules (no forged author, no non-member, no banned member)
 * are enforced by `channel_post_insert`'s WITH CHECK in the DATABASE, not
 * here — the usecase runs in user context precisely so they are. What the
 * usecase adds is slow mode, which compares against other rows of the same
 * table and so cannot live in a policy on it.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { postToChannel } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { CreateChannelPostSchema } from '@/lib/schemas';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
        }
        const parsed = CreateChannelPostSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'body is required.');
        }

        const post = await postToChannel(ctx, channelId, {
            body: parsed.data.body,
            mentionUserIds: parsed.data.mentionUserIds,
            // Mapped EXPLICITLY, like its siblings. A spread would be shorter
            // and would also skip TypeScript's excess-property check, which is
            // how a field added to the schema reaches the usecase as
            // `undefined` with a green typecheck.
            kind: parsed.data.kind,
        });
        return jsonResponse(post, { status: 201 });
    },
);
