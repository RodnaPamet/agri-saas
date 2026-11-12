import { NextRequest } from 'next/server';

import { z } from 'zod';

import { listFarmClaims } from '@/app-layer/usecases/farm-identity-review';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest, codedBadRequest } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseCsvEnumParam, parseLimitParam } from '@/lib/validation/query-params';

/**
 * The farm-identity review queue, for a PERSON — #2963.
 *
 * ## Why a second door exists at all
 *
 * P3.9 shipped the whole mechanism: the usecase, `GET /api/admin/farm-claims`,
 * and `POST /api/admin/farm-claims/{claimId}/verify`. Both are gated by
 * `verifyPlatformApiKey`, and both are Edge-reachable — measured by importing
 * the real `isPublicPath` rather than grepping for the entry. Nothing was
 * severed.
 *
 * What was missing is a way IN for a human. Measured 2026-11-10: **one claim,
 * PENDING since 2026-10-13** — 28 days — because reviewing it meant holding
 * `PLATFORM_ADMIN_API_KEY` and composing a request by hand. That is the #2844
 * shape rather than the Edge shape: a complete, reachable mechanism that
 * nothing offers anybody.
 *
 * A browser cannot use the first door. It holds no key, and shipping one would
 * put a long-lived platform credential in every user's bundle
 * (`NEXT_PUBLIC_*` is inlined at BUILD time); asking the operator to paste it
 * into a form is worse than the terminal it replaces. So this is a second door
 * for a PERSON, and the keyed routes stay exactly as they are — for scripts,
 * and for an incident where the session path is the broken thing. #2706 made
 * that call for the flag console and the reasoning transfers verbatim.
 *
 * ## The two gates, and why `admin.manage` alone is not one
 *
 * `requirePermission('admin.manage')` is necessary and NOT sufficient:
 * permissions resolve from Role, so every tenant's admin holds it — and
 * `FarmIdentityClaim` has no `tenantId` at all, so an ADMIN of any farm could
 * otherwise verify ANOTHER farm's identity. That is a worse version of the
 * flag console's problem, where the shared object was a feature row; here it
 * is who a farm claims to be.
 *
 * `assertPlatformSupport(ctx)` restricts this to the designated platform
 * tenant and 404s everywhere else, so an unrelated tenant's owner is not even
 * told the console exists. The session cookie is what the Edge already reads,
 * which is why this route needs no `PUBLIC_PATH` entry — unlike its keyed
 * sibling, which needs one precisely because a key is not a cookie.
 *
 * ## It returns no ЕИК, because it holds none
 *
 * `FarmIdentityClaim` stores `eikHash` — `hashForLookup(eik, 'eik')` — and
 * never the number. That is not a limitation the page works around: it is what
 * makes the review independent. The reviewer looks the farm up in the register
 * and types what they find; the system checks it against the hash. A queue
 * that displayed the claimed number would turn the check into a transcription
 * exercise, which is the one thing `verifyFarmClaim`'s input shape — "the ЕИК
 * the reviewer found in the register. Never read from the row." — exists to
 * prevent.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);

        const url = new URL(req.url);
        const limit = parseLimitParam(url.searchParams.get('limit'), { max: 100 });

        // THE SHARED HELPER, not a hand-rolled membership check. My first
        // draft compared the raw value against three literals and threw an
        // invented `INVALID_QUERY_VALUE`, which would have been a fourth
        // spelling of "bad filter value" and a code with no catalogue entry.
        // `parseCsvEnumParam` is what the exchange and grain list routes use
        // and it refuses an unrecognised member in one place.
        //
        // An unrecognised status must be REFUSED rather than ignored: ignoring
        // it answers with the default queue under a filter the caller asked for
        // and did not get, so a reviewer looking for DISPUTED claims would read
        // a list of PENDING ones as "there are none".
        //
        // The schema is the USECASE's three, not `z.nativeEnum(
        // FarmIdentityClaimStatus)`. The Prisma enum has a FOURTH member,
        // `REJECTED`, and `ClaimStatus` in `farm-identity-review.ts` does not
        // — so `nativeEnum` would accept a filter the usecase cannot take.
        // (That mismatch is bridged by an `as ClaimStatus` cast on the read
        // and is filed separately; nothing writes `REJECTED` today, so it is
        // latent rather than live.)
        const statuses = parseCsvEnumParam(
            url.searchParams.get('status'),
            z.enum(['PENDING', 'VERIFIED', 'DISPUTED']),
            'status',
        );
        // The usecase takes ONE status, so more than one is refused rather
        // than silently truncated to the first — which would be the same
        // "filter you asked for and did not get" defect one level in.
        if (statuses && statuses.length > 1) {
            throw badRequest('status accepts a single value.');
        }

        const beforeRaw = url.searchParams.get('before');
        let before: Date | undefined;
        if (beforeRaw !== null) {
            before = new Date(beforeRaw);
            if (Number.isNaN(before.getTime())) {
                throw codedBadRequest('INVALID_CURSOR', 'before must be an ISO timestamp.');
            }
        }

        const claims = await listFarmClaims({
            // PENDING by default: the queue is work outstanding, and that is
            // what somebody opening this screen came for. The other two
            // statuses are reachable by filter so a resolved claim can be
            // looked up, not so the default view buries the backlog in them.
            status: statuses?.[0] ?? 'PENDING',
            limit,
            before,
        });
        return jsonResponse({ claims });
    }),
);

export const runtime = 'nodejs';
