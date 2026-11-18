import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { verifyMfaEnrollment } from '@/app-layer/usecases/mfa-enrollment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { VerifyMfaInput } from '@/app-layer/schemas/mfa.schemas';
import { MFA_ENROLL_VERIFY_LIMIT } from '@/lib/security/rate-limit';
import {
    checkRateLimitDistributed,
    resetRateLimitDistributed,
} from '@/lib/security/rate-limit-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/security/mfa/enroll/verify
 *
 * Verifies a TOTP code against the user's pending enrollment.
 * If valid, marks the enrollment as verified.
 *
 * Rate limited: 10 attempts per 15 min.
 *
 * Body: { code: "123456" }
 */
export const POST = withApiErrorHandling(withValidatedBody(
    VerifyMfaInput,
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
        const params = await paramsPromise;
        // The enrolment a REQUIRED policy demands (#3185).
        const ctx = await getTenantCtx(params, req, { allowOwedSecondFactor: true });

        // Rate limit check
        const rateLimitKey = `mfa-enroll:${ctx.userId}`;
        const rateCheck = await checkRateLimitDistributed(rateLimitKey, MFA_ENROLL_VERIFY_LIMIT);

        if (!rateCheck.allowed) {
            const retrySeconds = Math.ceil(rateCheck.retryAfterMs / 1000);
            return jsonResponse(
                {
                    success: false,
                    error: `Too many attempts. Please try again in ${retrySeconds} seconds.`,
                },
                { status: 429 },
            );
        }

        const result = await verifyMfaEnrollment(ctx, body);

        if (!result.success) {
            return jsonResponse({
                success: false,
                error: 'Invalid TOTP code. Please try again.',
                enrollmentId: result.enrollmentId,
            });
        }

        // Success — reset rate limit
        await resetRateLimitDistributed(rateLimitKey);

        return jsonResponse({
            success: true,
            enrollmentId: result.enrollmentId,
            message: 'MFA enrollment verified successfully.',
        });
    },
));
