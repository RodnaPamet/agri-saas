/**
 * `POST /api/social/conversations` — open a conversation with a farm (P8.2, #2796).
 *
 * ## Under `/api/social/`, not `/api/t/[tenantSlug]/`
 *
 * A direct conversation is person-scoped: the two people may share no farm. A
 * tenant route runs `runInTenantContext`, which sets `app.actor_user_id` and
 * deliberately NOT `app.user_id` — the variable every DM policy keys on — so
 * under a tenant route these reads return ZERO rows with no error,
 * indistinguishable from having no conversations. That is #1664, and it is the
 * same reason P5.2a put the reporting routes here.
 *
 * ## Gated on a string LITERAL
 *
 * `social-routes-flag-gated` extracts gate keys from literal arguments only,
 * and its reason is the operator's: somebody holding the flag console has to be
 * able to find the flag that gates a route by reading the route. Its own
 * mutation proof found the hole that makes this strict — an interpolated
 * template contains no quote character, so a quotes-only matcher read a
 * COMPUTED key as a literal one. So the key is repeated at every call site
 * rather than hoisted to a `const`, which a human could follow and the guard
 * cannot.
 *
 * Unlike the reporting routes next door, this is a product feature rather than
 * a legal duty, so it gates and 404s while the flag is off.
 *
 * ## A HANDLE in the body, not a user id
 *
 * The recipient is resolved server-side to the farm's active owner (owner
 * ruling 2026-11-06). Accepting a user id instead would let a caller address
 * anybody by guessing an id; a handle is a farm's own published identifier,
 * and the resolution happens behind `dm-recipient-resolution`, whose bound is
 * the ORDER of its reads — the published profile is asked first, so an
 * unpublished farm never resolves to a tenant at all.
 *
 * ## `DM_OPEN_LIMIT`, because the default tier does not bind
 *
 * 5 per hour. `API_MUTATION_LIMIT` is 60/min, so "one sender messaging 100
 * strangers" — P8's own hardening criterion — is under two minutes of ordinary
 * use. See the preset's docblock for why the WINDOW rather than the rate is
 * the lever.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { openConversationFromHandle } from '@/app-layer/usecases/direct-messages';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { OpenConversationSchema } from '@/lib/schemas';
import { DM_OPEN_LIMIT } from '@/lib/security/rate-limit';

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const ctx = await getUserCtx(req, { surface: 'social' });
        await assertFeatureEnabled('social.direct-messages', ctx.userId);

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            throw codedBadRequest('INVALID_JSON', 'Request body must be JSON.');
        }
        const parsed = OpenConversationSchema.safeParse(raw);
        if (!parsed.success) {
            throw codedBadRequest('INVALID_BODY', 'handle is required.');
        }

        const opened = await openConversationFromHandle(ctx, parsed.data.handle);
        return jsonResponse(opened, { status: 201 });
    },
    { rateLimit: { config: DM_OPEN_LIMIT, scope: 'dm-open' } },
);
