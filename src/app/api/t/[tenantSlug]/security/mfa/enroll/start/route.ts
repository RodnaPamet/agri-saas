import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { startMfaEnrollment } from '@/app-layer/usecases/mfa-enrollment';
import { getUserMfaStatus } from '@/app-layer/usecases/mfa';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/security/mfa/enroll/start
 *
 * Starts TOTP MFA enrollment for the authenticated user.
 * Returns the otpauth URI (for QR code rendering) and the base32 secret.
 *
 * The plaintext secret is returned ONCE — it cannot be retrieved after.
 *
 * SECURITY: only the authenticated user can enroll themselves.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    // The enrolment a REQUIRED policy demands (#3185).
    const ctx = await getTenantCtx(params, req, { allowOwedSecondFactor: true });

    // Check if user already has verified MFA — prevent re-enrollment without explicit removal
    const status = await getUserMfaStatus(ctx);
    if (status.isVerified) {
        return jsonResponse(
            { error: 'MFA is already enrolled and verified. Remove existing enrollment first.' },
            { status: 409 },
        );
    }

    const result = await startMfaEnrollment(ctx);

    return jsonResponse({
        otpauthUrl: result.uri,
        secret: result.secret,
        enrollmentId: result.enrollmentId,
    }, { status: 201 });
});
