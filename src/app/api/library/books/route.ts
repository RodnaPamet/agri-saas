/**
 * `GET /api/library/books` — «Вдъхновение», the directory (#2980).
 *
 * ## NON-TENANT, which is an owner ruling with a mechanism behind it
 *
 * Owner ruling 2026-11-13: the surface lives outside the tenant tree. A book
 * belongs to no farm, and the path shape is what makes it reach every role.
 *
 * `isOperatorAllowedPath` is an ALLOWLIST and would deny `/api/library/...`
 * read in isolation. What makes this safe is the CALL SITE, not the function —
 * and it is TWO gates rather than the one #2980 names. The operator lockdown
 * sits inside `if (isTenantPath(pathname))`, which excludes this path before
 * anything else is evaluated; the inner `slug &&` condition is belt and braces
 * within tenant paths. Measured, because the difference is invisible from the
 * code: removing the inner condition alone changes nothing here.
 *
 * I read the function first and concluded the opposite — the same mistake
 * #2948 cost in this exact area, and the reason `existing-is-not-mounted` is a
 * rule here. `tests/unit/library-reaches-the-operator.test.ts` drives the real
 * middleware so the claim is executed rather than written down.
 *
 * ## SIGNED-IN, and deliberately NOT in `PUBLIC_PATH_PREFIXES`
 *
 * Owner ruling, and the mechanism matters: opening a prefix opens EVERY METHOD
 * on it, and this repo's rule is that a public surface must also authenticate
 * itself in the handler. A library is not a legal duty — unlike the Art 16
 * notice route, which is anonymous BY DUTY — nothing about it wants to be
 * anonymous, and a signed-in read costs the phone nothing because it already
 * holds a session. A marketing-page library later is a `/f/`-style surface and
 * its own decision.
 *
 * `getUserCtx`, not `getTenantCtx`: there is no slug in the path to resolve,
 * and the policy admits either session variable anyway.
 *
 * ## The flag key is a STRING LITERAL at each call site
 *
 * Not hoisted to a `const`, for `social/blocks`' stated reason:
 * `social-routes-flag-gated` extracts literal arguments only, and an operator
 * holding the flag console has to be able to find the flag that gates a route
 * by reading the route. `src/app/api/library/` is declared as a root in that
 * guard, so a second library route that forgets the gate fails CI.
 *
 * ## jsonWithETag, like every other hot list read
 *
 * #2980 §3(b). The catalogue changes when a book is added — months apart — so
 * almost every revalidation is a 304 and a few dozen bytes. That is what makes
 * "keep the body offline, revalidate cheaply" true rather than aspirational.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonWithETag } from '@/lib/http/etag';
import { listBooks } from '@/app-layer/usecases/library';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled('library.enabled', ctx.userId);

    const books = await listBooks(ctx);
    // Wrapped in an object rather than returned as a bare array — the #2980 §3
    // contract, and it leaves room for a future `nextCursor` without changing
    // the response's TYPE, which is what a bare array would have cost.
    return jsonWithETag(req, { books });
});
