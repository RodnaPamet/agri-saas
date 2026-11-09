/**
 * A channel and a page of its feed — P9.3a (#2937).
 *
 * Readable by a non-member, like the directory. `before` is the keyset cursor,
 * matching the `[channelId, createdAt]` index.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { CHANNEL_FEED_MAX_PAGE_SIZE, readChannelFeed } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { parseLimitParam } from '@/lib/validation/query-params';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ channelId: string }> }) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.channels', ctx.userId);
        const { channelId } = await params;

        const url = new URL(req.url);

        // The SHARED helper, not a local `Number(...)`. `limit-param-nan-safe`
        // derives its population from the filesystem precisely because four
        // routes once shared the expression `limitRaw ? Number(limitRaw) : …`
        // — and `Number('abc')` is NaN, which `??` does not catch and
        // `Math.min`/`Math.max` propagate, so `take: NaN` reached Prisma and
        // `?limit=abc` was a 500 on a plain list read.
        //
        // My first version used `Number.isInteger`, which IS NaN-safe. The
        // helper is still right: it localises the refusal (`INVALID_LIMIT`
        // carries a `reason` discriminator so the sentence is translated
        // rather than served as English prose) and it is one definition
        // instead of a fifth spelling.
        const limit = parseLimitParam(url.searchParams.get('limit'), {
            max: CHANNEL_FEED_MAX_PAGE_SIZE,
        });

        const beforeRaw = url.searchParams.get('before');

        let before: Date | undefined;
        if (beforeRaw !== null) {
            before = new Date(beforeRaw);
            // An unparseable cursor is REFUSED, never ignored. Ignoring it
            // silently returns page one, which reads to a paging client as
            // having reached the end — and then as a duplicate when it does
            // not.
            if (Number.isNaN(before.getTime())) {
                // `INVALID_CURSOR`, the code the DM inbox already uses for an
                // unreadable cursor — not a new `INVALID_QUERY`. A synonym
                // would mean two codes for one condition, and the catalogue
                // entry («Страницата не можа да бъде заредена.») is already
                // the right sentence for a client that cannot page.
                throw codedBadRequest('INVALID_CURSOR', 'before must be an ISO timestamp.');
            }
        }

        const feed = await readChannelFeed(ctx, channelId, { limit, before });
        return jsonResponse(feed);
    },
);
