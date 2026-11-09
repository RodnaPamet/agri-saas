/**
 * The channel directory — P9.3a (#2937).
 *
 * HTTP boundary only: resolve the person, gate the flag, call the usecase.
 *
 * PERSON-scoped (`getUserCtx`), not tenant-scoped, because channel policies
 * key on `app.user_id` and only `runInUserContext` sets it. A tenant-context
 * read would return zero rows with no error (#1664). The one tenant-scoped
 * piece of P9.2's rule — suggesting channels from a farm's crops and oblast —
 * is a separate tenant route for exactly that reason.
 *
 * Readable by a NON-MEMBER: P9.2 cannot suggest a channel nobody can read, and
 * nobody joins one they cannot look into first.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { listChannels } from '@/app-layer/usecases/channels';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req, { surface: 'social' });
    await assertFeatureEnabled('social.channels', ctx.userId);

    const channels = await listChannels(ctx);
    return jsonResponse({ channels });
});
