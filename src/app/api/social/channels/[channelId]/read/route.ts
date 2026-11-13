/**
 * `POST /api/social/channels/{channelId}/read` — move the read cursor (#2990).
 *
 * The caller's own act on their own row, which is the whole justification
 * `channel_membership_update` was written with: P9.1 declared
 * `ChannelMembership.lastReadAt` and that policy together, and said so — *"the
 * caller's own act on their own row, which is why `channel_membership_update`
 * exists at all"*. Until this route the column had no writer, so that policy
 * was an RLS arm whose only stated reason was a write nobody had implemented.
 * Nothing in the schema or the policies changes here; the permission was
 * already granted and simply unused.
 *
 * ## No body, and the server decides the time
 *
 * A client-supplied timestamp would let a phone with a wrong clock park the
 * cursor in the future and silently suppress every later post, which is a
 * badge that never comes back rather than one that is merely wrong. The
 * usecase defaults to `new Date()` and takes the parameter only so a test can
 * be deterministic.
 *
 * ## POST and not PUT
 *
 * It is not idempotent in the sense PUT promises: the cursor advances with
 * each call because the value is "now". Calling twice leaves a later cursor
 * than calling once, so the method that claims replacement would be lying
 * about it.
 *
 * ## Gated like its siblings, and `surface: 'social'`
 *
 * `getUserCtx(req, { surface: 'social' })` is what applies the MECHANISATOR
 * lockdown — `isOperatorBlockedPersonPath` covers `/api/social/`, so a field
 * operator is refused here exactly as they are on the rest of the social
 * graph. The flag key is a STRING LITERAL because
 * `social-routes-flag-gated` extracts literals only, and an operator holding
 * the flag console has to be able to find the flag by reading the route.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { markChannelRead } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        return jsonResponse(await markChannelRead(ctx, channelId));
    },
);
