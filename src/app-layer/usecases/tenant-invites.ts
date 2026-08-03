/**
 * Tenant Invite Usecases — Token-Redemption Path to Membership
 *
 * Epic 1, PR 3. Every new TenantMembership row now comes through
 * redeemInvite — email-bound, time-limited, atomically consumed, and
 * audit-chained. The old "existing user → direct ACTIVE membership"
 * shortcut in tenant-admin.ts is gone.
 *
 * Canonical invite lifecycle:
 *   1. ADMIN calls createInviteToken → TenantInvite row + url.
 *   2. System emails the url to the invitee.
 *   3. Invitee loads /invite/[token] → previewInviteByToken (no side effect).
 *   4. Invitee signs in → redeemInvite is called → membership created.
 *   5. Admin may call revokeInvite at any time before step 4.
 *
 * @module usecases/tenant-invites
 */
import { randomBytes } from 'crypto';
import type { Role, TenantInvite } from '@prisma/client';
import { RequestContext } from '../types';
import {
    assertCanManageMembers,
    assertCanViewAdminSettings,
} from '../policies/admin.policies';
import { logEvent } from '../events/audit';
import { appendAuditEntry } from '@/lib/audit';
import { runInTenantContext } from '@/lib/db-context';
import { assertWithinLimit } from '@/lib/billing/entitlements';
import { notFound, badRequest, forbidden, gone, internal } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { hashForLookup } from '@/lib/security/encryption';

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Invite token time-to-live.
 *
 * TODO(future): make configurable via TenantSecuritySettings.inviteMaxAgeDays
 * once that column lands — the current schema has no such column.
 * For now 7 days is a safe default: short enough to limit exposure
 * from a leaked link, long enough for a recipient who checks email weekly.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── createInviteToken ───────────────────────────────────────────────

export interface CreateInviteResult {
    invite: TenantInvite;
    url: string;
}

/**
 * Mint a new TenantInvite row and return the invite + a relative URL.
 *
 * Security invariants:
 *   - Requires admin.members permission (assertCanManageMembers).
 *   - OWNER invites additionally require ctx.appPermissions.admin.owner_management.
 *   - Rejects if the email already has an ACTIVE membership.
 *   - Upserts on (tenantId, email) unique key, refreshing token + expiry.
 *
 * @returns invite row + relative URL (caller prepends origin for email).
 */
export async function createInviteToken(
    ctx: RequestContext,
    input: { email: string; role: Role },
): Promise<CreateInviteResult> {
    assertCanManageMembers(ctx);

    if (input.role === 'OWNER') {
        if (!ctx.appPermissions.admin.owner_management) {
            throw forbidden('Only OWNERs can invite other OWNERs');
        }
    }

    // Plan gate: cap active team members (seats) on the startup-farmer
    // (FREE) tier; ENTERPRISE is unlimited.
    await assertWithinLimit(ctx, 'user');

    const normalizedEmail = input.email.toLowerCase().trim();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await runInTenantContext(ctx, async (db) => {
        // Guard: reject if there's already an ACTIVE membership for this email.
        const existingUser = await db.user.findUnique({
            where: { emailHash: hashForLookup(normalizedEmail) },
            select: { id: true },
        });
        if (existingUser) {
            const existing = await db.tenantMembership.findUnique({
                where: {
                    tenantId_userId: {
                        tenantId: ctx.tenantId,
                        userId: existingUser.id,
                    },
                },
                select: { status: true },
            });
            if (existing?.status === 'ACTIVE') {
                throw badRequest('User is already a member of this tenant');
            }
        }

        // Upsert — the @@unique([tenantId, email]) index handles dedup.
        const inv = await db.tenantInvite.upsert({
            where: {
                tenantId_email: {
                    tenantId: ctx.tenantId,
                    email: normalizedEmail,
                },
            },
            create: {
                tenantId: ctx.tenantId,
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
                revokedAt: null,
                acceptedAt: null,
            },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_INVITED',
            entityType: 'TenantInvite',
            entityId: inv.id,
            details: `Invited ${normalizedEmail} as ${input.role}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantInvite',
                operation: 'created',
                after: {
                    email: normalizedEmail,
                    role: input.role,
                    expiresAt: expiresAt.toISOString(),
                },
                summary: `Invited ${normalizedEmail} as ${input.role}`,
            },
        });

        return inv;
    });

    return { invite, url: `/invite/${invite.token}` };
}

// ─── revokeInvite ────────────────────────────────────────────────────

/**
 * Revoke a pending invite by setting revokedAt.
 *
 * 404 if the invite does not exist, belongs to another tenant, or is
 * already accepted/revoked.
 */
export async function revokeInvite(
    ctx: RequestContext,
    input: { inviteId: string },
): Promise<void> {
    assertCanManageMembers(ctx);

    await runInTenantContext(ctx, async (db) => {
        const invite = await db.tenantInvite.findFirst({
            where: {
                id: input.inviteId,
                tenantId: ctx.tenantId,
                acceptedAt: null,
                revokedAt: null,
            },
        });

        if (!invite) throw notFound('Invite not found or already accepted/revoked.');

        const revoked = await db.tenantInvite.update({
            where: { id: input.inviteId },
            data: { revokedAt: new Date() },
        });

        await logEvent(db, ctx, {
            action: 'MEMBER_INVITE_REVOKED',
            entityType: 'TenantInvite',
            entityId: revoked.id,
            details: `Revoked invite for ${invite.email}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantInvite',
                operation: 'deleted',
                summary: `Revoked invite for ${invite.email}`,
            },
        });
    });
}

/**
 * Bulk-revoke pending invites — the table action-row's "Revoke selected"
 * affordance. Mirrors {@link revokeInvite} but over a set of ids in a single
 * tenant-scoped `updateMany`; the `acceptedAt: null, revokedAt: null`
 * predicate makes it idempotent (already-accepted/revoked ids are skipped,
 * never error). One audit row per actually-revoked invite. Returns the count
 * actually revoked.
 */
export async function bulkRevokeInvite(
    ctx: RequestContext,
    input: { inviteIds: string[] },
): Promise<{ revoked: number }> {
    assertCanManageMembers(ctx);

    return runInTenantContext(ctx, async (db) => {
        const invites = await db.tenantInvite.findMany({
            where: {
                id: { in: input.inviteIds },
                tenantId: ctx.tenantId,
                acceptedAt: null,
                revokedAt: null,
            },
            select: { id: true, email: true },
        });
        if (invites.length === 0) return { revoked: 0 };

        await db.tenantInvite.updateMany({
            where: {
                id: { in: invites.map((i) => i.id) },
                tenantId: ctx.tenantId,
                acceptedAt: null,
                revokedAt: null,
            },
            data: { revokedAt: new Date() },
        });

        for (const invite of invites) {
            await logEvent(db, ctx, {
                action: 'MEMBER_INVITE_REVOKED',
                entityType: 'TenantInvite',
                entityId: invite.id,
                details: `Revoked invite for ${invite.email}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'TenantInvite',
                    operation: 'deleted',
                    summary: `Revoked invite for ${invite.email}`,
                },
            });
        }

        return { revoked: invites.length };
    });
}

// ─── listPendingInvites ──────────────────────────────────────────────

/**
 * List pending (non-expired, non-revoked, non-accepted) invites for
 * the calling tenant.
 */
export async function listPendingInvites(ctx: RequestContext) {
    assertCanViewAdminSettings(ctx);

    return runInTenantContext(ctx, (db) =>
        db.tenantInvite.findMany({
            where: {
                tenantId: ctx.tenantId,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
            include: {
                invitedBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
}

// ─── previewInviteByToken ────────────────────────────────────────────

export interface InvitePreview {
    tenantName: string;
    tenantSlug: string;
    role: Role;
    expiresAt: Date;
    /** True iff the signed-in user's email matches the invite email. */
    matchesSession: boolean;
}

/**
 * Public preview of an invite by raw token.
 *
 * Returns null for expired / revoked / accepted / not-found invites
 * so the caller can surface a 410 / 404 without exposing internals.
 * No audit entry — preview is idempotent + side-effect-free.
 *
 * @param token       The raw base64url invite token from the URL.
 * @param sessionEmail Email of the currently signed-in user, or null.
 */
export async function previewInviteByToken(
    token: string,
    sessionEmail: string | null,
): Promise<InvitePreview | null> {
    const invite = await prisma.tenantInvite.findUnique({
        where: { token },
        include: {
            tenant: { select: { name: true, slug: true } },
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
        tenantName: invite.tenant.name,
        tenantSlug: invite.tenant.slug,
        role: invite.role,
        expiresAt: invite.expiresAt,
        matchesSession,
    };
}

// ─── redeemInvite ────────────────────────────────────────────────────

export interface RedeemResult {
    tenantId: string;
    slug: string;
    role: Role;
}

/**
 * Atomically consume an invite and create (or reactivate) the membership.
 *
 * Security contract:
 *   - Uses `$transaction` with an `updateMany` predicate that acts as a
 *     SELECT-FOR-UPDATE-style atomic claim. Exactly one concurrent caller
 *     wins; the rest get a 410 Gone.
 *   - Email binding is strict (case-insensitive): if the redeemer's
 *     email does not match the invite, the invite is burnt (prevents
 *     token forwarding) and a 403 is thrown. The inviter must re-invite.
 *   - Runs outside any tenant RLS context (the caller is not yet a
 *     tenant member). Uses the default Prisma client with superuser
 *     credentials so RLS is bypassed for this write.
 *   - The audit entry is emitted AFTER the outer $transaction commits,
 *     because appendAuditEntry opens its own advisory-locked $transaction
 *     and must not be called from inside another $transaction.
 *
 * @param input.token      Raw token from the URL.
 * @param input.userId     The signed-in user's ID.
 * @param input.userEmail  The signed-in user's email (for binding check).
 */
export async function redeemInvite(input: {
    token: string;
    userId: string;
    userEmail: string;
}): Promise<RedeemResult> {
    // Step 1 runs standalone so that email-mismatch (step 3) BURNS the
    // invite — the throw in step 3 must NOT roll back the claim. If we
    // put everything in a single $transaction, Prisma would undo the
    // acceptedAt write on throw, and a token leak could be recycled.

    // ── Step 1: atomic claim (standalone commit) ─────────────────────
    // updateMany with the liveness predicates is the "test-and-set":
    // the first caller whose WHERE matches wins count=1; subsequent
    // callers (same token, concurrent) see acceptedAt already set
    // and get count=0.
    const claim = await prisma.tenantInvite.updateMany({
        where: {
            token: input.token,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
    });

    if (claim.count !== 1) {
        // Look up why for a precise error message.
        const inv = await prisma.tenantInvite.findUnique({
            where: { token: input.token },
            select: { acceptedAt: true, revokedAt: true, expiresAt: true },
        });
        if (!inv) throw notFound('Invite not found');
        if (inv.revokedAt) throw gone('Invite has been revoked');
        if (inv.expiresAt < new Date()) throw gone('Invite has expired');
        if (inv.acceptedAt) throw gone('Invite has already been redeemed');
        throw internal('Invite redemption race condition');
    }

    // ── Step 2: re-fetch to get all needed fields ─────────────────
    const invite = await prisma.tenantInvite.findUnique({
        where: { token: input.token },
        select: {
            id: true,
            tenantId: true,
            email: true,
            role: true,
            invitedById: true,
        },
    });
    if (!invite) throw internal('Invariant: invite disappeared mid-redemption');

    // ── Step 3: email binding ─────────────────────────────────────
    // If the redeemer's email doesn't match the invite email, the
    // invite IS NOW BURNT (acceptedAt committed in Step 1). Leave it
    // so a leaked token cannot be recycled by the real invitee or
    // anyone else. The inviter must issue a fresh invite.
    if (
        invite.email.toLowerCase().trim() !==
        input.userEmail.toLowerCase().trim()
    ) {
        throw forbidden(
            'Invite email does not match signed-in user. ' +
                'Ask your admin to send a new invite to your email address.',
        );
    }

    // ── Step 4 onwards: materialise the grant. Shared with the
    //   verified-email entry point below. If it fails, acceptedAt from
    //   Step 1 is STILL committed (invite burnt) — the safe failure mode.
    return finalizeInviteRedemption(invite, input.userId);
}

/**
 * Sign-in-time membership provisioning by VERIFIED-EMAIL match.
 *
 * The emailed link is only ONE way to consume an invite. Email delivery
 * is unreliable (SMTP drop, spam quarantine, a user who just clicks
 * "Sign in with Microsoft" instead of hunting for the mail), so an admin
 * who adds a member and an invitee who simply signs in with that same
 * address should Just Work. The pending TenantInvite is the standing
 * authorisation; a verified-email login proves possession of the address
 * exactly as the token URL proves possession of the link.
 *
 * ## Security contract — this is NOT auto-join (GAP-01)
 *
 *   - Redeems ONLY invites an admin EXPLICITLY created for this exact
 *     email + role via {@link createInviteToken}. **No invite ⇒ no
 *     membership.** Sign-in still grants authentication and nothing else.
 *   - The CALLER must guarantee the email is IdP-verified. `src/auth.ts`
 *     does: its `signIn` callback rejects `email_verified === false`, and
 *     the jwt-callback call site passes `emailVerifiedByIdp` only for
 *     non-credentials providers. **Never call this for the credentials
 *     provider** — self-registration lets anyone claim any address, so
 *     honouring an invite there would hand a tenant to whoever guessed
 *     an invited email.
 *   - Each invite is claimed atomically with the same liveness
 *     predicates as {@link redeemInvite}, so a concurrent link-click and
 *     login cannot double-redeem; the loser skips.
 *   - Idempotent: an already-ACTIVE member re-runs the upsert harmlessly,
 *     and only when a fresh pending invite exists for them.
 *
 * Redeems ALL pending invites for the address, so a user invited to
 * several tenants gets every membership on first login.
 *
 * @returns memberships created or reactivated — may be empty (the
 *          overwhelmingly common case: no pending invite).
 */
export async function redeemPendingInvitesByEmail(input: {
    userId: string;
    userEmail: string;
}): Promise<RedeemResult[]> {
    const normalizedEmail = input.userEmail.toLowerCase().trim();
    if (!normalizedEmail) return [];

    const pending = await prisma.tenantInvite.findMany({
        where: {
            email: normalizedEmail,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        select: {
            id: true,
            tenantId: true,
            role: true,
            invitedById: true,
        },
        // Bounded: an address realistically has a handful of pending
        // invites. The cap stops a pathological fan-out turning one
        // sign-in into an unbounded write loop.
        take: 50,
    });

    const redeemed: RedeemResult[] = [];
    for (const invite of pending) {
        // Atomic claim by id. A racing token-URL redemption of the same
        // invite makes this count=0, and we skip rather than double-write.
        const claim = await prisma.tenantInvite.updateMany({
            where: {
                id: invite.id,
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
            data: { acceptedAt: new Date() },
        });
        if (claim.count !== 1) continue;

        redeemed.push(await finalizeInviteRedemption(invite, input.userId));
    }

    return redeemed;
}

/**
 * Materialise an AUTHORISED invite grant: upsert the membership, read
 * the slug for the redirect, and append the audit entry.
 *
 * Shared by both redemption entry points:
 *   - {@link redeemInvite} — token-bound, from the /invite/:token flow;
 *   - {@link redeemPendingInvitesByEmail} — verified-email-bound, at sign-in.
 *
 * The CALLER owns the atomic claim and any binding check. By the time
 * we are here the grant is authorised; this only writes it down.
 *
 * The membership upsert + slug lookup share one `$transaction`; the
 * audit call runs AFTER it commits, because appendAuditEntry opens its
 * own advisory-locked transaction and must not nest.
 */
async function finalizeInviteRedemption(
    invite: {
        tenantId: string;
        role: Role;
        invitedById: string | null;
    },
    userId: string,
): Promise<RedeemResult> {
    const txResult = await prisma.$transaction(async (tx) => {
        const membership = await tx.tenantMembership.upsert({
            where: {
                tenantId_userId: {
                    tenantId: invite.tenantId,
                    userId,
                },
            },
            create: {
                tenantId: invite.tenantId,
                userId,
                role: invite.role,
                status: 'ACTIVE',
                invitedByUserId: invite.invitedById,
                invitedAt: new Date(),
            },
            update: {
                role: invite.role,
                status: 'ACTIVE',
                deactivatedAt: null,
                invitedByUserId: invite.invitedById,
                invitedAt: new Date(),
            },
        });

        const tenant = await tx.tenant.findUnique({
            where: { id: invite.tenantId },
            select: { slug: true },
        });
        if (!tenant) throw internal('Invariant: tenant disappeared mid-redemption');

        return {
            membershipId: membership.id,
            tenantId: invite.tenantId,
            userId,
            role: invite.role as Role,
            slug: tenant.slug,
        };
    });

    // ── Post-commit audit ─────────────────────────────────────────────
    // appendAuditEntry opens its own advisory-locked $transaction, so
    // it MUST be called outside the parent $transaction.
    await appendAuditEntry({
        tenantId: txResult.tenantId,
        userId: txResult.userId,
        actorType: 'USER',
        entity: 'TenantMembership',
        entityId: txResult.membershipId,
        action: 'MEMBER_INVITE_ACCEPTED',
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'TenantMembership',
            operation: 'created',
            after: { status: 'ACTIVE', role: txResult.role },
            summary: `Accepted invite as ${txResult.role}`,
        },
    });

    return {
        tenantId: txResult.tenantId,
        slug: txResult.slug,
        role: txResult.role,
    };
}
