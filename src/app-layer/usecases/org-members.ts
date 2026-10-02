/**
 * Epic O-2 — organization member management.
 *
 * Three operations:
 *   1. `addOrgMember` — create OrgMembership; if role=ORG_ADMIN, fan
 *      out AUDITOR memberships into every child tenant.
 *   2. `removeOrgMember` — fan in the deprovision (delete only auto-
 *      provisioned rows), then delete the OrgMembership. Manually-
 *      granted tenant memberships survive.
 *   3. `changeOrgMemberRole` — atomic ORG_READER ↔ ORG_ADMIN transition
 *      that pairs the role UPDATE with the matching tenant fan-out
 *      (promotion) or fan-in (demotion) inside one transaction. No
 *      remove-and-readd window, no half-state if either side fails.
 *
 * All three operations are idempotent (the underlying provisioning
 * service is). Callers must have passed `canManageMembers` at the
 * route layer; this usecase doesn't re-derive the permission.
 *
 * ## Audit trail (durable, per-tenant)
 *
 * Org membership lifecycle changes that affect TenantMembership rows
 * are persisted as `AuditLog` entries via `appendAuditEntry`. The
 * AuditLog table is tenant-scoped (`tenantId` is required), so one
 * audit row is written PER tenant whose access actually changed:
 *
 *   - `ORG_AUDITOR_PROVISIONED`   — written for each tenant where the
 *                                   user gained AUDITOR access (admin
 *                                   added; reader → admin promotion).
 *   - `ORG_AUDITOR_DEPROVISIONED` — written for each tenant where an
 *                                   auto-provisioned AUDITOR row was
 *                                   deleted (admin removed; admin →
 *                                   reader demotion). Manual rows are
 *                                   excluded from the predicate so
 *                                   they never trigger an audit row.
 *
 * Tenants with no access change (pre-existing manual membership;
 * reader add/remove with no fan-out; same-role no-op) get NO audit
 * row. The audit log records the actual access transition, not the
 * org-level intent. Structured `logger.info` calls remain as
 * supplementary observability but are no longer the load-bearing
 * compliance evidence.
 *
 * ## Last-ORG_ADMIN guard
 *
 * Removing — or demoting — the last ORG_ADMIN of an org would orphan
 * it (no one left to manage tenants/members). Both `removeOrgMember`
 * and `changeOrgMemberRole` enforce the guard at the usecase layer.
 * Mirrors the spirit of Epic 1's `tenant_membership_last_owner_guard`
 * — but at the usecase layer only, no DB trigger. A future iteration
 * can add a trigger if cross-code-path safety becomes a concern.
 */

import prisma from '@/lib/prisma';
import {
    provisionOrgAdminToTenants,
    deprovisionOrgAdmin,
    type ProvisionResult,
    type DeprovisionResult,
} from './org-provisioning';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import type { OrgContext } from '@/app-layer/types';
import { OrgAuditAction, type OrgRole } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import { appendAuditEntry } from '@/lib/audit';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';

// ── Audit fan-out helper ──────────────────────────────────────────────

// Per-tenant fan-out action strings written into the per-tenant
// AuditLog chain. Distinct from the Epic B `OrgAuditAction` Prisma
// enum (imported above), which targets the org-scoped `OrgAuditLog`.
type TenantFanoutAuditAction = 'ORG_AUDITOR_PROVISIONED' | 'ORG_AUDITOR_DEPROVISIONED';
type OrgAuditSource =
    | 'org_member_added'
    | 'org_member_removed'
    | 'org_member_promoted'
    | 'org_member_demoted';

/**
 * Fan an `ORG_AUDITOR_*` audit event out to every tenant where the
 * target user's access actually changed. Best-effort: a single
 * tenant's audit failure does not poison the rest, and a missed row
 * is recoverable via the chain-verification job. Each
 * `appendAuditEntry` call is per-tenant serialised behind an
 * advisory lock so the hash chain in each affected tenant stays
 * intact.
 *
 * Called AFTER the membership operation (and any wrapping
 * transaction) commits — same lifecycle as `events/audit.ts:logEvent`.
 * If the caller's transaction rolls back, this helper isn't reached
 * and no audit row is written.
 */
async function emitOrgMembershipAudit(
    ctx: OrgContext,
    args: {
        action: TenantFanoutAuditAction;
        sourceAction: OrgAuditSource;
        targetUserId: string;
        tenantIds: ReadonlyArray<string>;
        previousOrgRole?: OrgRole;
        newOrgRole?: OrgRole;
    },
): Promise<void> {
    if (args.tenantIds.length === 0) return;

    const detailsJson = {
        category: 'access' as const,
        event: args.action,
        targetUserId: args.targetUserId,
        operation: args.sourceAction,
        sourceAction: args.sourceAction,
        orgSlug: ctx.orgSlug,
        organizationId: ctx.organizationId,
        ...(args.previousOrgRole ? { previousOrgRole: args.previousOrgRole } : {}),
        ...(args.newOrgRole ? { newOrgRole: args.newOrgRole } : {}),
    };

    await Promise.all(
        args.tenantIds.map((tenantId) =>
            appendAuditEntry({
                tenantId,
                userId: ctx.userId,
                actorType: 'USER',
                entity: 'TenantMembership',
                entityId: args.targetUserId,
                action: args.action,
                detailsJson,
                requestId: ctx.requestId,
            }).catch((err: unknown) => {
                logger.warn('org-members.audit_emit_failed', {
                    component: 'org-members',
                    tenantId,
                    targetUserId: args.targetUserId,
                    action: args.action,
                    error: err instanceof Error ? err.message : String(err),
                });
            }),
        ),
    );
}

// ── Org-level audit emission helper ───────────────────────────────────

/**
 * Append a row to the org-scoped audit chain (`OrgAuditLog`). Epic B
 * requires every privilege-affecting org mutation to leave an
 * immutable, hash-chained record at the org level — this helper is
 * the single emission point.
 *
 * Best-effort by design (mirrors `emitOrgMembershipAudit`): the
 * privilege change has already committed by the time this runs, so a
 * write failure here can NOT roll the change back. We log the failure
 * structurally; the chain-verification job picks up the gap. Failing
 * the user-facing operation would be worse than a recoverable audit
 * gap (the privilege change is durable; the audit row can be
 * backfilled).
 */
async function emitOrgAudit(
    ctx: OrgContext,
    args: {
        action: OrgAuditAction;
        targetUserId: string | null;
        detailsJson: Record<string, unknown>;
    },
): Promise<void> {
    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: args.action,
            targetUserId: args.targetUserId,
            detailsJson: args.detailsJson,
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('org-audit.emit_failed', {
            component: 'org-members',
            organizationId: ctx.organizationId,
            action: args.action,
            targetUserId: args.targetUserId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── listOrgMembers ────────────────────────────────────────────────────

export interface OrgMemberRow {
    membershipId: string;
    userId: string;
    role: OrgRole;
    /** ISO timestamp — when the OrgMembership row was created. */
    joinedAt: string;
    user: {
        id: string;
        email: string;
        name: string | null;
    };
}

/**
 * Returns the org's full member list with user identity, role, and
 * joined timestamp. Read-only — used by the org members management
 * page. Caller must have passed `canManageMembers` at the route /
 * page layer; this usecase does not re-derive permission since the
 * member list is by-design visible to anyone managing the org.
 *
 * Sorted: ORG_ADMIN first (most-likely target of admin management
 * decisions), then ORG_READER, alphabetical by email within each
 * bucket. Stable across reloads.
 */
export async function listOrgMembers(
    ctx: OrgContext,
): Promise<OrgMemberRow[]> {
    const memberships = await prisma.orgMembership.findMany({
        where: { organizationId: ctx.organizationId },
        select: {
            id: true,
            userId: true,
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, name: true } },
        },
    });

    return memberships
        .map(
            (m): OrgMemberRow => ({
                membershipId: m.id,
                userId: m.userId,
                role: m.role,
                joinedAt: m.createdAt.toISOString(),
                user: m.user,
            }),
        )
        .sort((a, b) => {
            // ORG_ADMIN before ORG_READER so the most-actionable rows
            // sit at the top of the table.
            if (a.role !== b.role) return a.role === 'ORG_ADMIN' ? -1 : 1;
            return a.user.email.localeCompare(b.user.email);
        });
}

// ── addOrgMember ──────────────────────────────────────────────────────

export interface AddOrgMemberInput {
    /** Target user — looked up by email. Created as a placeholder if
     *  no user row matches yet. */
    userEmail: string;
    role: OrgRole;
}

export interface AddOrgMemberResult {
    membership: {
        id: string;
        organizationId: string;
        userId: string;
        role: OrgRole;
    };
    user: { id: string; email: string };
    /** Provisioning fan-out result, populated only when role === ORG_ADMIN. */
    provision?: ProvisionResult;
}

export async function addOrgMember(
    ctx: OrgContext,
    input: AddOrgMemberInput,
): Promise<AddOrgMemberResult> {
    const email = input.userEmail.trim().toLowerCase();
    if (!email) {
        throw new ValidationError('userEmail is required');
    }

    // Find-or-create the User row. Mirrors `createTenantWithOwner` —
    // a placeholder lets an admin add a member by email before that
    // user has signed in for the first time.
    // An upsert's `where` takes a UNIQUE SCALAR, so it cannot carry the candidate
    // list. Keyed on the primary hash alone it would MISS a row still holding the
    // previous hash mid-rotation and CREATE A SECOND `User` for an address that
    // already has one — the duplicate-User defect, arrived at from the write side.
    // So the candidate read runs first, and the upsert is reached only when no row
    // exists under EITHER key, where it still provides the ON CONFLICT guard
    // against two concurrent creates.
    const emailHash = hashForLookup(email);
    const user =
        (await prisma.user.findFirst({
            where: { emailHash: { in: hashForLookupCandidates(email) } },
            select: { id: true, email: true },
        })) ??
        (await prisma.user.upsert({
            where: { emailHash },
            update: {},
            create: { email, emailHash },
            select: { id: true, email: true },
        }));

    // Fail loud if the user is already a member rather than silently
    // accepting an idempotent overwrite. Role changes need a separate
    // flow (out of scope here) to avoid surprising re-provisioning.
    const existing = await prisma.orgMembership.findUnique({
        where: {
            organizationId_userId: {
                organizationId: ctx.organizationId,
                userId: user.id,
            },
        },
        select: { role: true },
    });
    if (existing) {
        throw new ConflictError(
            `User is already a member of this organization (role=${existing.role})`,
        );
    }

    const membership = await prisma.orgMembership.create({
        data: {
            organizationId: ctx.organizationId,
            userId: user.id,
            role: input.role,
        },
        select: {
            id: true,
            organizationId: true,
            userId: true,
            role: true,
        },
    });

    let provision: ProvisionResult | undefined;
    if (input.role === 'ORG_ADMIN') {
        provision = await provisionOrgAdminToTenants(
            ctx.organizationId,
            user.id,
        );
        if (provision.tenantIds.length > 0) {
            await emitOrgMembershipAudit(ctx, {
                action: 'ORG_AUDITOR_PROVISIONED',
                sourceAction: 'org_member_added',
                targetUserId: user.id,
                tenantIds: provision.tenantIds,
                newOrgRole: 'ORG_ADMIN',
            });
        }
    }

    // Epic B — durable org-scoped audit. ORG_MEMBER_ADDED records the
    // privilege grant itself; ORG_ADMIN_PROVISIONED_TO_TENANTS records
    // the fan-out as a SEPARATE event so an auditor can distinguish
    // "membership change" from "tenant access propagation". Both rows
    // chain into the same per-org ledger so reading them in
    // occurredAt order tells the full story.
    await emitOrgAudit(ctx, {
        action: OrgAuditAction.ORG_MEMBER_ADDED,
        targetUserId: user.id,
        detailsJson: {
            role: input.role,
            provisionedTenantCount: provision?.created ?? 0,
        },
    });
    if (provision && provision.created > 0) {
        await emitOrgAudit(ctx, {
            action: OrgAuditAction.ORG_ADMIN_PROVISIONED_TO_TENANTS,
            targetUserId: user.id,
            detailsJson: {
                trigger: 'org_member_added',
                tenantCount: provision.created,
                tenantIds: provision.tenantIds,
                role: 'AUDITOR',
            },
        });
    }

    logger.info('org-members.added', {
        component: 'org-members',
        organizationId: ctx.organizationId,
        userId: user.id,
        role: input.role,
        provisionedTenants: provision?.created ?? 0,
        requestId: ctx.requestId,
    });

    return {
        membership,
        user: { id: user.id, email: user.email },
        provision,
    };
}

// ── removeOrgMember ───────────────────────────────────────────────────

export interface RemoveOrgMemberInput {
    /** Target user id. Email lookup is the caller's responsibility — a
     *  user with a stale email in the UI shouldn't accidentally remove
     *  someone else. */
    userId: string;
}

export interface RemoveOrgMemberResult {
    deletedMembershipId: string;
    /** Was the removed member an ORG_ADMIN? */
    wasOrgAdmin: boolean;
    /** Deprovision fan-in result, populated only when wasOrgAdmin. */
    deprovision?: DeprovisionResult;
}

export async function removeOrgMember(
    ctx: OrgContext,
    input: RemoveOrgMemberInput,
): Promise<RemoveOrgMemberResult> {
    const userId = input.userId?.trim();
    if (!userId) {
        throw new ValidationError('userId is required');
    }

    const membership = await prisma.orgMembership.findUnique({
        where: {
            organizationId_userId: {
                organizationId: ctx.organizationId,
                userId,
            },
        },
        select: { id: true, role: true },
    });
    if (!membership) {
        throw new NotFoundError('Org membership not found');
    }

    // Last-ORG_ADMIN guard. If the target is the only remaining
    // ORG_ADMIN, refuse the removal — orphaning the org breaks
    // tenant/member management.
    if (membership.role === 'ORG_ADMIN') {
        const adminCount = await prisma.orgMembership.count({
            where: {
                organizationId: ctx.organizationId,
                role: 'ORG_ADMIN',
            },
        });
        if (adminCount <= 1) {
            throw new ConflictError(
                'Cannot remove the last ORG_ADMIN of an organization. ' +
                    'Promote another member to ORG_ADMIN first, or delete the ' +
                    'organization.',
            );
        }
    }

    let deprovision: DeprovisionResult | undefined;
    if (membership.role === 'ORG_ADMIN') {
        // Fan-in BEFORE deleting the OrgMembership so the user's
        // tenant-side AUDITOR rows are gone before they lose
        // org-admin status. The order doesn't change correctness —
        // both operations are idempotent — but it preserves the
        // logical sequence for any concurrent observer.
        deprovision = await deprovisionOrgAdmin(ctx.organizationId, userId);
    }

    await prisma.orgMembership.delete({
        where: { id: membership.id },
    });

    if (deprovision && deprovision.tenantIds.length > 0) {
        await emitOrgMembershipAudit(ctx, {
            action: 'ORG_AUDITOR_DEPROVISIONED',
            sourceAction: 'org_member_removed',
            targetUserId: userId,
            tenantIds: deprovision.tenantIds,
            previousOrgRole: 'ORG_ADMIN',
        });
    }

    // Epic B — durable org-scoped audit. The ORG_MEMBER_REMOVED row
    // is always written; the fan-in summary lands separately when
    // the deprovision actually deleted any auto-provisioned rows.
    await emitOrgAudit(ctx, {
        action: OrgAuditAction.ORG_MEMBER_REMOVED,
        targetUserId: userId,
        detailsJson: {
            previousRole: membership.role,
            deprovisionedTenantCount: deprovision?.deleted ?? 0,
        },
    });
    if (deprovision && deprovision.deleted > 0) {
        await emitOrgAudit(ctx, {
            action: OrgAuditAction.ORG_ADMIN_DEPROVISIONED_FROM_TENANTS,
            targetUserId: userId,
            detailsJson: {
                trigger: 'org_member_removed',
                tenantCount: deprovision.deleted,
                tenantIds: deprovision.tenantIds,
                role: 'AUDITOR',
            },
        });
    }

    logger.info('org-members.removed', {
        component: 'org-members',
        organizationId: ctx.organizationId,
        userId,
        wasOrgAdmin: membership.role === 'ORG_ADMIN',
        deprovisionedTenants: deprovision?.deleted ?? 0,
        requestId: ctx.requestId,
    });

    return {
        deletedMembershipId: membership.id,
        wasOrgAdmin: membership.role === 'ORG_ADMIN',
        deprovision,
    };
}

// ── changeOrgMemberRole ───────────────────────────────────────────────

export interface ChangeOrgMemberRoleInput {
    userId: string;
    role: OrgRole;
}

export type ChangeOrgMemberRoleTransition =
    | 'noop'
    | 'reader_to_admin'
    | 'admin_to_reader';

export interface ChangeOrgMemberRoleResult {
    membership: {
        id: string;
        organizationId: string;
        userId: string;
        role: OrgRole;
    };
    /** Which transition the change effected. `noop` means the row was
     *  already at the requested role — no provisioning side effects. */
    transition: ChangeOrgMemberRoleTransition;
    /** Provisioning fan-out result, populated only on `reader_to_admin`. */
    provision?: ProvisionResult;
    /** Deprovision fan-in result, populated only on `admin_to_reader`. */
    deprovision?: DeprovisionResult;
}

/**
 * Atomic role transition for an existing org member.
 *
 * Replaces the legacy remove-and-readd workaround. The OrgMembership
 * UPDATE and the matching tenant fan-out / fan-in commit together in
 * a single `$transaction`, so either:
 *
 *   - both sides succeed (the desired end state), or
 *   - both sides roll back (we stay in the prior state).
 *
 * Never half-state — no admin without tenant access, no orphaned
 * AUDITOR memberships pointing at a now-READER user.
 *
 * Idempotent on no-op transitions (target role == current role).
 *
 * Last-admin guard: ADMIN→READER refuses if the target is the only
 * remaining ORG_ADMIN. Promote someone else first.
 */
export async function changeOrgMemberRole(
    ctx: OrgContext,
    input: ChangeOrgMemberRoleInput,
): Promise<ChangeOrgMemberRoleResult> {
    const userId = input.userId?.trim();
    if (!userId) {
        throw new ValidationError('userId is required');
    }
    const newRole = input.role;
    if (newRole !== 'ORG_ADMIN' && newRole !== 'ORG_READER') {
        throw new ValidationError(
            `Invalid role '${String(newRole)}' — must be ORG_ADMIN or ORG_READER`,
        );
    }

    const existing = await prisma.orgMembership.findUnique({
        where: {
            organizationId_userId: {
                organizationId: ctx.organizationId,
                userId,
            },
        },
        select: { id: true, role: true },
    });
    if (!existing) {
        throw new NotFoundError('Org membership not found');
    }

    // No-op fast path. Returns success without opening a transaction
    // or touching the provisioning chain — repeated PUT with the same
    // role is cheap and safe.
    if (existing.role === newRole) {
        logger.info('org-members.role_change_noop', {
            component: 'org-members',
            organizationId: ctx.organizationId,
            userId,
            role: newRole,
            requestId: ctx.requestId,
        });
        return {
            membership: {
                id: existing.id,
                organizationId: ctx.organizationId,
                userId,
                role: existing.role,
            },
            transition: 'noop',
        };
    }

    // Last-admin guard for ADMIN→READER. Read the count outside the
    // transaction — the transaction below will refuse to commit if
    // racing demotions reduce the count further (the row's role is
    // updated under the count's read snapshot in the same tx, and the
    // re-check inside the tx tightens the window to a single read-
    // verify-write under the same read view).
    if (existing.role === 'ORG_ADMIN' && newRole === 'ORG_READER') {
        const adminCount = await prisma.orgMembership.count({
            where: {
                organizationId: ctx.organizationId,
                role: 'ORG_ADMIN',
            },
        });
        if (adminCount <= 1) {
            throw new ConflictError(
                'Cannot demote the last ORG_ADMIN of an organization. ' +
                    'Promote another member to ORG_ADMIN first, or delete the ' +
                    'organization.',
            );
        }
    }

    const transition: ChangeOrgMemberRoleTransition =
        existing.role === 'ORG_READER' ? 'reader_to_admin' : 'admin_to_reader';

    const result = await prisma.$transaction(async (tx) => {
        // Re-check the last-admin guard INSIDE the transaction so a
        // racing demotion can't slip past the outer count read.
        // Postgres's READ COMMITTED default makes this a tight check
        // for the demote case.
        if (transition === 'admin_to_reader') {
            const adminCount = await tx.orgMembership.count({
                where: {
                    organizationId: ctx.organizationId,
                    role: 'ORG_ADMIN',
                },
            });
            if (adminCount <= 1) {
                throw new ConflictError(
                    'Cannot demote the last ORG_ADMIN of an organization. ' +
                        'Promote another member to ORG_ADMIN first, or delete the ' +
                        'organization.',
                );
            }
        }

        const updated = await tx.orgMembership.update({
            where: { id: existing.id },
            data: { role: newRole },
            select: {
                id: true,
                organizationId: true,
                userId: true,
                role: true,
            },
        });

        let provision: ProvisionResult | undefined;
        let deprovision: DeprovisionResult | undefined;

        if (transition === 'reader_to_admin') {
            // Fan out AUDITOR rows into every child tenant. Idempotent
            // — pre-existing manual memberships are preserved by the
            // unique-on-(tenantId, userId) skipDuplicates path.
            provision = await provisionOrgAdminToTenants(
                ctx.organizationId,
                userId,
                tx,
            );
        } else {
            // Fan in. `deprovisionOrgAdmin` deletes ONLY rows tagged
            // `provisionedByOrgId === ctx.organizationId` AND
            // `role === AUDITOR`. Manually-granted tenant memberships
            // and rows from a different org survive.
            deprovision = await deprovisionOrgAdmin(
                ctx.organizationId,
                userId,
                tx,
            );
        }

        return { updated, provision, deprovision };
    });

    // Audit fan-out — runs AFTER the transaction commits, mirroring
    // the post-commit semantics of `events/audit.ts:logEvent`. If the
    // transaction had rolled back we wouldn't reach this line.
    if (transition === 'reader_to_admin' && result.provision && result.provision.tenantIds.length > 0) {
        await emitOrgMembershipAudit(ctx, {
            action: 'ORG_AUDITOR_PROVISIONED',
            sourceAction: 'org_member_promoted',
            targetUserId: userId,
            tenantIds: result.provision.tenantIds,
            previousOrgRole: 'ORG_READER',
            newOrgRole: 'ORG_ADMIN',
        });
    } else if (
        transition === 'admin_to_reader' &&
        result.deprovision &&
        result.deprovision.tenantIds.length > 0
    ) {
        await emitOrgMembershipAudit(ctx, {
            action: 'ORG_AUDITOR_DEPROVISIONED',
            sourceAction: 'org_member_demoted',
            targetUserId: userId,
            tenantIds: result.deprovision.tenantIds,
            previousOrgRole: 'ORG_ADMIN',
            newOrgRole: 'ORG_READER',
        });
    }

    // Epic B — durable org-scoped audit. ORG_MEMBER_ROLE_CHANGED
    // records the role transition; the fan-out / fan-in summary lands
    // as a separate row when it actually moved tenant access.
    await emitOrgAudit(ctx, {
        action: OrgAuditAction.ORG_MEMBER_ROLE_CHANGED,
        targetUserId: userId,
        detailsJson: {
            previousRole: existing.role,
            newRole,
            transition,
            provisionedTenantCount: result.provision?.created ?? 0,
            deprovisionedTenantCount: result.deprovision?.deleted ?? 0,
        },
    });
    if (transition === 'reader_to_admin' && result.provision && result.provision.created > 0) {
        await emitOrgAudit(ctx, {
            action: OrgAuditAction.ORG_ADMIN_PROVISIONED_TO_TENANTS,
            targetUserId: userId,
            detailsJson: {
                trigger: 'org_member_promoted',
                tenantCount: result.provision.created,
                tenantIds: result.provision.tenantIds,
                role: 'AUDITOR',
            },
        });
    } else if (transition === 'admin_to_reader' && result.deprovision && result.deprovision.deleted > 0) {
        await emitOrgAudit(ctx, {
            action: OrgAuditAction.ORG_ADMIN_DEPROVISIONED_FROM_TENANTS,
            targetUserId: userId,
            detailsJson: {
                trigger: 'org_member_demoted',
                tenantCount: result.deprovision.deleted,
                tenantIds: result.deprovision.tenantIds,
                role: 'AUDITOR',
            },
        });
    }

    logger.info('org-members.role_changed', {
        component: 'org-members',
        organizationId: ctx.organizationId,
        userId,
        previousRole: existing.role,
        newRole,
        transition,
        provisionedTenants: result.provision?.created ?? 0,
        deprovisionedTenants: result.deprovision?.deleted ?? 0,
        requestId: ctx.requestId,
    });

    return {
        membership: result.updated,
        transition,
        provision: result.provision,
        deprovision: result.deprovision,
    };
}
