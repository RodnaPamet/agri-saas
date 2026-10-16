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
import { getAvatarObject } from '@/lib/account/avatar';

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
        const object = await getAvatarObject(userId);
        if (!object) throw notFound('Avatar not found.');

        // `no-cache` is NOT `no-store` (#1953): the bytes stay in the
        // browser's cache, they are just revalidated before use. A matching
        // `If-None-Match` is answered below with a bodyless 304 — a few
        // hundred bytes instead of 5–25 KB — so this is cheaper than it
        // looks AND a changed avatar appears on the next request.
        //
        // It replaces `max-age=300`, whose comment said "short TTL so a
        // changed avatar propagates within minutes". Minutes is the problem:
        // a farmer who changes their picture and sees the old one has no way
        // to tell that waiting would fix it. The phone paid for this too —
        // agrent-ios showed the just-uploaded image locally rather than
        // refetching, because the URL never changes between uploads.
        const headers = {
            'Content-Type': 'image/webp',
            'Cache-Control': 'private, no-cache',
            ETag: object.etag,
        };

        // A conditional request that still matches costs no body. The header
        // may carry a LIST, and a weak validator arrives `W/"…"` — neither
        // shape is produced here, but both are produced by caches, so parse
        // rather than compare the raw string.
        const inm = req.headers.get('if-none-match');
        if (inm !== null) {
            const matches = inm
                .split(',')
                .map((candidate) => candidate.trim().replace(/^W\//, ''))
                .some((candidate) => candidate === object.etag || candidate === '*');
            if (matches) {
                // The stream was opened to answer this request and nothing
                // will read it. Destroy it rather than leaking the handle.
                object.stream.destroy();
                return new Response(null, { status: 304, headers });
            }
        }

        return new Response(
            Readable.toWeb(object.stream) as unknown as ReadableStream,
            { status: 200, headers },
        );
    },
);
