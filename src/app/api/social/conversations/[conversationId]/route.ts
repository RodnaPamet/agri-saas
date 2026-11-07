/**
 * `GET /api/social/conversations/[conversationId]` — read one conversation
 * and its messages (P8.2, #2796).
 *
 * ## A non-participant gets the SAME not-found a missing conversation gets
 *
 * P8's phase note: "Non-participants get 404, not 403." A 403 confirms the
 * conversation exists. The read runs under `runInUserContext`, so RLS returns
 * nothing for a non-participant and the empty result becomes the not-found —
 * the refusal is the database's, not this route's.
 *
 * The same applies to a BLOCK. `tests/unit/person-block-is-silent.test.ts`
 * asserts that property as a COMPARISON — run the call twice, blocked and
 * innocent, and require every observable to match — because "it was refused"
 * is not the property.
 *
 * ## The id is in the PATH, and that is safe where a user id would not be
 *
 * iOS logs the full URL including the path, unsuppressably, which is why
 * `DELETE /api/social/blocks` takes a person's id in its BODY. A conversation
 * id is a cuid that names no person, so the path is fine — and a path
 * parameter is what stops a client reading one conversation while naming
 * another.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { readConversation, DM_MESSAGE_PAGE_SIZE } from '@/app-layer/usecases/direct-messages';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { parseLimitParam } from '@/lib/validation/query-params';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);
        const { conversationId } = await params;

        // Paged since #2820: the first version returned every message and
        // decrypted every one of them. `parseLimitParam`, not a hand-rolled
        // `Number()` — `limit-param-nan-safe` exists because `Number('abc')`
        // is NaN, `??` does not catch NaN, and `take: NaN` is a 500.
        const limit = parseLimitParam(req.nextUrl.searchParams.get('limit'), {
            max: DM_MESSAGE_PAGE_SIZE,
        });

        return jsonResponse(
            await readConversation(ctx, conversationId, {
                ...(limit === undefined ? {} : { limit }),
                before: req.nextUrl.searchParams.get('before'),
            }),
            { headers: { 'Cache-Control': 'no-store' } },
        );
    },
);
