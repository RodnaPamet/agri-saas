/**
 * Epic G-4 — Revoke a recorded reviewer verdict (#1793).
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/decisions/:decisionId/revoke
 *
 * Body: `{ reason: string }` — 3..2000 chars, REQUIRED.
 *
 * ## Why this route exists
 *
 * `revokeDecision` was a complete capability with no way to invoke it: a
 * dedicated unit suite, guardrail coverage, two refusal codes of its own and an
 * audit action, and zero callers outside its own module. So its tests proved
 * the function behaves and could not prove anyone could call it, and
 * `ACCESS_REVIEW_DECISION_REVOKED` was an audit action the product could never
 * emit. Owner ruling 2026-10-14: revocation is a real reviewer need — mount it.
 *
 * ## POST to a sub-resource, not DELETE on the decision
 *
 * #1793 proposed `DELETE` on the decision path as "the obvious shape", and it
 * is the wrong one here on two counts.
 *
 *   · **The body is mandatory.** `reason` is not a convenience: it is written
 *     into the `ACCESS_REVIEW_DECISION_REVOKED` audit row, which is the whole
 *     point of revoking an audited control decision rather than silently
 *     overwriting it. A bodyless DELETE cannot carry it. Measured, this repo
 *     has 53 DELETE routes and exactly ONE validates a body — and that one is
 *     a route I added myself, so it is not precedent.
 *   · **DELETE would describe the wrong operation.** Nothing is deleted. The
 *     `AccessReviewDecision` row stays; its `decision` column returns to null
 *     so the reviewer can record a different verdict. A DELETE on the decision
 *     path says the decision resource is gone, and a client acting on that
 *     would stop showing a row that still exists and still needs a verdict.
 *
 * The action sub-resource is this repo's established shape for exactly this —
 * 16 of them, including `close` on THIS surface, plus `restore`, `reactivate`,
 * `approve`. `close` is the direct sibling and this follows it, with the
 * `withValidatedBody` wrapper the decision `PUT` next door already uses.
 *
 * Every gate — the reviewer-vs-admin check, the closed-campaign refusal, the
 * not-recorded and already-executed refusals — lives in the usecase, as it does
 * for `PUT` and `close`.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { revokeDecision } from '@/app-layer/usecases/access-review';
import { RevokeDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    withValidatedBody(
        RevokeDecisionSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{
                    tenantSlug: string;
                    reviewId: string;
                    decisionId: string;
                }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await revokeDecision(ctx, params.decisionId, body);
            return jsonResponse(result);
        },
    ),
);
