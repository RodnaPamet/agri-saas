import { NextRequest } from 'next/server';
import { z } from 'zod';

import { disputeFarmClaim } from '@/app-layer/usecases/farm-identity-review';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * Dispute a farm-identity claim — "this is not your farm" (#2963).
 *
 * ## Why the page needs this and not only `verify`
 *
 * `disputeFarmClaim`'s docblock makes the argument: it deliberately does NOT
 * require an ЕИК, because *"a reviewer who has established that the claim is
 * wrong may not have a correct number to supply, and demanding one would make
 * the refusal path harder than the approval path."*
 *
 * A console that wired only `verify` would do exactly that — approving is a
 * field and a button, refusing is a terminal — and a reviewer facing that
 * asymmetry is being nudged toward approval, which is the opposite of what
 * identity verification wants. Owner ruling 2026-11-10: wire it.
 *
 * ## It is NOT the collision case, and the two must stay distinguishable
 *
 * `DISPUTED_COLLISION` comes out of `verify`: two farms claim one ЕИК, and the
 * SYSTEM noticed. This is a reviewer's verdict about one claim, reached from
 * evidence the system does not hold. Both end with `status = DISPUTED`, which
 * is why the reason is recorded — without it the row cannot say which of the
 * two happened.
 *
 * ## A VERIFIED claim is not disputable here, and that is the usecase's rule
 *
 * Unwinding one has to unwind `FarmProfile.eik` and whatever has been filed
 * from it, which is a deliberate operator action rather than a queue button.
 * The usecase answers `ALREADY_VERIFIED` and this route maps it to 409 — the
 * same code and the same meaning as its keyed sibling, because two doors
 * answering differently for one outcome is how a client comes to believe two
 * things about one claim.
 *
 * `reviewedBy` comes from the SESSION, never the body — see the verify route
 * beside this one for why that is the one real improvement over the keyed
 * door.
 */
const Body = z.object({
    /**
     * Why, for the audit trail. **Not shown to the claiming farm** — the
     * usecase's own words. So this is a note to the next reviewer, not a
     * notice to the farm, and a rejection notice is a separate question (see
     * the issue on `REJECTED`).
     */
    reason: z.string().trim().min(1).max(500),
});

const STATUS_FOR: Record<string, number> = {
    DISPUTED: 200,
    NOT_FOUND: 404,
    ALREADY_VERIFIED: 409,
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
                // A REASON IS REQUIRED and that is deliberate. Both the
                // collision case and this one leave `status = DISPUTED`, so a
                // reasonless dispute produces a row that cannot say which
                // happened — and the next reviewer inherits a verdict with no
                // grounds.
                throw codedBadRequest('INVALID_BODY', 'A reason is required.');
            }

            const outcome = await disputeFarmClaim({
                claimId,
                reason: parsed.data.reason,
                reviewedBy: ctx.userId,
            });

            return jsonResponse({ result: outcome.result }, { status: STATUS_FOR[outcome.result] });
        },
    ),
);

export const runtime = 'nodejs';
