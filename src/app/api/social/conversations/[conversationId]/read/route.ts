/**
 * `POST /api/social/conversations/[conversationId]/read` — move the caller's
 * read cursor (P8.2, #2796).
 *
 * ## A time, not a message id
 *
 * The cursor is an instant so a client that has read to the bottom does not
 * have to name the last message, and so two clients cannot disagree about
 * ordering. «Нови съобщения» (P8.3) is computed from it.
 *
 * ## Forward only, and zero rows is NOT an error
 *
 * `markConversationRead` updates only when the stored cursor is null or
 * earlier, so a client that double-taps, or one whose clock is behind, moves
 * nothing. A 404 on zero rows would make that look broken; the usecase logs it
 * at debug and the route answers 204.
 *
 * A cursor that could move BACKWARDS would let a client un-read a conversation
 * and re-trigger whatever P8.5's inbox counts. Nothing needs that: a client
 * that wants to re-show the divider re-renders rather than rewinding the
 * server.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { markConversationRead } from '@/app-layer/usecases/direct-messages';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { MarkConversationReadSchema } from '@/lib/schemas';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);
        const { conversationId } = await params;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
        }
        const parsed = MarkConversationReadSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'readAt must be an ISO instant.');
        }

        await markConversationRead(ctx, conversationId, new Date(parsed.data.readAt));
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    },
);
