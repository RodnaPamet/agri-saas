/**
 * `POST   /api/social/messages/[messageId]/reactions` — react.
 * `DELETE /api/social/messages/[messageId]/reactions` — remove your reaction.
 * P8.2 (#2796).
 *
 * ## DELETE takes a BODY, following `/api/social/blocks`
 *
 * The emoji could sit in the path, and the reason it does not is consistency
 * with the sibling route rather than secrecy: an emoji names no person. Keeping
 * both verbs on one path also means `message_reaction_delete`'s narrow
 * `USING ("userId" = app.user_id)` governs exactly one route.
 *
 * ## The split per command is what the policies are for
 *
 * `MessageReaction` has SELECT, INSERT and DELETE arms rather than one
 * `FOR ALL`, for `ExchangeBlock`'s reason one level down: a participant must
 * be able to SEE a reaction they did not write — asserted in
 * `p8-1-direct-message-rls` — without being able to remove it. A single USING
 * clause would have governed both.
 *
 * ## Adding is idempotent; removing is not
 *
 * `@@unique([messageId, userId, emoji])` makes a second press one row, and the
 * usecase swallows `P2002` for exactly that. A removal that matches nothing is
 * a not-found, because the client's view and the server's disagree and the
 * client should refetch.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { addReaction, removeReaction } from '@/app-layer/usecases/direct-messages';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { MessageReactionSchema } from '@/lib/schemas';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

async function emojiFrom(req: NextRequest): Promise<string> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
    }
    const parsed = MessageReactionSchema.safeParse(raw);
    if (!parsed.success) throw codedBadRequest('INVALID_BODY', 'emoji is required.');
    return parsed.data.emoji;
}

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);
        const { messageId } = await params;
        await addReaction(ctx, messageId, await emojiFrom(req));
        return new Response(null, { status: 204, headers: NO_STORE });
    },
);

export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);
        const { messageId } = await params;
        await removeReaction(ctx, messageId, await emojiFrom(req));
        return new Response(null, { status: 204, headers: NO_STORE });
    },
);
