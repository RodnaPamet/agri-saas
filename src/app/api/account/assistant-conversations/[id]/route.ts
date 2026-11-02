/**
 * ONE exchange — read it, or delete it (#2695, #2721).
 *
 *   GET    /api/account/assistant-conversations/{id} -> 200 {id, …, items[]}
 *   DELETE /api/account/assistant-conversations/{id} -> 200
 *
 * The GET exists because the list returns `opening` and nothing else, so the
 * phone's «Минали разговори» screen could show rows it could not open
 * (agrent-ios#521/#507). With the turns it renders the exchange and lets the
 * person continue it by passing `conversationId` to the stream route (#2694).
 *
 * A conversation that is not the caller's answers NOT FOUND, never FORBIDDEN.
 * A 403 would confirm the id exists — the posture P5.2b takes for a person
 * block and the profile verbs take for a remembered point, for the same
 * reason: these ids are about people.
 *
 * The delete is a TOMBSTONE. FIVE readers touch turns — the window replay, the
 * id resolver, the extraction sweep, recall, and the GET below — so a hard
 * delete would be a claim about every one of them, including ones not written
 * yet. A tombstone they each filter is checkable. The GET is the fifth, and it
 * filters in the `where`: a tombstoned conversation answers exactly what a
 * nonexistent id answers, so removing an exchange removes it from both.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import {
    deletePastConversation,
    getPastConversation,
} from '@/app-layer/usecases/assistant-conversations-control';

/** A string LITERAL — `social-routes-flag-gated` extracts literals only. */
const MEMORY_FLAG = 'assistant.memory';

export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        const ctx = await getUserCtx(req);
        await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
        const { id } = await params;
        await deletePastConversation(ctx.userId, id);
        return jsonResponse({ ok: true }, { status: 200 });
    },
);

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        const ctx = await getUserCtx(req);
        await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
        const { id } = await params;
        return jsonResponse(await getPastConversation(ctx.userId, id), { status: 200 });
    },
);
