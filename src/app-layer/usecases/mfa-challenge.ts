/**
 * MFA Challenge Usecase
 *
 * Handles TOTP challenge verification during the login flow.
 * This is separate from enrollment verification — challenge is for
 * enrolled users at login time.
 *
 * Audit events: MFA_CHALLENGE_PASSED, MFA_CHALLENGE_FAILED
 */
import { prisma } from '@/lib/prisma';
import { decryptTotpSecret, verifyTotpCode } from '@/lib/security/totp-crypto';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';
import { badRequest, internal } from '@/lib/errors/types';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';

export interface MfaChallengeResult {
    success: boolean;
    message: string;
    remaining?: number;
}

/**
 * Verifies a TOTP code during the MFA login challenge.
 * On success, updates lastChallengeAt so JWT callback can clear mfaPending.
 */
export async function verifyMfaChallenge(
    userId: string,
    tenantId: string,
    code: string,
    remaining: number,
): Promise<MfaChallengeResult> {
    logger.info('mfa challenge started', { component: 'mfa', userId });

    // Look up enrollment
    const enrollment = await prisma.userMfaEnrollment.findUnique({
        where: {
            userId_tenantId_type: {
                userId,
                tenantId,
                type: 'TOTP',
            },
        },
    });

    if (!enrollment || !enrollment.isVerified) {
        throw badRequest('MFA not configured. Please set up MFA first.');
    }

    // Decrypt and verify
    const authSecret = env.AUTH_SECRET;
    if (!authSecret) {
        throw internal('Server configuration error');
    }

    const secret = decryptTotpSecret(enrollment.secretEncrypted, authSecret);
    const isValid = verifyTotpCode(secret, code);

    // Build a minimal audit context (challenge route doesn't have full RequestContext)
    const auditCtx: RequestContext = {
        tenantId,
        userId,
        role: 'READER' as const,
        permissions: { canAdmin: false, canWrite: false, canRead: true, canAudit: false, canExport: false },
        appPermissions: getPermissionsForRole('READER'),
        requestId: crypto.randomUUID(),
    };

    if (!isValid) {
        // Audit: failed challenge
        try {
            await logEvent(prisma, auditCtx, {
                action: 'MFA_CHALLENGE_FAILED',
                entityType: 'User',
                entityId: userId,
                details: `MFA challenge failed. ${remaining} attempts remaining.`,
                detailsJson: {
                    category: 'access',
                    operation: 'login',
                    detail: `MFA challenge failed. ${remaining} attempts remaining.`,
                },
            });
        } catch { /* audit is best-effort */ }

        logger.warn('mfa challenge failed', { component: 'mfa', userId, remaining });
        return {
            success: false,
            message: 'Invalid code. Please check your authenticator app and try again.',
            remaining,
        };
    }

    // Success — update lastChallengeAt
    await prisma.userMfaEnrollment.update({
        where: { id: enrollment.id },
        data: { lastChallengeAt: new Date() },
    });

    // Audit: passed challenge
    try {
        await logEvent(prisma, auditCtx, {
            action: 'MFA_CHALLENGE_PASSED',
            entityType: 'User',
            entityId: userId,
            details: 'MFA challenge passed successfully.',
            detailsJson: {
                category: 'access',
                operation: 'login',
                detail: 'MFA challenge passed successfully.',
            },
        });
    } catch { /* audit is best-effort */ }

    logger.info('mfa challenge passed', { component: 'mfa', userId });
    return {
        success: true,
        message: 'MFA verification successful',
    };
}

/**
 * The farm a challenge is for: the one named in the URL, if the caller is an
 * ACTIVE member of it (#3186), else null.
 *
 * The verify route read the session's PRIMARY farm, while enrolments and the
 * pending list are per (user, farm) — so a non-primary farm that requires a
 * factor could never be cleared.
 */
export async function resolveChallengeTenantId(userId: string, tenantSlug: string): Promise<string | null> {
    const membership = await prisma.tenantMembership.findFirst({
        where: { userId, status: 'ACTIVE', tenant: { slug: tenantSlug, deletedAt: null } },
        select: { tenantId: true },
    });
    return membership?.tenantId ?? null;
}
