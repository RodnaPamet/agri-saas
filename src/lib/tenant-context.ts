/**
 * Tenant context resolvers.
 *
 * These functions resolve the current tenant context for a request,
 * using TenantMembership as the authoritative source of truth.
 *
 * Design decisions:
 *   - Permissions are computed from the tenant membership role
 */
import prisma from './prisma';
import { notFound, forbidden, codedNotFound } from '@/lib/errors/types';
import type { Role, Tenant, TenantMembership, TenantCustomRole } from '@prisma/client';
import { getPermissionsForRole, parsePermissionsJson, type PermissionSet } from '@/lib/permissions';

// ─── Permission shape ───

export interface Permissions {
    canRead: boolean;
    canWrite: boolean;
    canAdmin: boolean;
    canAudit: boolean;
    canExport: boolean;
}

export interface TenantContext {
    tenant: Tenant;
    membership: TenantMembership & { customRole: TenantCustomRole | null };
    role: Role;
    customRole: TenantCustomRole | null;
    permissions: Permissions;
    appPermissions: PermissionSet;
}

// ─── Permission calculator ───

const ROLE_ORDER: Record<Role, number> = {
    OWNER: 5,
    ADMIN: 4,
    EDITOR: 3,
    AUDITOR: 2,
    READER: 1,
    // Read-only coarse tier (like READER) so the operator's own task
    // data loads. Write is NOT granted here — task completion rides the
    // assignee self-serve path; the route lockdown does the restricting.
    MECHANISATOR: 1,
};

export function computePermissions(role: Role): Permissions {
    const level = ROLE_ORDER[role] ?? 0;
    return {
        canRead: level >= 1,
        canWrite: level >= 3,
        canAdmin: level >= 4,
        canAudit: role === 'AUDITOR' || level >= 4,
        canExport: level >= 2,
    };
}

// ─── Tenant context resolver ───

/**
 * The fine-grained `PermissionSet` for one membership — custom role when it
 * has one, the enum default otherwise.
 *
 * EXTRACTED rather than copied (#1587). This derivation is what every
 * `requirePermission(...)` gate ultimately reads, and a second copy of it is
 * how a client-facing flag comes to disagree with the server that enforces
 * it — a button that 404s, or worse, one a user believes is a capability.
 * `/api/auth/me` needs the same answer for a tenant that is NOT the caller's
 * current one, which is why it cannot simply read the resolved context.
 *
 * Deliberately takes the two fields it uses rather than a full membership, so
 * a caller may select only those.
 */
export function appPermissionsFor(membership: {
    role: Role;
    customRole?: { baseRole: Role; permissionsJson: unknown } | null;
}): PermissionSet {
    return membership.customRole
        ? parsePermissionsJson(membership.customRole.permissionsJson, membership.customRole.baseRole)
        : getPermissionsForRole(membership.role);
}

export async function resolveTenantContext(
    params: { tenantSlug?: string; tenantId?: string },
    userId: string
): Promise<TenantContext> {
    let tenant: Tenant | null = null;

    if (params.tenantSlug) {
        tenant = await prisma.tenant.findUnique({
            where: { slug: params.tenantSlug },
        });
    } else if (params.tenantId) {
        tenant = await prisma.tenant.findUnique({
            where: { id: params.tenantId },
        });
    } else {
        // Reachable, measured: `getUserCtx`-style callers pass
        // `{ tenantId: session.tenantId }`, and a session with no tenant makes
        // both branches above falsy. A 404 is an odd shape for it and the
        // status is deliberately NOT changed here — the #1712 migration is
        // about the LANGUAGE a farmer reads, and smuggling a status change
        // into it would break a client that already handles 404.
        throw codedNotFound('TENANT_IDENTIFIER_REQUIRED', 'Tenant identifier required');
    }

    if (!tenant) {
        // ONE code shared with the soft-deleted branch below, deliberately.
        // That branch's own comment calls the sameness "the same
        // anti-enumeration shape as not found" — so distinct codes would undo
        // the property the identical message exists to provide, letting a
        // caller tell "no such farm" from "a farm you may not see".
        throw codedNotFound('TENANT_NOT_FOUND', 'Tenant not found');
    }

    // Soft-deleted (removed from the org admin panel) tenants are
    // inaccessible. This is the single authoritative gate — every /t and
    // /api/t request resolves through here — so denying it once makes a
    // removed tenant unreachable everywhere, regardless of stale JWT
    // claims or cached listings. Same anti-enumeration shape as
    // "not found".
    if (tenant.deletedAt) {
        throw codedNotFound('TENANT_NOT_FOUND', 'Tenant not found');
    }

    const membership = await prisma.tenantMembership.findUnique({
        where: {
            tenantId_userId: {
                tenantId: tenant.id,
                userId,
            },
        },
        include: {
            customRole: true,
        },
    });

    if (!membership) {
        throw forbidden('Not a member of this tenant');
    }

    // Block deactivated or removed members from accessing tenant resources
    const memberStatus = membership.status;
    if (memberStatus === 'DEACTIVATED') {
        throw forbidden('Your account has been deactivated by a tenant administrator. Contact your admin for access.');
    }
    if (memberStatus === 'REMOVED') {
        throw forbidden('You are no longer a member of this tenant.');
    }

    // Resolve permissions: custom role overrides enum-based defaults when present
    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    const appPermissions = appPermissionsFor(membership);

    return {
        tenant,
        membership,
        role: effectiveRole,
        customRole: membership.customRole,
        permissions: computePermissions(effectiveRole),
        appPermissions,
    };
}

// ─── Default tenant helper ───

/**
 * Get the default tenant for a user (first membership by creation date).
 *
 * @param userId - The user's ID
 * @returns TenantMembership with tenant, or null if user has no memberships
 */
export async function getDefaultTenantForUser(
    userId: string
): Promise<(TenantMembership & { tenant: Tenant }) | null> {
    return prisma.tenantMembership.findFirst({
        // Skip memberships whose tenant was soft-deleted — never default
        // a user into a removed tenant.
        where: { userId, tenant: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        include: { tenant: true },
    });
}
