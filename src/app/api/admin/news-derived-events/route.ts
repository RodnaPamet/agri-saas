import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { ListNewsDerivedEventsQuerySchema } from '@/app-layer/schemas/news-derived-event.schemas';
import { listNewsDerivedEvents } from '@/app-layer/usecases/news-derived-events';

/**
 * Platform-admin review queue for AI news-derived calendar-event proposals
 * (calendar roadmap PR 3 — `NewsDerivedEvent`). Defaults to the `PROPOSED`
 * inbox; pass `?status=APPROVED|REJECTED` to inspect history.
 *
 * See the sibling `../agri-events/route.ts` for why curation of a GLOBAL
 * table (no tenantId) lives OUTSIDE `/api/t/[tenantSlug]/**`.
 *
 * Permission: platform-admin-key-gated — does not use requirePermission;
 * excluded from api-permission-coverage.test.ts guardrail with a reason
 * (mirrors the agri-events entries — the scanner doesn't walk `api/admin`
 * at all, but the exclusion is recorded for the same documentation reason).
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    try {
        verifyPlatformApiKey(req);
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }

    // Rate-limited HERE, not by the wrapper — #3260, following #3155.
    // `resolveRateLimitScope` returns null for any non-mutation method, and
    // `/api/admin/*` is excluded from the Edge read tier, so without this call
    // a key-holder meets no throttle at any layer. A catalogue read has no
    // incident-time role, which is what separates it from the six operator
    // surfaces listed as deliberately unthrottled in
    // `declared-rate-limits-can-execute`.
    const limited = await enforceRateLimit(req, {
        scope: 'platform-news-derived-events',
        config: LOGIN_LIMIT,
    });
    if (limited.response) return limited.response;

    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = ListNewsDerivedEventsQuerySchema.parse(sp);
    const events = await listNewsDerivedEvents(query);

    return jsonResponse({ events });
});
