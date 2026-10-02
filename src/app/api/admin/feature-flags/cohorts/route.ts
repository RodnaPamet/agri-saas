/**
 * Platform flag console — cohort membership.
 *
 * HTTP boundary only; the queries and log lines live in
 * `@/app-layer/usecases/feature-flag-admin`.
 *
 * ── why this route exists at all ──
 *
 * `FeatureFlag.cohorts` is the limited-rollout half of the flag design: enabled
 * AND a member of one of these cohorts. Without an operator path to POPULATE a
 * cohort, setting one makes the flag unreachable for everybody and the cohort
 * mechanism is inert — code-complete and never delivered. The sibling route
 * sets the cohort NAMES on a flag; this one puts people in them.
 *
 * ── membership is by `userId`, not by email, until P1.1 ──
 *
 * Resolving an email would mean a 17th `hashForLookup` call site — added in the
 * week before P1.1 re-keys that derivation onto `LOOKUP_HMAC_KEY`, so it would
 * be a site that migration has to find and nothing would point it there. A
 * `userId` is stable across that change. `GET` lists the ids in a cohort so the
 * console is self-describing once the first member is in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import {
    listCohortSizes,
    listCohortMembers,
    addCohortMember,
    removeCohortMember,
} from '@/app-layer/usecases/feature-flag-admin';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

/**
 * A cohort name. Same bound as the sibling's `cohorts[]` entries, because the
 * two must agree: a name settable on a flag but not creatable here (or the
 * reverse) is a rollout an operator can half-configure.
 */
const CohortKey = z.string().min(1).max(64);

const MemberBody = z.object({
    cohort: CohortKey,
    userId: z.string().min(1).max(64),
});

/** Convert the verifier's typed failure into its HTTP answer. */
function platformGate(req: NextRequest): NextResponse | null {
    try {
        verifyPlatformApiKey(req);
        return null;
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
}

/** Members of one cohort, or every cohort's size when `cohort` is omitted. */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    const cohort = req.nextUrl.searchParams.get('cohort');

    if (cohort === null) {
        return jsonResponse({ cohorts: await listCohortSizes() });
    }

    const parsed = CohortKey.safeParse(cohort);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const { members, truncated } = await listCohortMembers(parsed.data);
    return jsonResponse({ cohort: parsed.data, members, truncated });
});

/** Add a user to a cohort. Idempotent — see the usecase. */
export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }
        const body = MemberBody.parse(raw);

        const { added } = await addCohortMember(body.cohort, body.userId);
        return jsonResponse({ cohort: body.cohort, added });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-flag-cohorts' } },
);

/**
 * Remove a user from a cohort. Idempotent, and 200 for a non-member.
 *
 * Both parameters are required: without them this would be a request to empty
 * a whole cohort, which is not an operation this surface offers.
 */
export const DELETE = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const params = req.nextUrl.searchParams;
        const parsed = MemberBody.safeParse({
            cohort: params.get('cohort'),
            userId: params.get('userId'),
        });
        if (!parsed.success) {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }

        const { removed } = await removeCohortMember(parsed.data.cohort, parsed.data.userId);
        return jsonResponse({ cohort: parsed.data.cohort, removed });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-flag-cohorts' } },
);
