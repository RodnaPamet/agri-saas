/**
 * `POST /api/admin/farm-claims/:claimId/verify` — promote a claim (P3.9).
 *
 * The body carries the ЕИК the REVIEWER found in the Търговски регистър. It is
 * an input, never an echo of the row: `FarmIdentityClaim` holds only a blind
 * index, and this endpoint confirms the reviewer's independently-obtained
 * number matches it. A console that showed the claimed number would let a
 * reviewer approve without opening the register at all.
 *
 * It is also the ONLY write path to `FarmProfile.eik` — see #1352, and the
 * removal of `eik` from the free-edit profile list in this same PR. The
 * plaintext therefore enters the system exactly once, at the moment a human
 * has confirmed it, and lands encrypted under the tenant DEK.
 *
 * Every outcome is a distinct, machine-readable code. This is a staff tool,
 * not a public surface, so there is no enumeration argument for collapsing
 * them — and an operator who cannot tell "that is not the number this farm
 * claimed" from "another farm already holds it" cannot do the job.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { verifyFarmClaim } from '@/app-layer/usecases/farm-identity-review';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

const Body = z.object({
    /**
     * The ЕИК, as a STRING. Never a number: an ЕИК may be 9 or 13 digits and
     * a 13-digit value exceeds the safe integer range for exact arithmetic,
     * while a leading zero would be eaten by a numeric round-trip.
     */
    eik: z.string().trim().min(1).max(32),
    /** Who reviewed it, for the audit trail. */
    reviewedBy: z.string().trim().min(1).max(200),
});

/**
 * Which outcomes are refusals.
 *
 * A map rather than a `switch` in the handler, so adding an outcome to the
 * usecase forces a decision here instead of silently defaulting to 200 — the
 * failure mode of a `switch` with a permissive fallthrough.
 */
const STATUS_FOR: Record<string, number> = {
    VERIFIED: 200,
    ALREADY_VERIFIED: 200,
    DISPUTED_COLLISION: 409,
    EIK_MISMATCH: 422,
    EIK_INVALID: 400,
    ALREADY_DISPUTED: 409,
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

        const outcome = await verifyFarmClaim({
            claimId,
            eik: parsed.data.eik,
            reviewedBy: parsed.data.reviewedBy,
        });

        const status = STATUS_FOR[outcome.result];
        if (status === undefined) {
            // An outcome the usecase gained and this route has not classified.
            // A 500 is the honest answer: the transition may well have
            // happened, and answering 200 would tell an operator it definitely
            // did.
            return jsonResponse({ error: 'unclassified_outcome', result: outcome.result }, { status: 500 });
        }
        return jsonResponse(outcome, { status });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-farm-claim-verify' } },
);
