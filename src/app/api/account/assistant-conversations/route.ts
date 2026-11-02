/**
 * «Какво помни асистентът» — the EXCHANGES half (#2695).
 *
 *   GET    /api/account/assistant-conversations  -> PastConversation[]
 *   DELETE /api/account/assistant-conversations  -> { deleted }
 *
 * Under `/api/account/**` and NOT `/api/t/{slug}/**`, because the owner's
 * scope is "all exchanges from all sessions with a user" — person-scoped
 * across farms. A tenant route would hide the exchanges the person had in
 * their other farms, and would do it silently.
 *
 * Gated on the SAME flag as the profile half. One screen, one switch: an
 * operator turning memory off must not leave half of «Какво помни асистентът»
 * live.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import {
    deleteAllPastConversations,
    listPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';

/** A string LITERAL — `social-routes-flag-gated` extracts literals only. */
const MEMORY_FLAG = 'assistant.memory';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
    const conversations = await listPastConversations(ctx.userId);
    return jsonResponse({ conversations }, { status: 200 });
});

export const DELETE = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
    // The COUNT, for the reason the profile's forget-all returns one: "nothing
    // to delete" and "deleted everything" are different answers and a person
    // notices which they got.
    const deleted = await deleteAllPastConversations(ctx.userId);
    return jsonResponse({ deleted }, { status: 200 });
});
