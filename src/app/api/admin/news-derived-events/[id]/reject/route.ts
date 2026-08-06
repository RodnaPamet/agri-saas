import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { rejectNewsDerivedEvent } from '@/app-layer/usecases/news-derived-events';

/**
 * Reject a PROPOSED news-derived calendar event — it never surfaces on any
 * tenant's calendar. See the sibling `../approve/route.ts` for the approval
 * path and why promotion is exclusively a human decision.
 *
 * Permission: platform-admin-key-gated — does not use requirePermission;
 * excluded from api-permission-coverage.test.ts guardrail with a reason
 * (mirrors the agri-events entries).
 */
export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        try {
            verifyPlatformApiKey(req);
        } catch (err) {
            if (err instanceof PlatformAdminError) {
                return NextResponse.json({ error: err.message }, { status: err.status });
            }
            throw err;
        }

        const { id } = await params;
        const event = await rejectNewsDerivedEvent(id, {
            requestId: req.headers.get('x-request-id') ?? 'platform-admin',
        });

        return jsonResponse(event);
    },
);
