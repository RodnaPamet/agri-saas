import { NextRequest } from 'next/server';

import { listDecisionsWithoutStatement } from '@/app-layer/usecases/moderation';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseLimitParam } from '@/lib/validation/query-params';

/**
 * Decisions that produced NO statement of reasons — the SESSION door (#2996).
 *
 * ## Why there are two doors, and why this is the one that matters
 *
 * #2996 says the session-gated console is "the natural home for a human-facing
 * version", and then says that console's second half "is not built yet, so
 * this may belong with it rather than before it". **That premise is stale**:
 * measured 2026-11-17, all five of its views — notices, statements, metrics,
 * restore, suspensions — exist under this segment. So the human-facing home
 * exists, and an auditor asking "show me every moderation decision with no
 * statement of reasons" is a human.
 *
 * Building only the platform-key sibling would have left the question
 * answerable by a script and not by the console where every other moderation
 * view lives. That is #2844's shape — a surface that is reachable and that
 * nothing offers.
 *
 * ## The gate is BOTH checks, and each is load-bearing
 *
 * `requirePermission('admin.manage')` resolves from Role, so every tenant's
 * admin holds it — and `ModerationAction` and `StatementOfReasons` are
 * TENANTLESS, so that alone would let an ADMIN of any one farm read every
 * other farm's moderation history. `assertPlatformSupport(ctx)` is what
 * narrows it to the platform tenant. Same pairing as the five siblings, and
 * the farm-claim console's reason verbatim.
 *
 * ## Why the ATTRIBUTION difference does not apply here
 *
 * #2735's whole subject is that the two doors attribute a DECISION
 * differently: the keyed route reads `reviewedBy` from the body, the session
 * route takes `ctx.userId`. This view writes nothing, so there is no actor to
 * record and the two doors return the same rows. The keyed sibling stays for
 * scripts; neither is a fallback for the other.
 *
 * ## No rate limit here, deliberately
 *
 * Unlike the keyed sibling, this is behind a session AND the platform-tenant
 * check, which is the same posture its five neighbours take — none of them
 * rate-limits its GET. The keyed route needs its own because a key-holder is
 * not a session and `/api/admin/*` is outside every Edge read tier; see #3155
 * for why that one is enforced inline rather than declared.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            assertPlatformSupport(ctx);
            const url = new URL(req.url);
            // The shared parser: `??` does not catch NaN, and `LIMIT NaN`
            // reaches Postgres as a 500 on `?limit=abc`.
            const limit = parseLimitParam(url.searchParams.get('limit'), { max: 200 });
            return jsonResponse({ decisions: await listDecisionsWithoutStatement(limit) });
        },
    ),
);
