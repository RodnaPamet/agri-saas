/**
 * `POST /api/social/channels/[channelId]/media` — post a photograph or a
 * voice note (P9.6, #2940).
 *
 * ## ONE route for both kinds, unlike the DM pair
 *
 * The DM photo route's own docblock argues for a separate route from
 * `…/messages` because that one takes JSON and this takes
 * `multipart/form-data` — and `upload-route-scan-reachability` derives its
 * population from exactly that, routes reading `formData()` and handling a
 * `File`. That argument still holds and is why this is not folded into
 * `…/posts`.
 *
 * It does NOT argue for two upload routes. Both kinds arrive as multipart,
 * both are in the derived population, and the FIELD NAME decides which —
 * `photo` or `voice`. A second route would duplicate the gate, the flag check
 * and the size pre-check for no gain, and the thing that must not be
 * conditional on a field is the body SHAPE, which here is multipart either
 * way.
 *
 * Exactly one of the two fields is required. Both at once is a refusal rather
 * than a precedence rule: a post carries ONE attachment (the schema says so
 * with a single key column), and silently preferring one would make the other
 * vanish without telling the caller.
 *
 * ## Person-scoped, so it lives here and not under `/api/t/[tenantSlug]/`
 *
 * The channel policies key on `app.user_id`, which only `runInUserContext`
 * sets. A tenant route would read zero rows with no error — #1664 — which on
 * an upload surface looks like "the channel vanished" rather than a refusal.
 *
 * ## No `getBucket`
 *
 * The cost lands on the caller's own post, not on a shared resource, so the
 * per-caller key is right and `API_MUTATION_LIMIT` bounds it. The channel's
 * own `slowModeSeconds` is the per-channel throttle and is checked in the
 * gate, which is where an operator can turn it up on a flooded channel.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import {
    postChannelPhoto,
    postChannelVoiceNote,
    CHANNEL_PHOTO_MAX_BYTES,
    VOICE_NOTE_MAX_BYTES,
} from '@/app-layer/usecases/channel-media';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params }: { params: Promise<{ channelId: string }> },
    ): Promise<Response> => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        // The flag is a string LITERAL so an operator holding the console can
        // find what gates this route by reading it — `social-routes-flag-gated`
        // extracts literals only, and an interpolated key reads as static to a
        // naive matcher while being unfindable.
        await assertFeatureEnabled('social.channels', ctx.userId);

        const { channelId } = await params;

        const form = await req.formData().catch(() => null);
        if (!form) throw codedBadRequest('INVALID_BODY', 'Expected a multipart upload.');

        const photo = form.get('photo');
        const voice = form.get('voice');

        /*
         * Narrowed with the real type guards rather than two booleans, because
         * `hasPhoto === hasVoice` tells TypeScript nothing about either value —
         * it reported `'voice' is possibly null` through an early return that a
         * reader finds obvious. A cast would have silenced that and removed the
         * target a later mistake fails against, so the shape below narrows
         * instead: each branch re-states the guard it depends on.
         */
        const caption = form.get('body');
        const body = typeof caption === 'string' ? caption : null;

        if (photo instanceof File && !(voice instanceof File)) {
            // Checked BEFORE the bytes are read into memory: `file.size` is
            // what the multipart parser already knows, so refusing here avoids
            // buffering four megabytes to then refuse them. The usecase checks
            // the buffer again, because this number is the caller's.
            if (photo.size > CHANNEL_PHOTO_MAX_BYTES) {
                throw codedBadRequest('FILE_TOO_LARGE', 'That photograph is too large.');
            }
            const posted = await postChannelPhoto(ctx, channelId, {
                bytes: Buffer.from(await photo.arrayBuffer()),
                body,
            });
            return jsonResponse(posted, { status: 201, headers: { 'Cache-Control': 'no-store' } });
        }

        if (voice instanceof File && !(photo instanceof File)) {
            if (voice.size > VOICE_NOTE_MAX_BYTES) {
                throw codedBadRequest('FILE_TOO_LARGE', 'That recording is too large.');
            }
            /*
             * The duration is a FORM FIELD, not a header and not a query
             * parameter. A query parameter would put it in the URL, which iOS
             * writes to the device log unsuppressably — harmless for a number,
             * and the habit is worth keeping where it costs nothing.
             *
             * Parsed here and validated in the usecase: this layer only decides
             * whether a number arrived at all, so the refusal for a 40-minute
             * claim lives with the cap it is measured against rather than being
             * spelled twice.
             */
            const declared = form.get('durationMs');
            const durationMs = typeof declared === 'string' ? Number(declared) : NaN;
            if (!Number.isFinite(durationMs)) {
                throw codedBadRequest('VOICE_NOTE_DURATION_REQUIRED', 'Expected `durationMs`.');
            }

            const posted = await postChannelVoiceNote(ctx, channelId, {
                bytes: Buffer.from(await voice.arrayBuffer()),
                durationMs,
                body,
            });
            return jsonResponse(posted, { status: 201, headers: { 'Cache-Control': 'no-store' } });
        }

        /*
         * Covers both "neither" and "both", which is deliberate: the two
         * mistakes have the same fix — send exactly one — and splitting them
         * into two codes would add a Bulgarian entry that says the same thing
         * twice. A post carries ONE attachment (the schema has a single key
         * column), so silently preferring one would make the other vanish
         * without telling the caller.
         */
        throw codedBadRequest(
            'INVALID_BODY',
            'Expected exactly one of a `photo` or a `voice` file.',
        );
    },
);
