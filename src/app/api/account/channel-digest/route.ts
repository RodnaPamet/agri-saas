/**
 * PUT /api/account/channel-digest — set the caller's own 07:15 digest opt-in.
 *
 * Self-service, mirroring `/api/account/bottom-tabs` and `/api/account/language`:
 * it acts ONLY on the authenticated session user, with no userId parameter, so
 * one person can never change another's notification settings. Account-level
 * rather than tenant-scoped — the column is on `User` and a channel has no
 * farm — and therefore no `requirePermission`.
 *
 * There is deliberately no GET, which is the `bottom-tabs` convention and the
 * same reason: the current value is returned by `/api/auth/me`, which a client
 * already fetches at launch, so a second round-trip before a settings switch
 * can be drawn is cost on rural LTE for nothing. One read path is also easier
 * to keep honest than two.
 */
import type { NextRequest } from 'next/server';
import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedBadRequest } from '@/lib/errors/types';
import {
    ChannelDigestOptInSchema,
    updateOwnChannelDigestOptIn,
} from '@/lib/account/channel-digest';

export const PUT = withApiErrorHandling(async (req: NextRequest) => {
    // `getUserCtx`, not `auth()` (#1579) — it refuses an `iflk_` API key
    // presented as a person credential and an MFA-pending session. This is an
    // `account` surface, so a MECHANISATOR is correctly not refused: the
    // digest is about channels they can read like anybody else.
    const ctx = await getUserCtx(req);

    const body = await req.json().catch(() => null);
    const parsed = ChannelDigestOptInSchema.safeParse(body);
    if (!parsed.success) {
        throw codedBadRequest(
            'INVALID_DIGEST_OPT_IN',
            'optIn must be a boolean.',
        );
    }

    const result = await updateOwnChannelDigestOptIn(ctx.userId, parsed.data.optIn);
    return jsonResponse(result, { status: 200 });
});
