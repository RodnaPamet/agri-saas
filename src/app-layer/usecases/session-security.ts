/**
 * Session Security Usecases
 *
 * Session revocation for JWT-based sessions:
 * - revokeUserSessions: increment sessionVersion for a target user (ADMIN or self)
 * - revokeCurrentSession: increment own sessionVersion
 * - revokeAllTenantSessions: bulk increment for all tenant members (ADMIN-only)
 * - getUserSessionVersion: read current sessionVersion (for JWT callback)
 *
 * DESIGN: Since sessions are JWT (stateless), revocation works by incrementing
 * a `sessionVersion` counter on the User model. The auth.ts JWT callback checks
 * this on every request and forces reauth if the token's version is stale.
 */
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '../types';
import { codedNotFound, forbidden } from '@/lib/errors/types';
import { logEvent } from '../events/audit';

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionRevocationResult {
    userId: string;
    newSessionVersion: number;
}

export interface BulkRevocationResult {
    usersAffected: number;
}

// ─── Revoke User Sessions ───────────────────────────────────────────

/**
 * Revokes all sessions for a target user by incrementing their sessionVersion.
 * - Self: always allowed
 * - Other user: ADMIN-only, and target must be in the same tenant
 */
export async function revokeUserSessions(
    ctx: RequestContext,
    targetUserId?: string,
): Promise<SessionRevocationResult> {
    const effectiveUserId = targetUserId || ctx.userId;

    // Non-admins can only revoke their own sessions
    if (effectiveUserId !== ctx.userId) {
        if (!ctx.permissions.canAdmin) {
            throw forbidden('Only admins can revoke other users\' sessions');
        }

        // Verify target user is in the same tenant
        const membership = await prisma.tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId: ctx.tenantId,
                    userId: effectiveUserId,
                },
            },
        });

        if (!membership) {
            throw codedNotFound('TARGET_USER_NOT_IN_TENANT', 'That person is not a member of this farm.');
        }
    }

    const updated = await prisma.user.update({
        where: { id: effectiveUserId },
        data: { sessionVersion: { increment: 1 } },
        select: { id: true, sessionVersion: true },
    });

    // Audit
    const action = effectiveUserId === ctx.userId ? 'CURRENT_SESSION_REVOKED' : 'SESSIONS_REVOKED_FOR_USER';
    try {
        await logEvent(prisma, ctx, {
            action,
            entityType: 'User',
            entityId: effectiveUserId,
            details: `Sessions revoked. New sessionVersion: ${updated.sessionVersion}`,
            detailsJson: { category: 'custom', event: 'unknown' },
        });
    } catch { /* audit is best-effort */ }

    return {
        userId: updated.id,
        newSessionVersion: updated.sessionVersion,
    };
}

// ─── Revoke Current Session ─────────────────────────────────────────

/**
 * Convenience: revokes the current user's own sessions.
 */
export async function revokeCurrentSession(
    ctx: RequestContext,
): Promise<SessionRevocationResult> {
    return revokeUserSessions(ctx, ctx.userId);
}

// ─── Revoke All Tenant Sessions ─────────────────────────────────────

/**
 * Revokes sessions for ALL members of the current tenant.
 * ADMIN-only. Useful after a security incident.
 */
export async function revokeAllTenantSessions(
    ctx: RequestContext,
): Promise<BulkRevocationResult> {
    if (!ctx.permissions.canAdmin) {
        throw forbidden('Only admins can revoke all tenant sessions');
    }

    // Get all user IDs in this tenant
    const memberships = await prisma.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId },
        select: { userId: true },
    });

    const userIds = memberships.map((m) => m.userId);

    if (userIds.length === 0) {
        return { usersAffected: 0 };
    }

    // Bulk increment sessionVersion for all tenant members
    const result = await prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { sessionVersion: { increment: 1 } },
    });

    // Audit
    try {
        await logEvent(prisma, ctx, {
            action: 'ALL_TENANT_SESSIONS_REVOKED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Revoked sessions for ${result.count} users.`,
            detailsJson: { category: 'access', operation: 'all_tenant_sessions_revoked', detail: 'ALL_TENANT_SESSIONS_REVOKED' },
        });
    } catch { /* audit is best-effort */ }

    return { usersAffected: result.count };
}

// ─── Get Session Version ────────────────────────────────────────────

/**
 * Returns the current sessionVersion for a user.
 * Used by the auth.ts JWT callback to check for forced reauth.
 */
export async function getUserSessionVersion(
    userId: string,
): Promise<number> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { sessionVersion: true },
    });

    return user?.sessionVersion ?? 0;
}
