/**
 * Delete accounts that never verified their email (P3.5e).
 *
 * Registration v2 creates a user before the email is proven, so an abandoned
 * or hostile signup leaves a row holding an address and a name for an account
 * nobody confirmed. Keeping those forever is both junk and personal data we
 * were never given permission to retain, so after a grace period they go.
 *
 * ── this job is DESTRUCTIVE, and one interaction makes it dangerous ──
 *
 * The obvious predicate — `emailVerified IS NULL AND createdAt < cutoff` — is
 * WRONG, and would have deleted live farms.
 *
 * The legacy `/api/auth/register` (retired by #1376; `login/page.tsx` now links
 * to the `/start` wizard instead)
 * creates a tenant, a user whose email is unverified, an OWNER membership and
 * an onboarding row, all in one transaction. So every farm registered through
 * the legacy route whose owner never clicked the verification link is an
 * unverified user older than seven days WITH a real workspace. Sweeping on the
 * obvious predicate would delete the person, and
 * `tenant_membership_last_owner_guard` would not save the tenant — it fires on
 * UPDATE/DELETE of a membership that would drop a tenant to zero owners, and
 * the membership here disappears by CASCADE from the user, not by a statement
 * it can see.
 *
 * So membership is part of the predicate, not an afterthought: a user with any
 * `TenantMembership` or `OrgMembership` is NEVER swept, whatever their
 * verification state. An unverified user with a farm is a legacy-route signup
 * to be chased, not deleted.
 *
 * `skippedWithMembership` is returned rather than silently filtered, because
 * that number IS the legacy-route backlog and it should be visible shrinking
 * to zero as P3.8 lands.
 *
 * ── what deleting a user actually does ──
 *
 * Checked rather than assumed, because `User` has 13 cascading relations:
 *
 *   * `AuditLog.userId` is `ON DELETE SET NULL` (verified in
 *     `20260308190244_init`). The audit rows SURVIVE with attribution nulled,
 *     so the hash chain stays intact — a cascade there would have broken it.
 *   * The cascading children (sessions, notifications, push subscriptions,
 *     password-reset tokens) all belong to the deleted identity and go with
 *     it, which is the intent.
 *   * `EmailVerificationCode` has no FK — it is keyed on `emailHash` — so it
 *     does not cascade. Its own expiry sweep collects it; a 15-minute TTL
 *     means nothing survives seven days anyway.
 *
 * Batched, so one run cannot hold a long transaction, and the deleted count is
 * asserted against the selected ids rather than trusted: a `deleteMany` that
 * removes fewer rows than it selected is a signal, not a rounding error.
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/observability/logger';

/**
 * Days an unverified account is kept.
 *
 * Seven, matching the roadmap. Long enough to cover a holiday and a spam
 * folder; short enough that abandoned signups do not accumulate. It is also
 * far longer than the 15-minute code TTL, so anyone swept has had many
 * chances to request a fresh code.
 */
export const UNVERIFIED_GRACE_DAYS = 7;

/** Accounts examined per run. Bounded so one sweep cannot run long. */
const DEFAULT_BATCH = 500;

export interface UnverifiedAccountSweepOptions {
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /** Cap on accounts deleted this run. */
    batchSize?: number;
    /** Override the grace period — test-only seam. */
    graceDays?: number;
}

export interface UnverifiedAccountSweepResult {
    /** Unverified accounts past the grace period, before the membership filter. */
    scanned: number;
    /** Accounts actually deleted. */
    deleted: number;
    /**
     * Unverified accounts past the grace period that were SPARED because they
     * hold a farm or org membership.
     *
     * Not a filtered-out detail: this is the legacy-route backlog, and it is
     * surfaced so an operator can watch it shrink to zero rather than discover
     * it by wondering why the deleted count is lower than expected.
     */
    skippedWithMembership: number;
}

export async function runUnverifiedAccountSweep(
    db: PrismaClient,
    options: UnverifiedAccountSweepOptions = {},
): Promise<UnverifiedAccountSweepResult> {
    const now = options.now ?? new Date();
    const batchSize = options.batchSize ?? DEFAULT_BATCH;
    const graceDays = options.graceDays ?? UNVERIFIED_GRACE_DAYS;
    const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

    // Selected in two steps rather than one `deleteMany`, deliberately. A
    // single delete with a `none` relation filter would be shorter, but it
    // would report only a count — and this job needs to distinguish "nothing
    // to sweep" from "everything was spared by the membership filter", which
    // are the same number of deletions and completely different situations.
    const candidates = await db.user.findMany({
        where: { emailVerified: null, createdAt: { lt: cutoff } },
        select: {
            id: true,
            _count: { select: { tenantMemberships: true, orgMemberships: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
    });

    const spared = candidates.filter(
        (u) => u._count.tenantMemberships > 0 || u._count.orgMemberships > 0,
    );
    const deletable = candidates.filter(
        (u) => u._count.tenantMemberships === 0 && u._count.orgMemberships === 0,
    );

    let deleted = 0;
    if (deletable.length > 0) {
        // The membership predicate is restated HERE, on the delete itself, and
        // not only in the selection above. Between the read and the write a
        // user can be invited to a farm, and a sweep that deleted them on the
        // strength of a stale read would remove a member of a live workspace.
        // The condition costs nothing and closes the window.
        const { count } = await db.user.deleteMany({
            where: {
                id: { in: deletable.map((u) => u.id) },
                emailVerified: null,
                tenantMemberships: { none: {} },
                orgMemberships: { none: {} },
            },
        });
        deleted = count;

        if (count !== deletable.length) {
            // Not an error: the gap is exactly the race the predicate above
            // exists to lose safely. Logged because a persistent gap means
            // something is handing memberships to unverified accounts, which
            // would be worth knowing.
            logger.info('unverified-account-sweep.fewer_deleted_than_selected', {
                component: 'jobs',
                event: 'unverified_sweep_race',
                selected: deletable.length,
                deleted: count,
            });
        }
    }

    logger.info('unverified-account-sweep.done', {
        component: 'jobs',
        event: 'unverified_account_sweep',
        // Counts only. The whole point of the job is that these addresses are
        // unconfirmed personal data, so none of them reaches the log.
        scanned: candidates.length,
        deleted,
        skippedWithMembership: spared.length,
        graceDays,
        cutoff: cutoff.toISOString(),
    });

    return {
        scanned: candidates.length,
        deleted,
        skippedWithMembership: spared.length,
    };
}
