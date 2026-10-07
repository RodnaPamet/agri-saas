/**
 * `POST /api/admin/farm-claims/:claimId/dispute` — refuse a claim (P3.9).
 *
 * The reviewer's "this is not your farm" verdict, as distinct from the
 * automatic collision that `verify` records when the partial unique index
 * fires.
 *
 * Deliberately does NOT require the ЕИК. A reviewer who has established that a
 * claim is wrong may have no correct number to supply, and demanding one would
 * make refusing harder than approving — which is the wrong way round for a
 * queue whose job is to catch bad claims.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { disputeFarmClaim } from '@/app-layer/usecases/farm-identity-review';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

const Body = z.object({
    reason: z.string().trim().min(1).max(500),
    reviewedBy: z.string().trim().min(1).max(200),
});

const STATUS_FOR: Record<string, number> = {
    DISPUTED: 200,
    // A VERIFIED claim is not disputable here: unwinding one must also unwind
    // `FarmProfile.eik` and whatever has been filed from it. That is a
    // deliberate operator action, not a queue button.
    ALREADY_VERIFIED: 409,
    NOT_FOUND: 404,
};

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

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ claimId: string }> }) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const { claimId } = await params;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        const outcome = await disputeFarmClaim({
            claimId,
            reason: parsed.data.reason,
            reviewedBy: parsed.data.reviewedBy,
        });

        const status = STATUS_FOR[outcome.result];
        if (status === undefined) {
            return jsonResponse({ error: 'unclassified_outcome', result: outcome.result }, { status: 500 });
        }
        return jsonResponse(outcome, { status });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-farm-claim-dispute' } },
);
