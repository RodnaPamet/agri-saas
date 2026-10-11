/**
 * `GET /api/account/export` — everything we hold about the caller (P5.6, #1597).
 *
 * ## `getUserCtx`, not `auth()`
 *
 * The `/api/account/**` convention since #1579, and it matters more here than
 * on its siblings. `getUserCtx` refuses three callers `auth()` would serve: an
 * `iflk_` API key presented as a person credential, an MFA-pending session, and
 * the operator-only persona on a social surface. An export is the single most
 * disclosing response this API produces — one call returns a person's notices,
 * the statements written about them, their messages and their enquiries — so
 * "is this really that person, fully authenticated" is the whole question.
 *
 * A MECHANISATOR is correctly NOT refused: this is an `account` surface, and a
 * machine operator has the same right to their own data as anyone.
 *
 * ## The rate limit is enforced INLINE, because the wrapper's cannot fire here
 *
 * This is a GET, and `resolveRateLimitScope` returns `null` for anything not in
 * `MUTATION_METHODS` — so a `rateLimit: { config }` option on this route would
 * be a control that cannot execute. I wrote exactly that first, with a docblock
 * explaining the budget, and it was inert.
 *
 * The route still needs one: each call is a dozen indexed reads across a dozen
 * tables, and the caller can repeat it. The Edge read tier does not reach here
 * either — `API_READ_LIMIT` covers `/api/t/**` GETs, not `/api/account/**`. So
 * `rateLimit: false` says plainly that the wrapper is not doing it, and
 * `enforceRateLimit` is called directly with the same primitives the wrapper
 * would have used.
 *
 * `EMAIL_DISPATCH_LIMIT` (hourly, small) is the closest tier in shape: an
 * expensive, never-legitimate-in-bulk self-service action. Exercising a
 * data-subject right twice a minute is not a thing anyone needs to do.
 *
 * ## Why no file download
 *
 * It returns JSON with `Content-Disposition: attachment`, not a generated
 * archive. Machine-readable is what Art 20 asks for, JSON is that, and a
 * streamed zip would add a build step and a temp file for no gain at this
 * volume. The filename carries no user id — `CFNetwork` logs URLs, and a
 * `Content-Disposition` value ends up in a browser's download history.
 */
import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { EMAIL_DISPATCH_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { contentDisposition } from '@/lib/http/content-disposition';
import { exportPersonalData } from '@/app-layer/usecases/personal-data-export';

export const runtime = 'nodejs';

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const ctx = await getUserCtx(req);

        // Keyed on the authenticated user, AFTER authentication — so an
        // unauthenticated caller cannot consume a real person's budget, and a
        // CGNAT egress cannot throttle a village (`rate-limit-identity`'s
        // reason for keying authenticated presets by user at all).
        const limited = await enforceRateLimit(req, {
            scope: 'account-data-export',
            config: EMAIL_DISPATCH_LIMIT,
            userId: ctx.userId,
        });
        if (limited.response) return limited.response;

        // The caller's OWN id, from the verified credential. There is no path
        // by which a request can name a different subject — no query
        // parameter, no body — because a route that could would be an
        // arbitrary personal-data read behind a person's own session.
        const payload = await exportPersonalData(ctx.userId);

        return new Response(JSON.stringify(payload, null, 2), {
            status: 200,
            headers: {
                'content-type': 'application/json; charset=utf-8',
                // Through the helper, never hand-assembled —
                // `content-disposition-converged` fails CI on a hand-built
                // value, because site twelve is what reintroduces #1343's
                // Bulgarian-filename defect. A fixed name with no user id and
                // no email: this value lands in download history and in logs.
                'content-disposition': contentDisposition('agrent-my-data.json'),
                // Never cached anywhere. The canonical spelling, which
                // `web-platform-identifiers` pins against a rename.
                'cache-control': 'no-store, max-age=0',
            },
        });
    },
    {
        // NOT the wrapper's job here: it only limits MUTATION_METHODS, so a
        // config passed on a GET is a control that cannot execute. Enforced
        // inline above instead.
        rateLimit: false,
    },
);
