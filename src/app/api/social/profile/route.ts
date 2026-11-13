/**
 * The caller's own public display name — #2989.
 *
 * GET is the SIGNAL both clients prompt from (`displayName: null` means
 * "nothing to show"); PUT sets or clears it. Person-scoped, like every other
 * `/api/social/` route, because `PersonProfile` is keyed on a user and a
 * tenant route would be the wrong shape for it.
 *
 * ## Gated on `social.channels`, which is not the obvious key
 *
 * A reader would expect a profile editor to have a flag of its own. It
 * deliberately does not: channels is the only consumer today, and two flags
 * means an operator can enable channels while leaving the name editor off —
 * which is precisely the state #2989 exists to prevent, where every post
 * shows the farm alone and nobody can do anything about it. One switch, so
 * the entry point cannot be dark while the feature that needs it is live.
 *
 * If a second consumer appears (P6's public profile is the candidate), this
 * becomes a flag of its own and the two are enabled together — an additive
 * change, made when there is a second caller rather than in anticipation.
 *
 * ## NOT under `/api/account/`
 *
 * That family is exempt from the #1655 deletion freeze, on the reasoning that
 * self-service account management is not "content". A public display name IS
 * content: it is published to every member of every channel. Under
 * `/api/social/` the freeze applies, so a person 30 days into an erasure
 * request cannot publish a new public name.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { readOwnProfile, setOwnDisplayName } from '@/app-layer/usecases/person-profile';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { SetDisplayNameSchema } from '@/lib/schemas';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req, { surface: 'social' });
    await assertFeatureEnabled('social.channels', ctx.userId);
    return jsonResponse(await readOwnProfile(ctx));
});

export const PUT = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req, { surface: 'social' });
    await assertFeatureEnabled('social.channels', ctx.userId);

    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
    }
    const parsed = SetDisplayNameSchema.safeParse(raw);
    if (!parsed.success) {
        throw codedBadRequest('INVALID_BODY', 'displayName is required.');
    }

    return jsonResponse(
        await setOwnDisplayName(ctx, { displayName: parsed.data.displayName }),
    );
});
