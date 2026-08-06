import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { reviewSupportScheme } from '@/app-layer/usecases/support-schemes';

const ReviewSchema = z.object({ decision: z.enum(['APPROVED', 'REJECTED']) }).strip();

/**
 * Approve or reject a PROPOSED support scheme — the ONLY path that makes one
 * visible to a tenant. There is deliberately no auto-promotion anywhere.
 *
 * This is the backstop the whole feature rests on. A farmer who misses a real
 * ДФЗ application window because an AI-extracted date was three days off
 * suffers direct financial harm; the Zod bounds, the verbatim-excerpt check
 * and the confidence threshold only reduce how much a reviewer has to reject.
 *
 * Platform-admin-key-gated; `reviewedBy` records the request id rather than a
 * user, because these routes have no session.
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
        const body = ReviewSchema.parse(await req.json());
        const reviewedBy = req.headers.get('x-request-id') ?? 'platform-admin';

        return jsonResponse({ scheme: await reviewSupportScheme(id, body.decision, reviewedBy) });
    },
);
