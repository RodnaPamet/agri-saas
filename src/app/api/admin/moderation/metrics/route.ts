/**
 * `GET /api/admin/moderation/metrics` — what P5's exit criterion asks for
 * (P5.4 Exit, #1595).
 *
 * ## Why a route and not a dashboard figure
 *
 * P5's exit is "median notice handling under 24h", and #1595's is that the
 * median be **measured** from `createdAt` to `deliveredAt`, "not estimated".
 * Until now it was neither: the statements route's own docblock said the
 * number was "measurable", which was true and insufficient — nothing computed
 * it, so the figure a regulator can ask for did not exist. "Measurable" and
 * "measured" differ by exactly this file.
 *
 * It sits behind `verifyPlatformApiKey` like its three siblings, and reads no
 * encrypted column: timestamps and counts only. A moderator's rationale and a
 * statement's body are not in the answer, so the operator figure cannot become
 * a way to read moderation content.
 *
 * ## TWO clocks, because the repo defined the criterion two ways
 *
 * `docs/runbooks/dsa-moderation-contact.md` and `CLAUDE.md` said the lag runs
 * from `ContentReport.createdAt` to the `ModerationAction`; #1595's exit
 * criterion and the statements route said to `StatementOfReasons.deliveredAt`.
 * Both were written in this repo and neither noticed the other.
 *
 * They are different duties — how fast somebody DECIDED, and how fast the
 * notifier was ANSWERED under Art 17 — and an action taken and never explained
 * leaves the notifier knowing nothing, so neither subsumes the other. Both are
 * reported. Choosing one silently would have made the published figure
 * unfalsifiable: a reader could not tell which question the number answered.
 *
 * `answer.n` can never exceed `decision.n`, and the GAP between them is the
 * set of notices decided and never explained — a figure nothing else surfaces.
 *
 * ## Every figure reports its own denominator
 *
 * `n` is how many notices in the window reached that stage. When it is 0 the
 * median is `null`, never 0 — a deployment that has answered nothing must not
 * publish "median 0 seconds", the most flattering possible reading of no data.
 * On this VM today the honest answer IS n=0 for both clocks, and that is what
 * it will say.
 *
 * ## The two queue figures are failures, not backlog
 *
 * `undelivered` is statements queued and never sent, which is an Art 17 breach
 * rather than a to-do: the action is recorded, the notice reads ACTIONED, and
 * the recipient never heard. `unalerted` is #1599's alert queue — a notice no
 * human has been told about. Both are reported with the age of the oldest
 * item, because a count of 3 says nothing about whether it is 3 minutes or 3
 * weeks of breach.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseModerationWindow, withWindowVerdict } from '@/lib/validation/query-params';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { moderationHandlingStats } from '@/app-layer/usecases/moderation';

export const runtime = 'nodejs';

/** The same shape as the sibling routes, so a key failure answers identically. */
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

// The window bound moved to `@/lib/validation/query-params` as
// `parseModerationWindow` (#2735): this figure is now read through two doors,
// and two local copies of the bound is how they come to answer different
// questions with nothing failing. `withWindowVerdict` is the same argument one
// field over (#3010) — a bad `windowDays` still answers 30, and the payload now
// says it did.

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        // Enforced HERE, not by the wrapper — #3155. `resolveRateLimitScope`
        // returns null for any non-mutation method, so the
        // `rateLimit: { config }` this route used to declare was a control
        // that could not execute. The Edge covers neither: `apiReadRateLimit`
        // reaches `/api/t/**` plus person paths, and `/api/admin/*` is
        // excluded from the public read tier. AFTER the gate, so an
        // unauthenticated caller cannot spend the budget.
        const limited = await enforceRateLimit(req, {
            scope: 'platform-moderation-metrics',
            config: LOGIN_LIMIT,
        });
        if (limited.response) return limited.response;

        const resolved = parseModerationWindow(req.nextUrl.searchParams.get('windowDays'));
        const stats = await moderationHandlingStats(resolved.windowDays);
        return jsonResponse(withWindowVerdict(stats, resolved));
    },
    { rateLimit: false },
);
