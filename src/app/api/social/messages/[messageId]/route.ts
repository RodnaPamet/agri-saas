/**
 * `PATCH  /api/social/messages/[messageId]` — edit your own message.
 * `DELETE /api/social/messages/[messageId]` — delete your own message.
 * P8.2 (#2796).
 *
 * ## Both run under the caller's own context, so RLS is the authority
 *
 * `direct_message_update`'s `USING` is `senderUserId = app.user_id`, so an
 * attempt on somebody else's message updates ZERO rows and RETURNS NORMALLY —
 * the silent shape P5.1's migration comment names. The usecase therefore reads
 * the COUNT and turns zero into a not-found, exactly as `unblockPerson` does:
 * without that, editing another person's message would answer 200 and the
 * client would show it as done.
 *
 * `person-blocks.ts` states why there is no application-level "am I the
 * sender" check here — a redundant one "would look like the control and would
 * be the thing a future refactor simplifies away, leaving the impression that
 * the guard was there".
 *
 * ## DELETE is SOFT
 *
 * The row stays with `deletedAt` set and its body cleared, because the
 * conversation is two people's record and because P5.3 needs a deleted message
 * to say so: «Сигнализирай» is not offered on a deleted message, and its
 * report snapshot would otherwise be an empty body indistinguishable from a
 * capture failure.
 *
 * The body is overwritten rather than left in place. A deleted message whose
 * text is still in the column is a message the counterparty cannot see and the
 * database still holds — which is not what "delete" means to the person who
 * pressed it, and which the Art 15 export would hand back.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { editDirectMessage, deleteDirectMessage } from '@/app-layer/usecases/direct-messages';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { EditDirectMessageSchema } from '@/lib/schemas';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const PATCH = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);
        const { messageId } = await params;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
        }
        const parsed = EditDirectMessageSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'body is required.');
        }

        await editDirectMessage(ctx, messageId, parsed.data.body);
        return new Response(null, { status: 204, headers: NO_STORE });
    },
);

export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);
        const { messageId } = await params;
        await deleteDirectMessage(ctx, messageId);
        return new Response(null, { status: 204, headers: NO_STORE });
    },
);
