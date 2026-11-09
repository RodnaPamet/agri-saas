/**
 * Join and leave a channel — P9.3a (#2937).
 *
 * Both are the PERSON'S OWN ACT, which is the whole point of P9.2's rule:
 * channels are suggested, never joined automatically. Nothing else in the
 * codebase may write a `ChannelMembership` — held by
 * `tests/guards/channels-are-never-auto-joined.test.ts`, whose allowlist
 * names this file and nothing else.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { joinChannel, leaveChannel } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        const result = await joinChannel(ctx, channelId);
        return jsonResponse(result, { status: result.alreadyMember ? 200 : 201 });
    },
);

export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        await leaveChannel(ctx, channelId);
        return jsonResponse({ left: true });
    },
);
