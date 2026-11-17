/**
 * `GET /api/admin/moderation/unexplained-decisions` — moderation decisions
 * that produced NO statement of reasons (#2996).
 *
 * ## Why this is not a filter on the statements route
 *
 * `GET /api/admin/moderation/statements` answers "which statements exist and
 * have not been sent". It ranges over `StatementOfReasons`, so it
 * structurally cannot see a decision that produced none — the mirror question.
 * The two failures also want different remedies: dispatch is stuck, versus
 * nobody was ever going to be told.
 *
 * A separate route rather than a `?view=` parameter on that one, because the
 * two return different ENTITIES — statements there, actions here. One endpoint
 * whose response shape depends on a query parameter is the shape
 * `uniform-failure-shape-blinds-the-client` warns about, one level up.
 *
 * ## Why it is still worth having after #2955
 *
 * #2955 closed both CAUSES: a derived guard makes a removable kind with no
 * recipient arm unshippable, and `missingRow` logs at `warn` when a supported
 * kind's row has since been deleted. What is left is durability and
 * queryability — a log line is searchable until it rotates, and an auditor
 * asking "show me every moderation decision with no statement of reasons"
 * wants a query over rows. #2996 states its own priority as low for exactly
 * that reason: this is an auditor's convenience over a state that should now
 * be rare and is reported when it happens.
 *
 * ## The rate limit is enforced INLINE, and that is not a style choice
 *
 * `resolveRateLimitScope` returns null for any non-mutation method, so
 * `rateLimit: { config }` on a GET is a control that cannot execute — the
 * P5.6a lesson. Four of this route's neighbours declare exactly that and
 * enforce nothing; measured and filed as #3155. So this one passes
 * `rateLimit: false` to say plainly that the wrapper is not doing it, and
 * calls `enforceRateLimit` itself with the same primitives the wrapper would
 * have used. Do not "tidy" this into the options object.
 *
 * The Edge does not cover it either: `apiReadRateLimit` reaches `/api/t/**`
 * plus person paths, and `/api/admin/*` is excluded from the public read tier
 * — on a stated reason that #3155 shows to be half false.
 *
 * ## Platform key, not a session
 *
 * `ModerationAction` and `StatementOfReasons` are TENANTLESS, so
 * `admin.manage` would let an ADMIN of any one farm read every other farm's
 * moderation history. The session-gated console (#2735) is the natural home
 * for a human-facing version and its second half is not built; when it is, it
 * reads the same usecase rather than a second query.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { listDecisionsWithoutStatement } from '@/app-layer/usecases/moderation';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { parseLimitParam } from '@/lib/validation/query-params';

export const runtime = 'nodejs';

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        try {
            verifyPlatformApiKey(req);
        } catch (err) {
            if (err instanceof PlatformAdminError) {
                return NextResponse.json({ error: err.message }, { status: err.status });
            }
            throw err;
        }

        // AFTER the key check, so an unauthenticated caller cannot consume the
        // budget — the `account/export` ordering, for the same reason.
        const limited = await enforceRateLimit(req, {
            scope: 'platform-moderation-unexplained',
            config: LOGIN_LIMIT,
        });
        if (limited.response) return limited.response;

        const limit = parseLimitParam(req.nextUrl.searchParams.get('limit'), { max: 200 });
        return jsonResponse({ decisions: await listDecisionsWithoutStatement(limit) });
    },
    { rateLimit: false },
);
