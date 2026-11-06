/**
 * `POST /api/social/conversations/[conversationId]/messages` — send (P8.2, #2796).
 *
 * ## `no-store`, and `PERSISTABLE_PATHS` stays untouched
 *
 * P8's phase note: "DM routes send no-store; DMs are never persisted on web".
 * `PERSISTABLE_PATHS` is an ALLOWLIST precisely so that persisting something
 * requires somebody's decision — adding a DM path would mean deciding that a
 * stranger's message is acceptable on a phone that may be lost, sold or handed
 * on. It is not, so no entry is added and `swr-persist-allowlist` keeps it
 * that way.
 *
 * `Cache-Control` is spelled exactly. `web-platform-identifiers` exists
 * because a project-wide rename silently turned 39 `Cache-Control` headers
 * into `Cache-Practice` — dropping `no-store` on evidence downloads — and the
 * whole suite stayed green, since every one of them is a string literal
 * TypeScript cannot check.
 *
 * ## The idempotency key arrives in the BODY, not the header
 *
 * `outboxHeaders()` puts an `Idempotency-Key` on an outbox-bound request, and
 * this route deliberately reads the body instead. The reason is that the
 * offline outbox replays through `public/sw.js`, which cannot import from
 * `src/`: its copy of the sender is written by hand, and a value in the stored
 * ITEM survives into the replay where a header assembled by a closure does
 * not. The body is the item.
 *
 * ## The default mutation tier, unlike the open route
 *
 * Opening a conversation is bounded by `DM_OPEN_LIMIT` (5/hour) because
 * starting threads with strangers is the abusable act. Sending into one the
 * counterparty has accepted keeps the default 60/min: they can block, and a
 * tight cap would make a real conversation feel broken.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { sendDirectMessage } from '@/app-layer/usecases/direct-messages';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { SendDirectMessageSchema } from '@/lib/schemas';

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
        const parsed = SendDirectMessageSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'body is required.');
        }

        const sent = await sendDirectMessage(ctx, {
            conversationId,
            body: parsed.data.body,
            ...(parsed.data.idempotencyKey
                ? { idempotencyKey: parsed.data.idempotencyKey }
                : {}),
        });
        return jsonResponse(sent, {
            status: sent.deduplicated ? 200 : 201,
            headers: { 'Cache-Control': 'no-store' },
        });
    },
);
