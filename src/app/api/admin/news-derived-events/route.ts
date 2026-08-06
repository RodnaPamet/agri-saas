import { NextRequest, NextResponse } from 'next/server';
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

    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = ListNewsDerivedEventsQuerySchema.parse(sp);
    const events = await listNewsDerivedEvents(query);

    return jsonResponse({ events });
});
