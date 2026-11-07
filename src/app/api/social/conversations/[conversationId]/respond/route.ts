/**
 * `POST /api/social/conversations/[conversationId]/respond` — accept or
 * decline a request (P8.2, #2796).
 *
 * ## One route with a decision, not `/accept` and `/decline`
 *
 * Both are the same state transition on the same row by the same person, and
 * a single route means the "only the other party may answer, only once"
 * check exists once. Two routes would be two copies of it.
 *
 * ## Privileged underneath, and `Conversation` must NOT get an app_user arm
 *
 * The usecase writes `Conversation.state` through the privileged client
 * because the table has no `app_user` UPDATE policy — and giving it one would
 * let the person who OPENED a request accept it themselves, which is the whole
 * thing a request protects against. So the authorisation is in the usecase:
 * a participant who is not the initiator, on a conversation still in REQUEST.
 *
 * ## A decline is FINAL and keeps its row
 *
 * `ConversationState.DECLINED` exists rather than deleting the conversation
 * precisely so the same person cannot re-open the same request — a decline
 * that removed the row would be a decline that lasts until the next attempt.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { respondToConversation } from '@/app-layer/usecases/direct-messages';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { RespondToConversationSchema } from '@/lib/schemas';

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
        const parsed = RespondToConversationSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'decision must be ACCEPT or DECLINE.');
        }

        const result = await respondToConversation(ctx, conversationId, parsed.data.decision);
        return jsonResponse(result, { headers: { 'Cache-Control': 'no-store' } });
    },
);
