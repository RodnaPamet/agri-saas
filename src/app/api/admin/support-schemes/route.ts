import { NextRequest, NextResponse } from 'next/server';
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
    return jsonResponse({ schemes: await listPendingSupportSchemes() });
});
