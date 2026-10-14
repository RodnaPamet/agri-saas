/**
 * Tenant Admin Usecases — Member Management & Settings
 *
 * Core admin functions for Epic 12: Admin UI & RBAC Management.
 * All mutations require ADMIN role, enforced server-side via policies.
 *
 * Safety invariants:
 *   - Cannot demote yourself (last-admin protection)
 *   - Cannot deactivate yourself
 *   - Cannot assign a role higher than ADMIN (only ADMIN exists above EDITOR)
 *
 * @module usecases/tenant-admin
 */
import { RequestContext } from '../types';
import {
    assertCanManageMembers,
    assertCanChangeRoles,
    assertCanViewAdminSettings,
    assertNotSelfDemotion,
    assertNotSelfDeactivation,
} from '../policies/admin.policies';
import { assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden, codedNotFound } from '@/lib/errors/types';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { Prisma, type Role } from '@prisma/client';

// ─── Valid roles for assignment ───
const VALID_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'];

// ─── List Members ───

export async function listTenantMembers(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);
    const memberships = await runInTenantContext(ctx, (db) =>
        db.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { in: ['ACTIVE', 'INVITED', 'DEACTIVATED'] },
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                        createdAt: true,
                    },
                },
                invitedBy: {
                    select: { id: true, name: true },
                },
                customRole: {
                    select: { id: true, name: true },
                },
            },
            orderBy: { createdAt: 'asc' },
        })
    );

    // Epic C.3 — attach live-session counts so the admin members UI
    // can surface "3 active sessions" without an N+1 cascade of
    // requests. Best-effort: a DB failure falls back to 0 counts and
    // the UI degrades gracefully rather than failing the whole page.
    let counts: Record<string, number> = {};
    try {
        const { countActiveSessionsForTenantUsers } = await import(
            '@/lib/security/session-tracker'
        );
        counts = await countActiveSessionsForTenantUsers(ctx.tenantId);
    } catch {
        counts = {};
    }
    return memberships.map((m) => ({
        ...m,
        activeSessionCount: counts[m.userId] ?? 0,
    }));
}

// ─── List Assignable Users (B1 — task-assignee population fix) ───
//
// `listTenantMembers` above is admin-gated — that's correct because
// the admin view exposes session counts, invite state, deactivated
// rows, and custom-role linkage. But the in-product
// "assign this task / risk / evidence to a teammate" pickers need a
// roster too, and non-admin users (EDITOR / READER) have a real
// reason to read it. Pre-B1 the only roster endpoint was the
// admin one, so the `<UserCombobox>` silently rendered an empty
// dropdown for everyone below ADMIN.
//
// This usecase returns the MINIMAL safe shape — id + name + email +
// image, ACTIVE rows only, no session counts, no role badges, no
// invite/deactivated rows. Read access via `assertCanRead`, which
// every signed-in tenant member has.

export interface AssignableUser {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
}

export async function listAssignableUsers(
    ctx: RequestContext,
): Promise<AssignableUser[]> {
    assertCanRead(ctx);
    const memberships = await runInTenantContext(ctx, (db) =>
        db.tenantMembership.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            select: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                    },
                },
            },
            orderBy: { createdAt: 'asc' },
        }),
    );
    return memberships.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
    }));
}

// ─── Invite Member (DEPRECATED — use createInviteToken from tenant-invites.ts) ───
//
// This thin wrapper exists purely for backward-compatibility while callers
// are updated. The old "existing user → direct ACTIVE membership" path has
// been REMOVED — every membership must now go through redeemInvite.

export async function inviteTenantMember(
    ctx: RequestContext,
    input: { email: string; role: Role }
) {
    const { createInviteToken } = await import('./tenant-invites');
    const result = await createInviteToken(ctx, input);
    return { type: 'invited' as const, invite: result.invite, url: result.url };
}

// ─── Update Member Role ───

export async function updateTenantMemberRole(
    ctx: RequestContext,
    input: { membershipId: string; role: Role }
) {
    assertCanChangeRoles(ctx);

    if (!VALID_ROLES.includes(input.role)) {
        throw badRequest(`Invalid role: ${input.role}`);
    }

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            // ONE code for all five membership lookups in this file, with the
            // required state in `params` (#1712).
            //
            // Four codes would advertise a distinction the SERVER CANNOT MAKE:
            // each of these is a single query with a status predicate, so an
            // absent membership and one in the wrong state both come back
            // null. "Not found or not active" is honest about that, and a code
            // per message would imply the server knew which — the shape that
            // makes a client's error handling confidently wrong.
            //
            // `requiredStatus` carries what the operation needed, so a client
            // can say "that member is no longer active" rather than a
            // category. Same pattern as WRITE_FORBIDDEN_FOR_ROLE's
            // `params.role`.
            throw codedNotFound(
                'MEMBERSHIP_NOT_FOUND',
                'Membership not found or not active.',
                { requiredStatus: 'ACTIVE' },
            );
        }

        // Safety: prevent self-demotion
        assertNotSelfDemotion(ctx, membership.userId, input.role);

        // Safety: OWNER-boundary checks — only OWNERs can touch OWNER memberships
        // or promote to OWNER. The DB trigger is the backstop; these checks are
        // the user-friendly front door with clearer error messages.
        if (input.role === 'OWNER' && !ctx.appPermissions.admin.owner_management) {
            throw forbidden('Only OWNERs can promote to OWNER.');
        }
        if (membership.role === 'OWNER' && !ctx.appPermissions.admin.owner_management) {
            throw forbidden('Only OWNERs can modify an OWNER membership.');
        }

        // Safety: last-OWNER protection — do not demote the only OWNER.
        if (membership.role === 'OWNER' && input.role !== 'OWNER') {
            const ownerCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });
            if (ownerCount <= 1) {
                throw forbidden('Cannot demote the last OWNER. Promote another OWNER first.');
            }
        }

        // Safety: last-admin protection (legacy — keep for non-OWNER admins)
        if (membership.role === 'ADMIN' && input.role !== 'ADMIN' && input.role !== 'OWNER') {
            const adminCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'ADMIN',
                    status: 'ACTIVE',
                },
            });
            if (adminCount <= 1) {
                throw forbidden('Cannot remove the last admin. Promote another member first.');
            }
        }

        const oldRole = membership.role;

        const updated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: { role: input.role },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_ROLE_CHANGED',
            entityType: 'TenantMembership',
            entityId: updated.id,
            details: `Role changed: ${oldRole} → ${input.role} for ${membership.user.email}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: oldRole,
                toStatus: input.role,
            },
        });

        return updated;
    });
}

/**
 * БАБХ farm-record — set the plant-protection certificates carried by a
 * membership: applicatorCertNo (the person applying, чл. 83 ЗЗР via
 * чл. 84 ал. 2), agronomistCertNo + agronomistName (the supervising
 * specialist, чл. 84 ал. 1, may name a non-user). Edited from the
 * Members & Roles admin "Certificates" modal. Three-state per field:
 * omitted = leave unchanged, null/empty = clear, string = set.
 */
export async function updateMemberCertificates(
    ctx: RequestContext,
    input: {
        membershipId: string;
        applicatorCertNo?: string | null;
        agronomistCertNo?: string | null;
        agronomistName?: string | null;
    },
) {
    assertCanManageMembers(ctx);

    // Three-state normalizer: undefined → leave, null/blank → clear, else set.
    const clean = (v: string | null | undefined): string | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        return sanitizePlainText(v.trim()) || null;
    };

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: { id: input.membershipId, tenantId: ctx.tenantId },
            include: { user: { select: { id: true, email: true } } },
        });
        // No status predicate on this query, so this one really is "absent"
        // and carries no `requiredStatus`. The absence of the param is itself
        // information: any state would have been accepted.
        if (!membership) throw codedNotFound('MEMBERSHIP_NOT_FOUND', 'Membership not found.');

        const data: Prisma.TenantMembershipUpdateInput = {};
        const applicator = clean(input.applicatorCertNo);
        const agronomistCert = clean(input.agronomistCertNo);
        const agronomistName = clean(input.agronomistName);
        if (applicator !== undefined) data.applicatorCertNo = applicator;
        if (agronomistCert !== undefined) data.agronomistCertNo = agronomistCert;
        if (agronomistName !== undefined) data.agronomistName = agronomistName;

        const updated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data,
            select: {
                id: true,
                applicatorCertNo: true,
                agronomistCertNo: true,
                agronomistName: true,
            },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_CERTIFICATES_UPDATED',
            entityType: 'TenantMembership',
            entityId: updated.id,
            details: `Updated plant-protection certificates for ${membership.user.email}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantMembership',
                operation: 'updated',
                summary: 'Member certificates updated',
            },
        });

        return updated;
    });
}

// ─── Deactivate Member ───

export async function deactivateTenantMember(
    ctx: RequestContext,
    input: { membershipId: string }
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
                status: 'ACTIVE',
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            // Same one code and the same reasoning as `updateTenantMemberRole`
            // above — identical query predicate, identical message (#1712).
            throw codedNotFound(
                'MEMBERSHIP_NOT_FOUND',
                'Membership not found or not active.',
                { requiredStatus: 'ACTIVE' },
            );
        }

        // Safety: prevent self-deactivation
        assertNotSelfDeactivation(ctx, membership.userId);

        // Safety: last-OWNER protection — cannot deactivate the only OWNER.
        if (membership.role === 'OWNER') {
            const ownerCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            });
            if (ownerCount <= 1) {
                throw forbidden('Cannot deactivate the last OWNER.');
            }
        }

        // Safety: last-admin protection (legacy — keep for non-OWNER admins)
        if (membership.role === 'ADMIN') {
            const adminCount = await db.tenantMembership.count({
                where: {
                    tenantId: ctx.tenantId,
                    role: 'ADMIN',
                    status: 'ACTIVE',
                },
            });
            if (adminCount <= 1) {
                throw forbidden('Cannot deactivate the last admin.');
            }
        }

        const deactivated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: {
                status: 'DEACTIVATED',
                deactivatedAt: new Date(),
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_DEACTIVATED',
            entityType: 'TenantMembership',
            entityId: deactivated.id,
            details: `Deactivated member: ${membership.user.email}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: 'ACTIVE',
                toStatus: 'DEACTIVATED',
            },
        });

        return deactivated;
    });
}

/**
 * Bulk-deactivate memberships — the members table selection action-row
 * ("Remove selected"). Batch-aware version of {@link deactivateTenantMember}:
 * skips the caller's own membership and protects the LAST active OWNER / ADMIN
 * across the WHOLE selection (you can deactivate owners only while ≥1 active
 * OWNER remains — the same invariant the DB trigger backstops). N+1-safe: one
 * `findMany` + two counts + one `updateMany`, never a read inside the loop.
 * Returns how many were deactivated vs skipped (self / last-owner / not-found).
 */
export async function bulkDeactivateTenantMember(
    ctx: RequestContext,
    input: { membershipIds: string[] },
): Promise<{ deactivated: number; skipped: number }> {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const memberships = await db.tenantMembership.findMany({
            where: { id: { in: input.membershipIds }, tenantId: ctx.tenantId, status: 'ACTIVE' },
            include: { user: { select: { id: true, email: true } } },
        });

        const [ownerTotal, adminTotal] = await Promise.all([
            db.tenantMembership.count({ where: { tenantId: ctx.tenantId, role: 'OWNER', status: 'ACTIVE' } }),
            db.tenantMembership.count({ where: { tenantId: ctx.tenantId, role: 'ADMIN', status: 'ACTIVE' } }),
        ]);

        // Greedily pick deactivations, decrementing the remaining owner/admin
        // headroom so the batch can never orphan the tenant (≥1 of each kept).
        let remainingOwners = ownerTotal;
        let remainingAdmins = adminTotal;
        const toDeactivate = memberships.filter((m) => {
            if (m.userId === ctx.userId) return false; // never self
            if (m.role === 'OWNER') {
                if (remainingOwners <= 1) return false;
                remainingOwners -= 1;
            }
            if (m.role === 'ADMIN') {
                if (remainingAdmins <= 1) return false;
                remainingAdmins -= 1;
            }
            return true;
        });

        const requested = input.membershipIds.length;
        if (toDeactivate.length === 0) return { deactivated: 0, skipped: requested };

        await db.tenantMembership.updateMany({
            where: { id: { in: toDeactivate.map((m) => m.id) }, tenantId: ctx.tenantId, status: 'ACTIVE' },
            data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
        });

        for (const m of toDeactivate) {
            await logEvent(db, ctx, {
                action: 'MEMBER_DEACTIVATED',
                entityType: 'TenantMembership',
                entityId: m.id,
                details: `Deactivated member: ${m.user.email} (bulk)`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'TenantMembership',
                    fromStatus: 'ACTIVE',
                    toStatus: 'DEACTIVATED',
                },
            });
        }

        return { deactivated: toDeactivate.length, skipped: requested - toDeactivate.length };
    });
}

/**
 * Bulk-remove memberships (→ REMOVED) — the members table's "Remove"
 * batch action, the hard counterpart to {@link bulkDeactivateTenantMember}.
 * Operates on ACTIVE / DEACTIVATED / INVITED rows (so removing an
 * already-deactivated member works instead of silently no-op'ing), skips
 * the caller's own membership, and protects the last ACTIVE OWNER / ADMIN
 * across the selection. Rows become REMOVED, leaving the members list.
 * Returns how many were removed vs skipped.
 */
export async function bulkRemoveTenantMember(
    ctx: RequestContext,
    input: { membershipIds: string[] },
): Promise<{ removed: number; skipped: number }> {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const memberships = await db.tenantMembership.findMany({
            where: {
                id: { in: input.membershipIds },
                tenantId: ctx.tenantId,
                status: { in: ['ACTIVE', 'DEACTIVATED', 'INVITED'] },
            },
            include: { user: { select: { id: true, email: true } } },
        });

        const [ownerTotal, adminTotal] = await Promise.all([
            db.tenantMembership.count({ where: { tenantId: ctx.tenantId, role: 'OWNER', status: 'ACTIVE' } }),
            db.tenantMembership.count({ where: { tenantId: ctx.tenantId, role: 'ADMIN', status: 'ACTIVE' } }),
        ]);

        // Only ACTIVE owners/admins count toward the tenant's live headroom;
        // removing an already-inactive member never orphans the tenant.
        let remainingOwners = ownerTotal;
        let remainingAdmins = adminTotal;
        const toRemove: typeof memberships = [];
        let skipped = 0;

        for (const m of memberships) {
            if (m.userId === ctx.userId) { skipped++; continue; } // never self
            if (m.status === 'ACTIVE' && m.role === 'OWNER') {
                if (remainingOwners <= 1) { skipped++; continue; }
                remainingOwners -= 1;
            }
            if (m.status === 'ACTIVE' && m.role === 'ADMIN') {
                if (remainingAdmins <= 1) { skipped++; continue; }
                remainingAdmins -= 1;
            }
            toRemove.push(m);
        }

        // Ids that matched nothing (not found / already REMOVED) → skipped.
        skipped += input.membershipIds.length - memberships.length;

        if (toRemove.length === 0) return { removed: 0, skipped };

        await db.tenantMembership.updateMany({
            where: { id: { in: toRemove.map((m) => m.id) }, tenantId: ctx.tenantId },
            data: { status: 'REMOVED', deactivatedAt: new Date() },
        });

        for (const m of toRemove) {
            await logEvent(db, ctx, {
                action: 'MEMBER_REMOVED',
                entityType: 'TenantMembership',
                entityId: m.id,
                details: `Removed member: ${m.user.email} (bulk)`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'TenantMembership',
                    fromStatus: m.status,
                    toStatus: 'REMOVED',
                },
            });
        }

        return { removed: toRemove.length, skipped };
    });
}

// ─── Reactivate / Remove a single (non-active) member ───

/**
 * Reactivate a DEACTIVATED / REMOVED membership — the inverse of
 * {@link deactivateTenantMember}. Restores ACTIVE status and clears
 * `deactivatedAt`. Seat-gated (`assertWithinLimit(ctx, 'user')`) so a
 * tenant can't exceed its plan by reactivating. Role is preserved.
 *
 * This gives the admin a one-click path to bring back a member who was
 * deactivated — no re-invite / email round-trip required.
 */
export async function reactivateTenantMember(
    ctx: RequestContext,
    input: { membershipId: string },
) {
    assertCanManageMembers(ctx);
    // Reactivating consumes a seat — enforce the plan limit up front.
    await assertWithinLimit(ctx, 'user');

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
                status: { in: ['DEACTIVATED', 'REMOVED'] },
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            throw codedNotFound(
                'MEMBERSHIP_NOT_FOUND',
                'Membership not found or already active.',
                { requiredStatus: 'DEACTIVATED,REMOVED' },
            );
        }

        const reactivated = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: { status: 'ACTIVE', deactivatedAt: null },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_REACTIVATED',
            entityType: 'TenantMembership',
            entityId: reactivated.id,
            details: `Reactivated member: ${membership.user.email}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: membership.status,
                toStatus: 'ACTIVE',
            },
        });

        return reactivated;
    });
}

/**
 * Fully remove a membership (→ REMOVED), so it leaves the members list
 * (which shows ACTIVE / INVITED / DEACTIVATED only). This is the hard
 * counterpart to deactivation, used for a member the admin no longer wants
 * listed. Self-removal is refused; an ACTIVE last OWNER/ADMIN is protected
 * (the same invariant `deactivateTenantMember` enforces). The row is kept
 * as REMOVED (not hard-deleted) so audit history and a future re-invite
 * (`redeemInvite` upserts it back to ACTIVE) both stay intact.
 */
export async function removeTenantMember(
    ctx: RequestContext,
    input: { membershipId: string },
) {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const membership = await db.tenantMembership.findFirst({
            where: {
                id: input.membershipId,
                tenantId: ctx.tenantId,
                status: { in: ['ACTIVE', 'DEACTIVATED', 'INVITED'] },
            },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (!membership) {
            throw codedNotFound(
                'MEMBERSHIP_NOT_FOUND',
                'Membership not found or already removed.',
                { requiredStatus: 'ACTIVE,DEACTIVATED,INVITED' },
            );
        }

        assertNotSelfDeactivation(ctx, membership.userId);

        // Protect the last ACTIVE owner/admin (a non-active member removed
        // here never counts toward the active headcount, so this only bites
        // when removing an ACTIVE last OWNER/ADMIN).
        if (membership.status === 'ACTIVE' && (membership.role === 'OWNER' || membership.role === 'ADMIN')) {
            const sameRoleActive = await db.tenantMembership.count({
                where: { tenantId: ctx.tenantId, role: membership.role, status: 'ACTIVE' },
            });
            if (sameRoleActive <= 1) {
                throw forbidden(`Cannot remove the last ${membership.role}.`);
            }
        }

        const removed = await db.tenantMembership.update({
            where: { id: input.membershipId },
            data: { status: 'REMOVED', deactivatedAt: new Date() },
            include: { user: { select: { id: true, name: true, email: true } } },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_REMOVED',
            entityType: 'TenantMembership',
            entityId: removed.id,
            details: `Removed member: ${membership.user.email}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'TenantMembership',
                fromStatus: membership.status,
                toStatus: 'REMOVED',
            },
        });

        return removed;
    });
}

// ─── Tenant Admin Settings ───

export async function getTenantAdminSettings(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    return runInTenantContext(ctx, async (db) => {
        const [tenant, memberCounts, pendingInvites, identityProviders, securitySettings] =
            await Promise.all([
                db.tenant.findUnique({
                    where: { id: ctx.tenantId },
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                        industry: true,
                        createdAt: true,
                    },
                }),
                db.tenantMembership.groupBy({
                    by: ['status'],
                    where: { tenantId: ctx.tenantId },
                    _count: { id: true },
                }),
                db.tenantInvite.count({
                    where: {
                        tenantId: ctx.tenantId,
                        acceptedAt: null,
                        revokedAt: null,
                        expiresAt: { gt: new Date() },
                    },
                }),
                db.tenantIdentityProvider.findMany({
                    where: { tenantId: ctx.tenantId },
                    select: {
                        id: true,
                        name: true,
                        type: true,
                        isEnabled: true,
                        isEnforced: true,
                    },
                }),
                db.tenantSecuritySettings.findUnique({
                    where: { tenantId: ctx.tenantId },
                    select: {
                        mfaPolicy: true,
                        sessionMaxAgeMinutes: true,
                    },
                }),
            ]);

        const statusCounts: Record<string, number> = {};
        for (const g of memberCounts) {
            statusCounts[g.status] = g._count.id;
        }

        return {
            tenant,
            members: {
                active: statusCounts['ACTIVE'] ?? 0,
                invited: statusCounts['INVITED'] ?? 0,
                deactivated: statusCounts['DEACTIVATED'] ?? 0,
                total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
            },
            pendingInvites,
            identityProviders,
            security: securitySettings ?? { mfaPolicy: 'DISABLED', sessionMaxAgeMinutes: null },
        };
    });
}

// ─── List Pending Invites (DEPRECATED — use listPendingInvites from tenant-invites.ts) ───

export async function listPendingInvites(ctx: RequestContext) {
    const { listPendingInvites: listInvites } = await import('./tenant-invites');
    return listInvites(ctx);
}

// ─── Revoke Invite (DEPRECATED — use revokeInvite from tenant-invites.ts) ───

export async function revokeInvite(ctx: RequestContext, inviteId: string) {
    const { revokeInvite: revoke } = await import('./tenant-invites');
    return revoke(ctx, { inviteId });
}
