/**
 * PUT /api/account/bottom-tabs — set the caller's own bottom-row arrangement.
 *
 * Self-service, mirroring `/api/account/language`: it acts ONLY on the
 * authenticated session user, with no userId parameter, so one user can never
 * rearrange another's bar. Account-level rather than tenant-scoped — the
 * vocabulary is route suffixes, which mean the same thing in every tenant —
 * and therefore no `requirePermission`.
 *
 * `auth()` rather than `getServerSession`, because a native client holds a
 * BEARER session and this is the endpoint its customiser writes through.
 *
 * There is deliberately no GET here. The arrangement is returned by
 * `/api/auth/me`, which a client already fetches at launch — a second
 * round-trip before the tab bar can be drawn is real cost on rural LTE, and
 * one read path is easier to keep honest than two.
 */
import type { NextRequest } from 'next/server';
import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {codedBadRequest } from '@/lib/errors/types';
import {
    BottomTabOrderSchema,
    updateOwnBottomTabOrder,
    MAX_BOTTOM_TABS,
} from '@/lib/account/bottom-tabs';

export const PUT = withApiErrorHandling(async (req: NextRequest) => {
    // `getUserCtx`, not `auth()` (#1579). It refuses three callers this route
    // used to answer: an `iflk_` API key presented as a person credential
    // (which must not be served as the cookie's user), an MFA-pending session,
    // and — on a social surface — the operator-only persona. This is an
    // `account` surface, so a MECHANISATOR is correctly NOT refused.
    const ctx = await getUserCtx(req);

    const body = await req.json().catch(() => null);
    // `{ order: null }` restores the default arrangement; `{ order: [] }` is a
    // deliberately empty bar. The two are different states, so a missing key
    // is rejected rather than treated as either.
    const parsed = BottomTabOrderSchema.safeParse(
        body && typeof body === 'object' && 'order' in body
            ? (body as { order: unknown }).order
            : undefined,
    );
    if (!parsed.success) {
        throw codedBadRequest(
            'INVALID_TAB_ORDER',
            `order must be null, or an array of up to ${MAX_BOTTOM_TABS} unique non-empty ids.`,
            { max: String(MAX_BOTTOM_TABS) },
        );
    }

    const result = await updateOwnBottomTabOrder(ctx.userId, parsed.data);
    return jsonResponse(result, { status: 200 });
});
