/**
 * «Какво помни асистентът» — forget or edit ONE point (#2671).
 *
 *   DELETE /api/account/assistant-memory/{id}  -> 204
 *   PATCH  /api/account/assistant-memory/{id}  -> RememberedPoint
 *
 * PATCH exists for rule 6: a point the person EDITED is theirs, and the
 * extractor never rewrites it. Without an edit verb that rule has nowhere to
 * be expressed from the client, which is why agrent-ios needs it alongside
 * list and delete.
 *
 * A point belonging to somebody else answers NOT FOUND, never FORBIDDEN. A 403
 * would confirm the id exists — the same posture P5.2b takes for a person
 * block, and for the same reason.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import {
    editRememberedPoint,
    forgetRememberedPoint,
    REMEMBERED_POINT_MAX_CHARS,
} from '@/app-layer/usecases/assistant-memory';

const MEMORY_FLAG = 'assistant.memory';

const EditSchema = z.object({
    text: z.string().min(1).max(REMEMBERED_POINT_MAX_CHARS),
});

export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        const ctx = await getUserCtx(req);
        await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
        const { id } = await params;
        await forgetRememberedPoint(ctx.userId, id);
        return jsonResponse({ ok: true }, { status: 200 });
    },
);

export const PATCH = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        const ctx = await getUserCtx(req);
        await assertFeatureEnabled(MEMORY_FLAG, ctx.userId);
        const { id } = await params;
        const parsed = EditSchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) {
            throw codedBadRequest('MEMORY_POINT_INVALID', 'That remembered point is not valid.');
        }
        const point = await editRememberedPoint(ctx.userId, id, parsed.data.text);
        return jsonResponse(point, { status: 200 });
    },
);
