/**
 * GET /api/account/avatar/[userId] — serve a user's uploaded avatar.
 *
 * Avatar roadmap P3. `User.image` for an uploaded avatar points here,
 * so this is the stable, provider-agnostic URL every avatar surface
 * renders (member list, people-picker, chrome). It streams the stored
 * webp from whichever storage backend is configured — no presigned-URL
 * expiry to leak into the DB.
 *
 * Auth — every authenticated user may fetch a user's avatar (avatars
 * are shown across tenant member lists; they are low-sensitivity). A
 * missing avatar resolves to a 404; `<InitialsAvatar>` then falls back
 * to initials via its `onError` path.
 *
 * Wrapped in `withApiErrorHandling`: on the success path the image
 * streams through (the wrapper just appends correlation headers); a
 * thrown auth/not-found error becomes a JSON 4xx, which an `<img>`
 * treats as a load failure → initials fallback.
 */
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import {notFound } from '@/lib/errors/types';
import { getAvatarStream } from '@/lib/account/avatar';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params }: { params: Promise<{ userId: string }> },
    ): Promise<Response> => {
        // `getUserCtx`, not `auth()` (#1579), and the returned context is
        // deliberately DISCARDED — this route's subject is the `userId` in the
        // path, not the caller. What the call is for is the three refusals it
        // makes that a bare `auth()` does not: an `iflk_` API key presented as
        // a person credential, an MFA-pending session, and (on a social
        // surface) the operator-only persona. The rule here is unchanged —
        // "every authenticated user may fetch a user's avatar" — and this is
        // what now enforces the "authenticated PERSON" half of it.
        //
        // The `_req` rename is load-bearing: `getUserCtx` derives the person
        // surface from the request path, and without a request it would fall
        // back to `account` by assumption rather than by derivation.
        await getUserCtx(req);

        const { userId } = await params;
        const stream = await getAvatarStream(userId);
        if (!stream) throw notFound('Avatar not found.');

        return new Response(
            Readable.toWeb(stream) as unknown as ReadableStream,
            {
                status: 200,
                headers: {
                    'Content-Type': 'image/webp',
                    // Private — avatars sit behind auth. Short TTL so a
                    // changed avatar propagates within minutes.
                    'Cache-Control': 'private, max-age=300',
                },
            },
        );
    },
);
