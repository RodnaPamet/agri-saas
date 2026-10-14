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

import { withApiErrorHandling } from '@/lib/errors/api';
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

/**
 * Bounded, because an unbounded window is a different question.
 *
 * A lifetime median hides a regression — a service that answered quickly for a
 * year can be failing this month and the all-time figure will not move for a
 * long while. 365 is the ceiling rather than Infinity so the scan stays
 * bounded on a table that only grows.
 */
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

function parseWindowDays(raw: string | null): number {
    if (raw === null) return DEFAULT_WINDOW_DAYS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return DEFAULT_WINDOW_DAYS;
    return n;
}

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const windowDays = parseWindowDays(req.nextUrl.searchParams.get('windowDays'));
        return jsonResponse(await moderationHandlingStats(windowDays));
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-moderation-metrics' } },
);
