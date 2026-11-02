/**
 * Delete ONE exchange (#2695).
 *
 *   DELETE /api/account/assistant-conversations/{id} -> 200
 *
 * A conversation that is not the caller's answers NOT FOUND, never FORBIDDEN.
 * A 403 would confirm the id exists — the posture P5.2b takes for a person
 * block and the profile verbs take for a remembered point, for the same
 * reason: these ids are about people.
 *
 * The delete is a TOMBSTONE. Four readers touch turns — the window replay, the
 * id resolver, the extraction sweep and recall — so a hard delete would be a
 * claim about every one of them, including ones not written yet. A tombstone
 * they each filter is checkable.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { deletePastConversation } from '@/app-layer/usecases/assistant-conversations-control';

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
