import { NextRequest } from 'next/server';
import { z } from 'zod';

import { verifyFarmClaim, type VerifyOutcome } from '@/app-layer/usecases/farm-identity-review';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * Verify a farm-identity claim, from the review page — #2963.
 *
 * The second door's reasoning is on the queue route beside this one. In short:
 * both P3.9 routes gate on a platform API key, a browser cannot hold one, and
 * #2706 established the session-gated sibling as the answer rather than
 * pasting a credential into a form.
 *
 * ## `reviewedBy` COMES FROM THE SESSION, and that is the one real improvement
 *
 * The keyed sibling reads it from the BODY — `reviewedBy: parsed.data.reviewedBy`
 * — so a script supplies its own attribution, and whoever holds the key can
 * type any name into the audit trail. That is the weakness #2735 exists to
 * fix, and this route is the first place in the review path that does not have
 * it: `ctx.userId` is resolved from the session cookie, so the trail names a
 * PERSON the Edge authenticated rather than a string the caller chose.
 *
 * `Body` deliberately has NO `reviewedBy` field, so a caller cannot supply
 * one. That is the flag console's rule verbatim — "a caller-supplied name in
 * an attribution field is worse than an absent one, and this is not
 * caller-supplied."
 *
 * It does not fix the keyed route. Scripts depend on that field and removing
 * it is a breaking change to a surface this issue is not about; it is recorded
 * here so the difference between the two doors is legible rather than
 * accidental.
 *
 * ## The ЕИК is SUPPLIED, never confirmed
 *
 * `verifyFarmClaim`'s input says it: *"The ЕИК the reviewer found in the
 * register. Never read from the row."* The claim stores `eikHash` and nothing
 * returns a number, so the reviewer looks the farm up independently and types
 * what they find; the usecase checks it against the hash and rehashes under
 * the current `LOOKUP_HMAC_KEY`.
 *
 * **So there is no approve button anywhere in this flow, by construction.** A
 * route that promoted a claim on a bare POST would let a reviewer verify
 * without doing the lookup, which is the single thing that input shape
 * prevents. #2963 as filed called the evidence question open; it was answered
 * in P3.4 and the answer is the shape of this body.
 *
 * ## Seven outcomes, each with its own status
 *
 * The map is COPIED from the keyed route rather than re-derived, because two
 * doors onto one usecase answering different statuses for the same outcome is
 * how a client comes to believe two different things about one claim. An
 * outcome neither route classifies is a 500 on purpose: the transition may
 * well have happened, and answering 200 would tell the reviewer it definitely
 * did.
 */
const Body = z.object({
    /**
     * The ЕИК, as a STRING. Never a number: an ЕИК may be 9 or 13 digits, a
     * 13-digit value exceeds the safe integer range for exact arithmetic, and
     * a leading zero would be eaten by a numeric round-trip.
     */
    eik: z.string().trim().min(1).max(32),
});

const STATUS_FOR: Record<VerifyOutcome['result'], number> = {
    VERIFIED: 200,
    ALREADY_VERIFIED: 200,
    DISPUTED_COLLISION: 409,
    EIK_MISMATCH: 422,
    EIK_INVALID: 400,
    ALREADY_DISPUTED: 409,
    NOT_FOUND: 404,
};

export const POST = withApiErrorHandling(
    // The params type rides the GENERIC and the handler destructures `{ params }`
    // unannotated — the convention every other permissioned route here uses.
    // My first draft annotated `routeArgs: { params: { … } }` inline, which
    // `async-params-route-typing` correctly flags: a SYNC annotation on a route
    // handler compiles while the access is undefined at runtime, and the guard
    // cannot tell a hand-resolved inner handler from a mistake. Inference costs
    // nothing and keeps the route inside the rule.
    requirePermission<{ tenantSlug: string; claimId: string }>(
        'admin.manage',
        async (req: NextRequest, { params }, ctx) => {
            assertPlatformSupport(ctx);
            const { claimId } = params;

            let raw: unknown;
            try {
                raw = await req.json();
            } catch {
                throw codedBadRequest('INVALID_JSON', 'The request could not be read.');
            }
            const parsed = Body.safeParse(raw);
            if (!parsed.success) {
                throw codedBadRequest('INVALID_BODY', 'An ЕИК is required.');
            }

            const outcome = await verifyFarmClaim({
                claimId,
                eik: parsed.data.eik,
                // FROM THE SESSION. See the docblock: the keyed door takes
                // this from the body, which lets the caller name anybody.
                reviewedBy: ctx.userId,
            });

            return jsonResponse({ result: outcome.result }, { status: STATUS_FOR[outcome.result] });
        },
    ),
);

export const runtime = 'nodejs';
