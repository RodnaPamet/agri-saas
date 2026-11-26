import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/security/rate-limit-middleware';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { listPendingSupportSchemes } from '@/app-layer/usecases/support-schemes';

/**
 * The platform review queue for AI-extracted support schemes.
 *
 * Platform-admin-key-gated, not `requirePermission` — there is no user session
 * on these routes. Excluded from the api-permission-coverage guardrail with a
 * reason, mirroring the agri-events and news-derived-events entries.
 *
 * Nothing a farmer sees comes from here: `listSupportSchemes` (the
 * tenant-facing read) returns APPROVED rows only, so an unreviewed extraction
 * is unreachable by construction rather than by convention.
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
        scope: 'platform-support-schemes',
        config: LOGIN_LIMIT,
    });
    if (limited.response) return limited.response;
    return jsonResponse({ schemes: await listPendingSupportSchemes() });
});
