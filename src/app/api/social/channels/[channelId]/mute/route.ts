/**
 * Mute and unmute a channel — #3042.
 *
 * `POST` mutes, `DELETE` unmutes. The same pair-of-verbs shape as `join`,
 * where the resource is "the caller's mute on this channel" and the methods
 * create and remove it — rather than a `PATCH` carrying `{ muted: boolean }`,
 * which would make the state a value a client sends and therefore a value two
 * tabs can disagree about.
 *
 * ## Why this route exists at all
 *
 * `ChannelMembership.mutedAt` has been HONOURED since #2987 — `reachableTargets`
 * filters on it for every mention and reply — and writable by nobody. A mute
 * control on the phone would have done nothing while looking exactly like a
 * working one, which is the sentence #2987 was filed about. See
 * `setChannelMuted` for why it was orphaned between two issues rather than
 * merely unbuilt.
 *
 * ## Idempotent, and it reports the STORED state
 *
 * Muting a muted channel answers 200 with the existing `mutedAt` rather than
 * re-stamping it: that timestamp is when the person chose silence. A function
 * that echoed the request could not tell a caller it had done nothing, which
 * is #2990's lesson one route over.
 *
 * ## `CHANNEL_NOT_JOINED`, like the read cursor
 *
 * Deliberately not `CHANNEL_NOT_A_MEMBER` — that is the POSTING refusal and its
 * sentence is "join before posting in it", which is the wrong thing to say
 * about a mute. The code is shared with `markChannelRead` because the
 * situation is identical: there is no membership row to act on.
 *
 * ## Gated like its siblings
 *
 * `surface: 'social'` applies the MECHANISATOR lockdown via
 * `isOperatorBlockedPersonPath`, and the flag key is a string LITERAL so an
 * operator holding the console can find it by reading the route.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { setChannelMuted } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        return jsonResponse(await setChannelMuted(ctx, channelId, true));
    },
);

export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        return jsonResponse(await setChannelMuted(ctx, channelId, false));
    },
);
