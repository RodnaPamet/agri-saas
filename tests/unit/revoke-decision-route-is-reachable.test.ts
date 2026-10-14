/**
 * Somebody can call `revokeDecision` (#1793).
 *
 * ## Why this file is not redundant with the usecase suite
 *
 * `tests/unit/usecases/revoke-decision.test.ts` is thorough and was green for
 * the whole time the capability was unreachable. That is the finding #1793
 * recorded: a complete, tested, audited usecase with ZERO callers — a
 * dedicated unit suite, guardrail coverage, two refusal codes of its own, and
 * an `ACCESS_REVIEW_DECISION_REVOKED` audit action that no real `AuditLog`
 * could ever contain. Its tests proved the function behaves. Nothing could
 * prove anyone could reach it, and nothing noticed.
 *
 * So this drives the real route handler. The sibling
 * `tests/integration/access-review-api.test.ts` asserts the wiring by reading
 * the route's source text, which is the house style for that surface and worth
 * having; it would also pass against a file that exports a handler nobody can
 * successfully call. This one calls it.
 *
 * ## The mistake it is built around
 *
 * The path carries TWO ids — `/access-reviews/{reviewId}/decisions/{decisionId}`
 * — and both are strings. So `revokeDecision(ctx, params.reviewId, body)`
 * type-checks perfectly, passes lint, and is wrong: every call would refuse
 * with `ACCESS_REVIEW_DECISION_NOT_FOUND` against a decision id that is really
 * a campaign id. The two ids here are deliberately distinguishable so that
 * swap is a failure rather than a coincidence.
 *
 * The same shape as `task-write-idempotency-forwarding.test.ts`'s argument:
 * deleting or mis-aiming a forwarding hop is WELL-TYPED, so only a test that
 * inspects what arrived can see it.
 */
import { NextRequest } from 'next/server';

import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';

let currentCtx: RequestContext = makeRequestContext('ADMIN', { userId: 'u-reviewer' });
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: async () => currentCtx,
}));

const revokeDecision = jest.fn();
// Only `revokeDecision` — the route imports exactly that one symbol, so a
// factory supplying it alone is sufficient AND avoids loading the real usecase
// module's dependency graph. (A partial `requireActual` spread is the rule when
// the module under test needs its siblings; here it needs none.)
jest.mock('@/app-layer/usecases/access-review', () => ({
    revokeDecision: (...args: unknown[]) => revokeDecision(...args),
}));

// REQUIRED, not imported, so it loads after the mocks above are registered —
// `import` hoisting would defeat them. Same reason as the task-write suite.
const route = require(
    '../../src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/revoke/route',
);

const REVIEW_ID = 'review-AAAA';
const DECISION_ID = 'decision-BBBB';
const URL_ = `http://x/api/t/acme/access-reviews/${REVIEW_ID}/decisions/${DECISION_ID}/revoke`;

function post(body: unknown): NextRequest {
    return new NextRequest(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function params() {
    return {
        params: Promise.resolve({
            tenantSlug: 'acme',
            reviewId: REVIEW_ID,
            decisionId: DECISION_ID,
        }),
    };
}

beforeEach(() => {
    revokeDecision.mockReset();
    revokeDecision.mockResolvedValue({ decisionId: DECISION_ID, accessReviewId: REVIEW_ID });
    currentCtx = makeRequestContext('ADMIN', { userId: 'u-reviewer' });
});

describe('POST .../decisions/{decisionId}/revoke', () => {
    it('reaches the usecase at all — the whole point of #1793', async () => {
        const res = await route.POST(post({ reason: 'Recorded against the wrong person.' }), params());

        expect(res.status).toBe(200);
        expect(revokeDecision).toHaveBeenCalledTimes(1);
    });

    it('passes the DECISION id, not the review id', async () => {
        await route.POST(post({ reason: 'Recorded against the wrong person.' }), params());

        // Both are strings, so the swap compiles. This is the assertion that
        // sees it.
        expect(revokeDecision.mock.calls[0][1]).toBe(DECISION_ID);
        expect(revokeDecision.mock.calls[0][1]).not.toBe(REVIEW_ID);
    });

    it('forwards the reason verbatim, because the reason IS the audit record', async () => {
        const reason = 'Reviewer confirmed the subject had already left the farm.';
        await route.POST(post({ reason }), params());

        expect(revokeDecision.mock.calls[0][2]).toEqual({ reason });
    });

    it('passes the tenant context, so the usecase can apply its own gates', async () => {
        await route.POST(post({ reason: 'Wrong verdict recorded.' }), params());

        // The reviewer-vs-admin check, the closed-campaign refusal and both
        // state refusals all live in the usecase and all read `ctx`. A route
        // that forwarded a fabricated context would hand them the wrong
        // identity and every gate would answer about the wrong person.
        expect(revokeDecision.mock.calls[0][0]).toBe(currentCtx);
    });

    it('answers with what the usecase returned', async () => {
        revokeDecision.mockResolvedValue({ decisionId: 'd-9', accessReviewId: 'r-9' });

        const res = await route.POST(post({ reason: 'Wrong verdict recorded.' }), params());

        expect(await res.json()).toEqual({ decisionId: 'd-9', accessReviewId: 'r-9' });
    });

    describe('the body is validated BEFORE the usecase runs', () => {
        // `reason` is mandatory because it is written into the audit entry.
        // A route that accepted a revocation without one would produce an
        // audit row asserting a reversal with no stated cause, which is worse
        // than refusing.
        it('refuses an absent reason', async () => {
            const res = await route.POST(post({}), params());

            expect(res.status).toBe(400);
            expect(revokeDecision).not.toHaveBeenCalled();
        });

        it('refuses a reason below the 3-char floor', async () => {
            const res = await route.POST(post({ reason: 'ab' }), params());

            expect(res.status).toBe(400);
            expect(revokeDecision).not.toHaveBeenCalled();
        });

        it('accepts the 3-char boundary, so the floor is the floor and not an off-by-one', async () => {
            // The other side of the boundary. Without it, raising the minimum
            // to any larger number would leave every case above still green.
            const res = await route.POST(post({ reason: 'abc' }), params());

            expect(res.status).toBe(200);
            expect(revokeDecision).toHaveBeenCalledTimes(1);
        });
    });
});
