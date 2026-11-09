/**
 * Mark a «Въпрос» as «Решено», or un-mark it — P9.3b (#2937).
 *
 * A PUT with a boolean rather than POST/DELETE, because the state is one
 * nullable column and a caller setting it to what it already is should be a
 * no-op rather than a conflict.
 *
 * The ASKER only, enforced in the usecase: `channel_post_update`'s WITH CHECK
 * already pins the author, but it cannot tell a QUESTION from a POST without a
 * CHECK naming an enum value, which would need rewriting whenever the enum
 * grows.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { setQuestionResolved } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { SetChannelQuestionResolvedSchema } from '@/lib/schemas';

export const PUT = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ postId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { postId } = await params;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
        }
        const parsed = SetChannelQuestionResolvedSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'resolved must be a boolean.');
        }

        const result = await setQuestionResolved(ctx, postId, parsed.data.resolved);
        return jsonResponse(result);
    },
);
