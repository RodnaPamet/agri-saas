/**
 * Epic D — Org invitation lifecycle.
 *
 * Mirrors `tenant-invites.ts` at the org layer. Every new
 * OrgMembership row that comes from invitation flow is:
 *   - email-bound (the redeemer's session email must match)
 *   - time-limited (7-day TTL by default)
 *   - atomically consumed (one redemption per token)
 *   - audit-chained (OrgAuditLog rows for create / redeem / revoke)
 *
 * Canonical lifecycle:
 *   1. ORG_ADMIN calls `createOrgInviteToken` → OrgInvite row + url.
 *   2. The url (/invite/org/<token>) is shared out-of-band with the invitee.
 *   3. Invitee loads the page → `previewOrgInviteByToken` (no side effects).
 *   4. Invitee signs in → `redeemOrgInvite` is called from the auth
 *      callback → OrgMembership created. If role=ORG_ADMIN, the
 *      provisioning fan-out fires (mirroring addOrgMember semantics).
 *   5. Admin may call `revokeOrgInvite` at any time before step 4.
 *
 * Org-layer note: this module operates on `OrgContext` (not
 * `RequestContext`) and against the global `prisma` client because
 * org-scoped tables (Organization, OrgMembership, OrgInvite) live
 * OUTSIDE the per-tenant RLS perimeter (org_isolation policy is
 * keyed on app.user_id, not app.tenant_id).
 *
 * @module usecases/org-invites
 */
import { randomBytes } from 'crypto';
import type { OrgInvite, OrgRole } from '@prisma/client';
import { OrgAuditAction } from '@prisma/client';
import type { OrgContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { hashForLookup, hashForLookupCandidates } from '@/lib/security/encryption';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { provisionOrgAdminToTenants, type ProvisionResult } from './org-provisioning';
import {
    badRequest,
    forbidden,
    gone,
    internal,
    notFound,
} from '@/lib/errors/types';

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Invite token time-to-live. 7 days — short enough to limit exposure
 * from a leaked link, long enough for a recipient who checks email
 * weekly. Mirrors TenantInvite TTL.
 */
const ORG_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────

export interface CreateOrgInviteResult {
    invite: OrgInvite;
    url: string;
}

export interface OrgInvitePreview {
    organizationName: string;
    organizationSlug: string;
    role: OrgRole;
    expiresAt: Date;
    /** True iff the signed-in user's email matches the invite email. */
    matchesSession: boolean;
}

export interface RedeemOrgInviteResult {
    organizationId: string;
    organizationSlug: string;
    role: OrgRole;
    /** Provisioning fan-out result, populated only when role === ORG_ADMIN. */
    provision?: ProvisionResult;
}

// ─── createOrgInviteToken ───────────────────────────────────────────

/**
 * Mint a new OrgInvite row and return the invite + a relative URL.
 *
 * Security invariants:
 *   - Caller must hold canManageMembers (gated at the route layer).
 *   - Rejects if email already has an org membership.
 *   - Upserts on (organizationId, email) refreshing token + expiry +
 *     clearing acceptedAt/revokedAt — so re-inviting after expiry or
 *     revocation works without manual cleanup.
 *
 * @returns invite row + relative URL (caller prepends origin for email).
 */
export async function createOrgInviteToken(
    ctx: OrgContext,
    input: { email: string; role: OrgRole },
): Promise<CreateOrgInviteResult> {
    const normalizedEmail = input.email.toLowerCase().trim();
    if (!normalizedEmail) throw badRequest('email is required');
    if (input.role !== 'ORG_ADMIN' && input.role !== 'ORG_READER') {
        throw badRequest(
            `Invalid role '${String(input.role)}' — must be ORG_ADMIN or ORG_READER`,
        );
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ORG_INVITE_TTL_MS);

    // Guard: reject if the user already has an OrgMembership.
    const existingUser = await prisma.user.findFirst({
        where: { emailHash: { in: hashForLookupCandidates(normalizedEmail) } },
        select: { id: true },
    });
    if (existingUser) {
        const existing = await prisma.orgMembership.findUnique({
            where: {
                organizationId_userId: {
                    organizationId: ctx.organizationId,
                    userId: existingUser.id,
                },
            },
            select: { role: true },
        });
        if (existing) {
            throw badRequest(
                `User is already a member of this organization (role=${existing.role})`,
            );
        }
    }

    const invite = await prisma.orgInvite.upsert({
        where: {
            organizationId_email: {
                organizationId: ctx.organizationId,
                email: normalizedEmail,
            },
        },
        create: {
            organizationId: ctx.organizationId,
            email: normalizedEmail,
            role: input.role,
            token,
            invitedById: ctx.userId,
            expiresAt,
        },
        update: {
            role: input.role,
            token,
            invitedById: ctx.userId,
            expiresAt,
            acceptedAt: null,
            revokedAt: null,
        },
    });

    // Best-effort audit. Mirrors emitOrgAudit in org-members.ts —
    // privilege change is durable in the DB, audit failure shouldn't
    // fail the user-facing operation.
    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: OrgAuditAction.ORG_INVITE_CREATED,
            targetUserId: existingUser?.id ?? null,
            detailsJson: {
                inviteId: invite.id,
                email: normalizedEmail,
                role: input.role,
                expiresAt: expiresAt.toISOString(),
            },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('org-invites.audit_emit_failed', {
            component: 'org-invites',
            organizationId: ctx.organizationId,
            inviteId: invite.id,
            action: 'ORG_INVITE_CREATED',
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return { invite, url: `/invite/org/${invite.token}` };
}

// ─── revokeOrgInvite ────────────────────────────────────────────────

/**
 * Revoke a pending invite by setting `revokedAt`. The row stays in
 * the DB so admins (and the audit ledger) can see the revocation
 * history. 404 if already accepted/revoked.
 */
export async function revokeOrgInvite(
    ctx: OrgContext,
    input: { inviteId: string },
): Promise<void> {
    const invite = await prisma.orgInvite.findFirst({
        where: {
            id: input.inviteId,
            organizationId: ctx.organizationId,
            acceptedAt: null,
            revokedAt: null,
        },
    });
    if (!invite) {
        throw notFound('Invite not found or already accepted/revoked.');
    }

    await prisma.orgInvite.update({
        where: { id: input.inviteId },
        data: { revokedAt: new Date() },
    });

    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action: OrgAuditAction.ORG_INVITE_REVOKED,
            targetUserId: null,
            detailsJson: {
                inviteId: invite.id,
                email: invite.email,
                role: invite.role,
            },
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('org-invites.audit_emit_failed', {
            component: 'org-invites',
            organizationId: ctx.organizationId,
            inviteId: invite.id,
            action: 'ORG_INVITE_REVOKED',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ─── listPendingOrgInvites ──────────────────────────────────────────

/**
 * Pending (non-expired, non-revoked, non-accepted) invites for the
 * org. Used by the members-page Pending Invites section.
 */
export async function listPendingOrgInvites(ctx: OrgContext) {
    return prisma.orgInvite.findMany({
        where: {
            organizationId: ctx.organizationId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        include: {
            invitedBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
}

// ─── previewOrgInviteByToken ────────────────────────────────────────

/**
 * Side-effect-free preview of an invite by raw token. Returns null
 * for any non-redeemable state (expired / revoked / accepted /
 * not-found) so the caller surfaces a single 410 Gone shape and
 * never leaks which specific failure mode occurred.
 *
 * @param token         The raw base64url invite token from the URL.
 * @param sessionEmail  Email of the currently signed-in user, or null.
 */
export async function previewOrgInviteByToken(
    token: string,
    sessionEmail: string | null,
): Promise<OrgInvitePreview | null> {
    const invite = await prisma.orgInvite.findUnique({
        where: { token },
        include: {
            organization: { select: { name: true, slug: true } },
        },
    });

    if (!invite) return null;
    if (invite.revokedAt) return null;
    if (invite.acceptedAt) return null;
    if (invite.expiresAt < new Date()) return null;

    const matchesSession =
        sessionEmail !== null &&
        invite.email.toLowerCase().trim() === sessionEmail.toLowerCase().trim();

    return {
        organizationName: invite.organization.name,
        organizationSlug: invite.organization.slug,
        role: invite.role,
        expiresAt: invite.expiresAt,
        matchesSession,
    };
}

// ─── redeemOrgInvite ────────────────────────────────────────────────

/**
 * Atomically consume an invite and create (or upgrade) the org
 * membership. Mirrors `redeemInvite` in tenant-invites.ts:
 *
 *   - Step 1 commits a standalone `updateMany` test-and-set so the
 *     burn (acceptedAt = now) is durable EVEN IF Step 3 throws
 *     (email-mismatch). A leaked token cannot be recycled.
 *   - Step 3 enforces email-binding (case-insensitive). Mismatch →
 *     403 + token already burnt.
 *   - Step 4 upserts the OrgMembership inside a `$transaction` so
 *     that the membership creation + slug fetch are consistent.
 *   - Step 5 (post-commit) emits the ORG_INVITE_REDEEMED + (if
 *     ORG_ADMIN) ORG_MEMBER_ADDED + ORG_ADMIN_PROVISIONED_TO_TENANTS
 *     audit rows. `appendOrgAuditEntry` opens its own
 *     advisory-locked transaction and MUST run outside the parent.
 *   - Step 6 (post-commit) fires the provisioning fan-out for
 *     ORG_ADMIN, mirroring the post-commit semantics in
 *     `addOrgMember`. The membership is durable; provisioning is a
 *     downstream effect.
 *
 * @param input.token      Raw token from the URL.
 * @param input.userId     The signed-in user's ID.
 * @param input.userEmail  The signed-in user's email.
 * @param input.requestId  Request correlation id (for audit rows).
 */
export async function redeemOrgInvite(input: {
    token: string;
    userId: string;
    userEmail: string;
    requestId?: string;
}): Promise<RedeemOrgInviteResult> {
    // Step 1 — atomic claim, standalone commit.
    const claim = await prisma.orgInvite.updateMany({
        where: {
            token: input.token,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
    });

    if (claim.count !== 1) {
        // Look up why for a precise error response. Anti-enumeration:
        // we still surface a 410 (or 404) — same response shape across
        // all "not redeemable" states; callers don't get to distinguish.
        const inv = await prisma.orgInvite.findUnique({
            where: { token: input.token },
            select: { acceptedAt: true, revokedAt: true, expiresAt: true },
        });
        if (!inv) throw notFound('Invite not found');
        if (inv.revokedAt) throw gone('Invite has been revoked');
        if (inv.expiresAt < new Date()) throw gone('Invite has expired');
        if (inv.acceptedAt) throw gone('Invite has already been redeemed');
        throw internal('Invite redemption race condition');
    }

    // Step 2 — re-fetch for the fields we need downstream.
    const invite = await prisma.orgInvite.findUnique({
        where: { token: input.token },
        select: {
            id: true,
            organizationId: true,
            email: true,
            role: true,
            invitedById: true,
        },
    });
    if (!invite) throw internal('Invariant: invite disappeared mid-redemption');

    // Step 3 — email binding. Token already burnt; mismatch ⇒ 403.
    if (
        invite.email.toLowerCase().trim() !==
        input.userEmail.toLowerCase().trim()
    ) {
        throw forbidden(
            'Invite email does not match signed-in user. ' +
                'Ask your admin to send a new invite to your email address.',
        );
    }

    // Step 4 — membership upsert + slug fetch in one transaction.
    const txResult = await prisma.$transaction(async (tx) => {
        const membership = await tx.orgMembership.upsert({
            where: {
                organizationId_userId: {
                    organizationId: invite.organizationId,
                    userId: input.userId,
                },
            },
            create: {
                organizationId: invite.organizationId,
                userId: input.userId,
                role: invite.role,
            },
            update: {
                // Re-redemption (e.g. re-invite after manual removal)
                // upgrades the role to whatever the invite specifies.
                role: invite.role,
            },
        });

        const org = await tx.organization.findUnique({
            where: { id: invite.organizationId },
            select: { slug: true },
        });
        if (!org) throw internal('Invariant: organization disappeared mid-redemption');

        return {
            membershipId: membership.id,
            organizationId: invite.organizationId,
            userId: input.userId,
            role: invite.role,
            slug: org.slug,
            inviteId: invite.id,
        };
    });

    // Step 5 — provisioning fan-out for ORG_ADMIN. Same post-commit
    // semantics as addOrgMember: provision first, then audit.
    let provision: ProvisionResult | undefined;
    if (txResult.role === 'ORG_ADMIN') {
        provision = await provisionOrgAdminToTenants(
            txResult.organizationId,
            txResult.userId,
        );
    }

    // Step 6 — audit. Three rows:
    //   1. ORG_INVITE_REDEEMED (the invite consumption itself)
    //   2. ORG_MEMBER_ADDED    (the new membership)
    //   3. ORG_ADMIN_PROVISIONED_TO_TENANTS (if fan-out fired)
    // Each is best-effort; a failure is logged but doesn't undo the
    // membership.
    await safeOrgAudit({
        organizationId: txResult.organizationId,
        actorUserId: input.userId,
        action: OrgAuditAction.ORG_INVITE_REDEEMED,
        targetUserId: input.userId,
        detailsJson: {
            inviteId: txResult.inviteId,
            role: txResult.role,
            membershipId: txResult.membershipId,
        },
        requestId: input.requestId,
    });
    await safeOrgAudit({
        organizationId: txResult.organizationId,
        actorUserId: input.userId,
        action: OrgAuditAction.ORG_MEMBER_ADDED,
        targetUserId: input.userId,
        detailsJson: {
            role: txResult.role,
            via: 'invite_redemption',
            inviteId: txResult.inviteId,
            provisionedTenantCount: provision?.created ?? 0,
        },
        requestId: input.requestId,
    });
    if (provision && provision.created > 0) {
        await safeOrgAudit({
            organizationId: txResult.organizationId,
            actorUserId: input.userId,
            action: OrgAuditAction.ORG_ADMIN_PROVISIONED_TO_TENANTS,
            targetUserId: input.userId,
            detailsJson: {
                trigger: 'invite_redemption',
                tenantCount: provision.created,
                tenantIds: provision.tenantIds,
                role: 'AUDITOR',
            },
            requestId: input.requestId,
        });
    }

    return {
        organizationId: txResult.organizationId,
        organizationSlug: txResult.slug,
        role: txResult.role,
        provision,
    };
}

// ─── safeOrgAudit (internal) ────────────────────────────────────────

async function safeOrgAudit(args: {
    organizationId: string;
    actorUserId: string | null;
    action: OrgAuditAction;
    targetUserId: string | null;
    detailsJson: Record<string, unknown>;
    requestId?: string;
}): Promise<void> {
    try {
        await appendOrgAuditEntry({
            organizationId: args.organizationId,
            actorUserId: args.actorUserId,
            actorType: 'USER',
            action: args.action,
            targetUserId: args.targetUserId,
            detailsJson: args.detailsJson,
            requestId: args.requestId ?? null,
        });
    } catch (err) {
        logger.warn('org-invites.audit_emit_failed', {
            component: 'org-invites',
            organizationId: args.organizationId,
            action: args.action,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
