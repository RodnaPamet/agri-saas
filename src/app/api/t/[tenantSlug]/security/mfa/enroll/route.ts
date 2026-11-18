import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getUserMfaStatus } from '@/app-layer/usecases/mfa';
import { removeMfaEnrollment } from '@/app-layer/usecases/mfa-enrollment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/[tenantSlug]/security/mfa/enroll
 *
 * Returns the current user's MFA enrollment status for this tenant.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    // Reading one's own status is part of enrolling (#3185). DELETE keeps the
    // requirement: removing a factor needs the factor.
    const ctx = await getTenantCtx(params, req, { allowOwedSecondFactor: true });
    const status = await getUserMfaStatus(ctx);

    return jsonResponse(status);
});

/**
 * DELETE /api/t/[tenantSlug]/security/mfa/enroll
 *
 * Removes MFA enrollment for the authenticated user (or a target user if admin).
 * Body (optional): { targetUserId: "..." }
 */
export const DELETE = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    let targetUserId: string | undefined;
    try {
        const body = await req.json();
        targetUserId = body?.targetUserId;
    } catch {
        // No body — remove own enrollment
    }

    const result = await removeMfaEnrollment(ctx, targetUserId);

    if (!result.removed) {
        return jsonResponse(
            { error: 'No MFA enrollment found to remove.' },
            { status: 404 },
        );
    }

    return jsonResponse({ success: true, message: 'MFA enrollment removed.' });
});
