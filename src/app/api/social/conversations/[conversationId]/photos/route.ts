/**
 * `POST /api/social/conversations/[conversationId]/photos` — send a
 * photograph (P8.6, #2800).
 *
 * ## Why a separate route from `…/messages`
 *
 * That one takes JSON. This takes `multipart/form-data`, and
 * `upload-route-scan-reachability` derives its population from exactly that —
 * routes that read `formData()` and handle a `File`. One route doing both
 * would make the body shape conditional on a field, which is the kind of
 * branch a scan-reachability check cannot follow.
 *
 * ## Person-scoped, so it lives here and not under `/api/t/[tenantSlug]/`
 *
 * The DM policies key on `app.user_id`, which only `runInUserContext` sets. A
 * tenant route would read zero rows with no error — #1664 — which on an upload
 * surface would look like "the conversation vanished" rather than a refusal.
 *
 * ## No `getBucket`
 *
 * The cost of a photograph lands on the sender's own conversation, not on a
 * shared resource, so the per-caller key is the right one and
 * `API_MUTATION_LIMIT` is what bounds it. `DM_OPEN_LIMIT`'s 5-per-hour is
 * about OPENING threads with strangers — the abusable act there is reaching
 * people who never asked, which sending into an already-accepted conversation
 * is not.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { sendDirectPhoto, DM_PHOTO_MAX_BYTES } from '@/app-layer/usecases/direct-message-photos';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params }: { params: Promise<{ conversationId: string }> },
    ): Promise<Response> => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);

        const { conversationId } = await params;

        const form = await req.formData().catch(() => null);
        if (!form) throw codedBadRequest('INVALID_BODY', 'Expected a multipart upload.');

        const file = form.get('photo');
        if (!(file instanceof File)) {
            throw codedBadRequest('INVALID_BODY', 'Expected a `photo` file.');
        }

        // Checked BEFORE the bytes are read into memory. `file.size` is what
        // the multipart parser already knows, so refusing here avoids
        // buffering four megabytes to then refuse them — and the usecase
        // checks the buffer again, because this number is the caller's.
        if (file.size > DM_PHOTO_MAX_BYTES) {
            throw codedBadRequest('FILE_TOO_LARGE', 'That photograph is too large.');
        }

        const caption = form.get('body');
        const sent = await sendDirectPhoto(ctx, {
            conversationId,
            bytes: Buffer.from(await file.arrayBuffer()),
            body: typeof caption === 'string' ? caption : null,
        });

        return jsonResponse(sent, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    },
);
