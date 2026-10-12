/**
 * Suspend or reinstate an account, from the PLATFORM (P5.9, #1600).
 *
 * ## Why this cannot reuse `revokeUserSessions`
 *
 * DECISION 2 on #1600, and it is structural rather than a preference.
 * `session-security.ts`'s revocation is tenant-scoped by construction: it reads
 * `ctx.permissions.canAdmin` and then requires a `TenantMembership` for
 * `(ctx.tenantId, targetUserId)`, throwing `notFound` without one. A platform
 * moderator has no `ctx.tenantId`, and the person being suspended may belong to
 * several farms or to none at all — a tenantless account is precisely the case
 * an abuse suspension is most likely to hit.
 *
 * So this is a second entry point, deliberately, and the thing that makes that
 * safe is that it is reachable only from a `verifyPlatformApiKey` surface.
 *
 * ## Three writes, one transaction, and the order matters
 *
 * 1. `User.suspendedAt` — the state the per-request check reads.
 * 2. `User.sessionVersion` incremented — which makes the EXISTING throttled
 *    check revoke the session too, within its 5-minute window. Belt and
 *    braces: if the fast path were ever bypassed, the slow path still ends the
 *    session.
 * 3. `UserSession.revokedAt` stamped on every live row — so the operational
 *    session list shows them gone rather than merely stale, and the
 *    `/admin/members` view agrees with reality.
 *
 * All three in ONE transaction because the partial states are each worse than
 * either end: a `suspendedAt` with a live session relies entirely on the fast
 * path, and a bumped `sessionVersion` with no `suspendedAt` signs the person out
 * once and lets them straight back in.
 *
 * ## The cache invalidation is OUTSIDE the transaction, and after it
 *
 * Dropping the cached verdict before the commit would let a request in the
 * window re-populate it with the pre-suspension value and pin it for the TTL —
 * the one ordering that makes the cache actively harmful. After the commit the
 * worst case is a request that already read `'0'` finishing its work, which is
 * the single-request window the phase accepts.
 *
 * It does not use `afterCommit`: that helper drains at the OUTERMOST
 * transaction, and this usecase is the outermost one. A direct call after
 * `$transaction` returns is the same moment with less indirection.
 */
import type { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { afterCommit } from '@/lib/db/after-commit';
import { invalidateSuspensionCache } from '@/lib/auth/suspension';
import {
    appendPlatformAuditEntry,
    type PlatformAuditScope,
} from '@/lib/audit/platform-audit-writer';
import { moderatorRefFor } from '@/lib/auth/platform-admin';
import { sanitizePlainText } from '@/lib/security/sanitize';

/** The chain these entries belong to. Added by this phase's migration. */
const SUSPENSION_SCOPE: PlatformAuditScope = 'moderation';

/**
 * A transaction-capable client. The core below takes one so a caller that is
 * ALREADY inside a transaction — `actOnNotice`, which is deliberately one —
 * does not make it reach for a second pool connection. That is the #1191 P0.8
 * deadlock shape: a transaction holding one slot and wanting another cannot
 * make progress once every slot is held that way, and the caller sees Prisma's
 * 5s interactive timeout naming no pool.
 */
type TxClient = Prisma.TransactionClient;

export interface SuspendAccountInput {
    readonly userId: string;
    /**
     * Which key generation authorised it, from `verifyPlatformApiKey`.
     * The same attribution unit `moderatorRef` uses, and the same limit: it
     * names a key, not a person. #1599 (P5.8) owns the credential model that
     * would make it a person.
     */
    readonly generation: 'current' | 'previous';
    /**
     * Free text from the moderator. REQUIRED since #1667.
     *
     * It used to be optional and was DISCARDED: only `hasReason: Boolean(...)`
     * reached `PlatformAuditLog`, under a comment correctly saying the
     * rationale "belongs on `ModerationAction.rationale`" — a comment
     * describing a row this path never created. So a moderator typed a reason
     * and nothing kept it.
     *
     * It is now the `rationale` of a proactive `ModerationAction`, which is
     * encrypted at rest and is what an Art 17 statement is composed from. A
     * decision that withholds a farm from a person is not recordable without
     * one.
     */
    readonly reason: string;
}

export interface SuspendAccountResult {
    /** `false` when no such user exists. The caller decides whether that is a 404. */
    readonly applied: boolean;
    /** Live sessions stamped revoked. Zero is normal — they may not be signed in. */
    readonly sessionsRevoked: number;
    /** Already suspended, so nothing changed. Idempotent, not an error. */
    readonly alreadySuspended: boolean;
}

/**
 * The writes, on a caller-supplied transaction.
 *
 * Post-commit work — the cache invalidation and the chain append — is QUEUED
 * through `afterCommit` rather than run here, which gets both properties the
 * design needs: it happens after the OUTERMOST transaction commits (so a
 * rolled-back moderation decision cannot leave a suspension announced in the
 * audit chain), and dropping the cached verdict after the commit means a
 * concurrent request cannot re-populate it with the pre-suspension value and
 * pin it for the whole TTL.
 */
export async function suspendAccountOnTx(
    tx: TxClient,
    input: SuspendAccountInput,
): Promise<SuspendAccountResult> {
    const existing = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, suspendedAt: true },
    });
    if (!existing) {
        return { applied: false, sessionsRevoked: 0, alreadySuspended: false };
    }
    if (existing.suspendedAt) {
        // Idempotent. Re-suspending must not re-stamp `suspendedAt`: that
        // timestamp is what an appeal and a regulator both date from, and
        // moving it would quietly extend the record.
        return { applied: true, sessionsRevoked: 0, alreadySuspended: true };
    }

    await tx.user.update({
        where: { id: input.userId },
        data: {
            suspendedAt: new Date(),
            // The slow path, kept as a backstop — see the docblock.
            sessionVersion: { increment: 1 },
        },
    });

    const revoked = await tx.userSession.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });

    const result: SuspendAccountResult = {
        applied: true,
        sessionsRevoked: revoked.count,
        alreadySuspended: false,
    };
    queuePostCommit(input, result);
    return result;
}

/** Queue the two post-commit effects. Extracted so both verbs share it. */
function queuePostCommit(input: SuspendAccountInput, result: SuspendAccountResult): void {
    afterCommit('suspension.invalidate-cache', () =>
        invalidateSuspensionCache(input.userId));

    afterCommit('suspension.audit-append', async () => {
        // Best-effort, matching the #1619 ruling for the moderation scope: a
        // chain-writer failure must not undo a suspension that has already
        // taken effect. The gap is reported rather than prevented.
        try {
            await appendPlatformAuditEntry({
                scope: SUSPENSION_SCOPE,
                action: 'ACCOUNT_SUSPENDED',
                actorType: 'PLATFORM_ADMIN',
                // No `actorUserId`: the credential is an API key, so there is
                // no user in scope. Accepting one from the caller would put an
                // unverified name in an attribution field.
                actorUserId: null,
                // `PlatformAuditLog` has no target columns — the subject goes
                // in `detailsJson`, as the feature-flag and key-rotation
                // writers do.
                detailsJson: {
                    targetUserId: input.userId,
                    moderatorRef: `platform-key:${input.generation}`,
                    sessionsRevoked: result.sessionsRevoked,
                    // The reason is NOT recorded here, only whether there was
                    // one. It is moderator free text and `detailsJson` is not
                    // an encrypted column; the rationale belongs on
                    // `ModerationAction.rationale`, which is.
                    hasReason: Boolean(input.reason),
                },
            });
        } catch (err) {
            logger.error('account-suspension.audit_append_failed', {
                component: 'account-suspension',
                targetId: input.userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });

    logger.info('account-suspension.suspended', {
        component: 'account-suspension',
        targetId: input.userId,
        sessionsRevoked: result.sessionsRevoked,
    });
}

/**
 * Suspend an account, opening a transaction.
 *
 * For a caller that is NOT already inside one — the standalone platform route.
 * A caller inside a transaction uses `suspendAccountOnTx` instead.
 */
export async function suspendAccount(
    input: SuspendAccountInput,
): Promise<SuspendAccountResult> {
    return prisma.$transaction(async (tx) => {
        const result = await suspendAccountOnTx(tx, input);

        // The DECISION, in the same transaction as the suspension (#1667).
        //
        // This path created no `ModerationAction` at all. `actOnNotice` always
        // has one — a notice to act on — but a PROACTIVE suspension had
        // nothing recording why it happened: the reason reached
        // `PlatformAuditLog` as a boolean and the text was dropped. The schema
        // anticipated this exactly: `reportId` is nullable *"because a
        // PROACTIVE action has no notice behind it"*.
        //
        // AFTER `suspendAccountOnTx`, and only when it applied: an action row
        // for a user who does not exist would be a decision about nobody, and
        // the idempotent repeat path returns `applied: true` with
        // `alreadySuspended`, which must not mint a second action for one
        // decision.
        //
        // `subjectKind: 'ACCOUNT'` — the subject is a PERSON, not content.
        // `PROFILE` would have made "somebody reported this profile" and "we
        // suspended this account" the same query.
        if (result.applied && !result.alreadySuspended) {
            await tx.moderationAction.create({
                data: {
                    reportId: null,
                    moderatorRef: moderatorRefFor(input.generation),
                    actionKind: 'ACCOUNT_SUSPENDED',
                    subjectKind: 'ACCOUNT',
                    subjectId: input.userId,
                    rationale: sanitizePlainText(input.reason),
                },
            });
        }

        return result;
    });
}

export interface LiftSuspensionResult {
    readonly applied: boolean;
    readonly wasSuspended: boolean;
}

/**
 * Reinstate an account.
 *
 * `sessionVersion` is NOT decremented and the revoked `UserSession` rows are
 * NOT un-revoked: both are one-way. Reinstatement restores the ability to sign
 * in, not the sessions that existed before — un-revoking a session row would
 * resurrect a credential that may since have been shared or captured.
 */
export async function liftSuspension(input: {
    readonly userId: string;
    readonly generation: 'current' | 'previous';
}): Promise<LiftSuspensionResult> {
    const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
            where: { id: input.userId },
            select: { id: true, suspendedAt: true },
        });
        if (!existing) return { applied: false, wasSuspended: false };
        if (!existing.suspendedAt) return { applied: true, wasSuspended: false };

        await tx.user.update({
            where: { id: input.userId },
            data: { suspendedAt: null },
        });
        return { applied: true, wasSuspended: true };
    });

    if (result.applied && result.wasSuspended) {
        // Invalidated FIRST in effect — an appeal upheld is exactly the moment
        // a person should have their account back, and a stale `'1'` would
        // hold them out for the remaining TTL.
        await invalidateSuspensionCache(input.userId);

        try {
            await appendPlatformAuditEntry({
                scope: SUSPENSION_SCOPE,
                action: 'ACCOUNT_SUSPENSION_LIFTED',
                actorType: 'PLATFORM_ADMIN',
                actorUserId: null,
                detailsJson: {
                    targetUserId: input.userId,
                    moderatorRef: `platform-key:${input.generation}`,
                },
            });
        } catch (err) {
            logger.error('account-suspension.audit_append_failed', {
                component: 'account-suspension',
                targetId: input.userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('account-suspension.lifted', {
        component: 'account-suspension',
        targetId: input.userId,
        applied: result.applied,
        wasSuspended: result.wasSuspended,
    });

    return result;
}
