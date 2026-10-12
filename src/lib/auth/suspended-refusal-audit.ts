/**
 * Record that a suspended account's attempt to act was refused (#1656).
 *
 * ## The gap the owner chose to close, and the one they chose to leave
 *
 * #1652's ruling was **refuse, and leave the invite pending**: a suspended
 * person cannot join a second farm, and the invite still works after a lift.
 * That closed the hole and left a state nobody was told about — the inviter
 * sees a pending invite indistinguishable from one never opened.
 *
 * Owner ruling (#1656): record it **for platform admins only**. Not a signal to
 * the inviter, neutral or otherwise. The inviter is not the moderator, has no
 * standing in the suspension, and may be a stranger to it — and "something is
 * wrong with that person's account" is close to what P5.2b decided a social
 * block must never reveal. A platform admin who can suspend can already see
 * suspension state, so an entry in the moderation chain discloses nothing new.
 *
 * So this deliberately does NOT help the inviter. That is the ruling, not an
 * oversight.
 *
 * ## Why it lives in the audit layer rather than at the route
 *
 * The moderation routes are about to move from `/api/admin/moderation/*` to
 * `/api/t/[slug]/admin/moderation/*` behind `assertPlatformSupport`, since
 * #1599's per-moderator credentials were ruled to be real moderator accounts.
 * Usecase and audit-layer code survives that move untouched; route-shaped code
 * does not. Reported by agrent backend-2, which owns that move.
 *
 * ## There is no reader yet, and that is recorded rather than implied
 *
 * `agrent backend-2` measured it: there is **no moderation UI at all**, and
 * `/api/admin/moderation/suspensions` is POST and DELETE only with no GET
 * anywhere — so nobody can currently ask "who is suspended", never mind "whose
 * invite acceptance was refused". The listing is P5.4 remainder (#1595) and
 * theirs.
 *
 * That does not make this premature. The entry is the durable fact and the
 * only part that cannot be reconstructed later: an invite token is consumed or
 * deleted, and a refusal leaves no other trace. A listing is just how somebody
 * reads it.
 *
 * ## What is in the entry, and what is deliberately not
 *
 * The invite is identified by its **id**, resolved from the token through the
 * unique index the redemption path already uses. Not the token itself: a token
 * is a bearer capability to join a farm, and an audit log is immutable, so a
 * leak into it could never be redacted.
 *
 * The field is `invitedToId` — the farm or organisation the invite would have
 * joined — and not `scopeId`, which `tests/unit/scope-guardrails.test.ts` bans
 * repo-wide to stop a removed concept returning. It caught the first draft.
 *
 * Nor a keyed hash of it. `hashForLookup` is HMAC-keyed and gets rehashed on
 * key rotation (`LOOKUP_HASH_REHASHED`), and that sweep covers known columns —
 * a hash buried in a `detailsJson` blob would be outside it, in a log the
 * immutability trigger refuses to update. It would silently stop matching.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { appendPlatformAuditEntry } from '@/lib/audit/platform-audit-writer';
import type { PlatformAuditScope } from '@/lib/audit/platform-audit-writer';

/** Same chain as the suspension and its lifting — see the enum's comment. */
const MODERATION_SCOPE: PlatformAuditScope = 'moderation';

/** Which invite surface the refusal happened on. */
export type InviteSurface = 'TENANT' | 'ORG';

export interface SuspendedRefusalRecord {
    /** What the account was trying to do. One enum value covers all of them. */
    readonly attempted: 'INVITE_ACCEPTANCE';
    readonly surface: InviteSurface;
    /** The invite token, used to resolve an id and never itself recorded. */
    readonly token: string;
}

/**
 * Resolve the invite id without recording the token.
 *
 * Returns `null` for a token that matches nothing — expired invites are still
 * rows, but a revoked-and-deleted or simply bogus token is not, and the
 * refusal is worth recording either way. A null id says "we could not name the
 * invite", which is honest; omitting the entry would lose the attempt.
 */
async function resolveInviteId(
    surface: InviteSurface,
    token: string,
): Promise<{ inviteId: string | null; invitedToId: string | null }> {
    try {
        if (surface === 'TENANT') {
            const row = await prisma.tenantInvite.findUnique({
                where: { token },
                select: { id: true, tenantId: true },
            });
            return { inviteId: row?.id ?? null, invitedToId: row?.tenantId ?? null };
        }
        const row = await prisma.orgInvite.findUnique({
            where: { token },
            select: { id: true, organizationId: true },
        });
        return { inviteId: row?.id ?? null, invitedToId: row?.organizationId ?? null };
    } catch (err) {
        // A failed lookup must not change the ANSWER. The caller is about to
        // refuse; this is bookkeeping beside that refusal.
        logger.warn('suspended-refusal.invite_lookup_failed', {
            component: 'suspended-refusal-audit',
            surface,
            error: err instanceof Error ? err.message : String(err),
        });
        return { inviteId: null, invitedToId: null };
    }
}

/**
 * Append the entry. Never throws.
 *
 * Best-effort for the same reason `suspendAccount`'s own audit append is: a
 * refusal that became a 500 because the chain write failed would turn a
 * correct answer into an incorrect one, and the refusal is the part that
 * protects the farm.
 */
export async function recordSuspendedRefusal(
    userId: string,
    record: SuspendedRefusalRecord,
): Promise<void> {
    try {
        const { inviteId, invitedToId } = await resolveInviteId(record.surface, record.token);
        await appendPlatformAuditEntry({
            scope: MODERATION_SCOPE,
            action: 'SUSPENDED_ACCOUNT_REFUSED',
            actorType: 'PLATFORM_ADMIN',
            // Null for the reason the other moderation entries give: these
            // surfaces authenticate with a key, not a session. The suspended
            // person is the SUBJECT here, not the actor.
            actorUserId: null,
            detailsJson: {
                targetUserId: userId,
                attempted: record.attempted,
                surface: record.surface,
                inviteId,
                invitedToId,
            },
        });
    } catch (err) {
        logger.error('suspended-refusal.audit_append_failed', {
            component: 'suspended-refusal-audit',
            targetId: userId,
            attempted: record.attempted,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
