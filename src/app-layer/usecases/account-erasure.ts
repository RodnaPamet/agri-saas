/**
 * Delete an account by pseudonymisation (P5.6b, #1597).
 *
 * ## The basis is Art 17(3)(b), and it decides what survives
 *
 * Owner ruling 2026-10-11: legal obligation. The DSA audit trail survives, so
 * `ContentReport.reporterUserId` keeps pointing at this `User` row and the row
 * itself is NOT deleted — only emptied of identifying content. A moderation
 * history stays answerable and repeat-abuse detection survives a
 * re-registration, and **erasure is therefore incomplete**, which the privacy
 * notice says in those words.
 *
 * ## Why the row survives rather than being deleted
 *
 * P5.1's four trust & safety tables carry no foreign key to `User`, precisely
 * so this stayed open: an FK would have forced an `onDelete`, and `Cascade`
 * would have destroyed the moderation record of a resolved case. So nothing
 * cascades, and the erasure is an UPDATE across enumerated columns — which is
 * why there is a registry and why a guard derives it from the DMMF.
 *
 * ## It works AROUND the hash chains, never through them
 *
 * `OrgAuditLog` and `PlatformAuditLog` are `RETAIN_ONLY`. Rewriting a row
 * inside a hash chain breaks verification for every entry after it, and
 * `platform_audit_log_immutable` would refuse the UPDATE anyway. #1597's real
 * exit criterion is that the chain still verifies AFTER an erasure, so the test
 * runs the verifier rather than checking the job returned.
 *
 * ## The pseudonym is per-user and random, and the mapping is kept nowhere
 *
 * Not a shared `deleted-user` sentinel, because `ExchangeThread` carries
 * `@@unique([listingId, inquirerUserId])` — two deleted people who both
 * enquired on one listing would collide. Random per erasure, stored nowhere, so
 * the overwritten rows are anonymised rather than merely pseudonymised; the
 * person stays identifiable only through the `RETAIN` columns, by design.
 *
 * ## Every erasable person column is REQUIRED, so NULL is not available
 *
 * Measured against the schema text: all thirteen are `String` with no `?`. A
 * DMMF probe reported them all nullable, which was wrong — Prisma 7 no longer
 * emits `isRequired`, so the property read as `undefined` for every field and
 * the probe returned the same answer whatever it was asked. Hence the two real
 * actions, `DELETE_ROW` and `PSEUDONYMISE_COLUMN`, and a registry that says
 * which applies where.
 */
import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { invalidateDeletionPendingCache } from '@/lib/auth/deletion-pending';
import { logger } from '@/lib/observability/logger';
import { PERSONAL_DATA_REGISTRY } from '@/lib/privacy/personal-data-registry';
import type { DeletionInitiator } from '@prisma/client';
import { codedForbidden } from '@/lib/errors/types';

/** How long a person has to change their mind. Owner ruling: 30 days. */
export const DELETION_GRACE_DAYS = 30;

/** The columns that decide whether a pending erasure is the subject's to stop. */
export interface ErasureCancellability {
    readonly deletionRequestedAt: Date | null;
    readonly deletionRequestedBy: DeletionInitiator | null;
    readonly terminatedAt: Date | null;
    readonly pseudonymisedAt: Date | null;
}

/**
 * May THIS person stop the erasure pending on their own account?
 *
 * ## Why this is a function and not two spellings of a condition
 *
 * Two places need the answer and they must never disagree:
 *
 * - {@link cancelAccountDeletion}, which enforces it;
 * - `GET /api/auth/me`, which decides whether its 403 carries `erasesAt` —
 *   and `erasesAt` is what the phone turns into a «stop the deletion» button.
 *
 * When they disagree in the direction of the route being more generous, the
 * person is shown a date and a control, and the server then refuses: the
 * offer-then-refuse shape that #1671, #1667 and this predicate have each been
 * about in turn. It has now been reintroduced twice by adding a refusal signal
 * to the usecase and not to the route — first the initiator, then
 * `terminatedAt` — which is the argument for one callable rule rather than a
 * comment asking the next person to remember. Found by agrent-ios, on a PR
 * whose checks were green.
 *
 * ## The signals, and why each is separately necessary
 *
 * - `pseudonymisedAt` — past the point of no return; there is nothing left.
 * - `deletionRequestedAt` — nothing pending, so nothing to stop.
 * - `terminatedAt` — moderation finalised this account (#1654). Holds in the
 *   case the initiator misses: a person may ask to leave and be terminated
 *   afterwards, and `requestAccountDeletionOnTx` early-returns on an existing
 *   request without writing the initiator, so the row stays `SELF`.
 * - `deletionRequestedBy === 'MODERATION'` — whose erasure this is, which
 *   `liftSuspension` also reads to decide whether a reinstatement clears the
 *   erasure or leaves the person's own request standing.
 *
 * A NULL initiator reads as SELF: every row predating #1671 is a self-service
 * request, since termination→erasure only shipped in #1654.
 */
export function subjectMayCancelErasure(user: ErasureCancellability): boolean {
    if (user.pseudonymisedAt !== null) return false;
    if (user.deletionRequestedAt === null) return false;
    return user.terminatedAt === null && user.deletionRequestedBy !== 'MODERATION';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A transaction-capable client, so a caller already inside a transaction does
 * not make this reach for a second pool connection (#1191's P0.8 shape).
 */
type TxClient = Prisma.TransactionClient;

export interface ErasureOutcome {
    readonly userId: string;
    /** False when the row was already pseudonymised, or does not exist. */
    readonly applied: boolean;
    /** Rows deleted, per model. */
    readonly deleted: Readonly<Record<string, number>>;
    /** Rows whose person column was overwritten, per model. */
    readonly pseudonymised: Readonly<Record<string, number>>;
    /**
     * Models the erasure could NOT complete, with the reason.
     *
     * Not an error: the last-OWNER trigger legitimately refuses to leave an
     * organisation ownerless, and the right answer is to record that the
     * membership survived rather than to abandon the whole erasure. The `User`
     * row is emptied regardless, so a surviving membership names an anonymous
     * row.
     */
    readonly blocked: Readonly<Record<string, string>>;
}

/**
 * The Prisma delegate for a model name.
 *
 * A narrow cast at one place rather than thirteen typed branches. The registry
 * guard proves every name here resolves, because it derives them from the DMMF
 * — so a name that did not exist would fail that guard rather than throw here.
 */
type Delegate = {
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
};

function delegateFor(tx: unknown, model: string): Delegate {
    const key = model.charAt(0).toLowerCase() + model.slice(1);
    return (tx as Record<string, Delegate>)[key];
}

/**
 * Erase one account.
 *
 * Idempotent: a row already carrying `pseudonymisedAt` is left alone, so a
 * second sweep cannot overwrite an anonymised row with a second pseudonym and
 * make the audit unreadable.
 */
export async function eraseAccount(userId: string): Promise<ErasureOutcome> {
    const deleted: Record<string, number> = {};
    const pseudonymised: Record<string, number> = {};
    const blocked: Record<string, string> = {};

    // Generated here and stored NOWHERE. This is the only place the mapping
    // from person to pseudonym exists, and it ceases to exist when this
    // function returns.
    const pseudonym = `erased-${randomUUID()}`;

    const applied = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
            where: { id: userId },
            select: { id: true, pseudonymisedAt: true },
        });
        if (!existing || existing.pseudonymisedAt) return false;

        for (const entry of PERSONAL_DATA_REGISTRY) {
            if (!entry.action) continue;  // RETAIN — see the docblock.

            const delegate = delegateFor(tx, entry.model);

            // A model may name a person in more than one column —
            // `UserBlock` has blocker and blocked, `ExchangeBlock` has blocked
            // and creator. Each is handled, because classifying the model while
            // missing a column is the failure the registry guard catches one
            // level up.
            for (const column of entry.columns) {
                try {
                    if (entry.action === 'DELETE_ROW') {
                        const r = await delegate.deleteMany({ where: { [column]: userId } });
                        deleted[entry.model] = (deleted[entry.model] ?? 0) + r.count;
                    } else {
                        const r = await delegate.updateMany({
                            where: { [column]: userId },
                            data: { [column]: pseudonym },
                        });
                        pseudonymised[entry.model] =
                            (pseudonymised[entry.model] ?? 0) + r.count;
                    }
                } catch (err) {
                    // The last-OWNER trigger raises P0001 rather than letting
                    // an organisation be left ownerless. Recording that the
                    // row survived is the right answer — abandoning the whole
                    // erasure over one membership would leave the person's
                    // name everywhere else.
                    //
                    // NOTE this is inside the transaction, so a Postgres error
                    // has already aborted it unless the statement was the only
                    // failure. Postgres has no savepoint here, which is why
                    // the sweep treats a blocked erasure as a retry rather
                    // than a partial success — see `runAccountErasureSweep`.
                    blocked[`${entry.model}.${column}`] =
                        err instanceof Error ? err.message : String(err);
                    throw err;
                }
            }
        }

        // The identifying content, emptied. The ROW stays.
        //
        // `email` takes a tombstone at an unroutable domain, and writing it is
        // ALSO what clears the lookup hash — `src/lib/security/pii-middleware.ts`
        // derives `data.emailHash = hashForLookup(data.email)` on every write
        // that sets `email`. So the stored hash becomes a hash of the
        // tombstone, the ORIGINAL address matches nothing, and the person can
        // register again.
        //
        // An explicit `emailHash: null` here would be dead code: the
        // middleware overrides it. I wrote one, and the test that caught it is
        // the one asserting the hash is gone — it received a hash of the
        // tombstone instead of null, which is the right OUTCOME by a mechanism
        // I had wrong.
        await tx.user.update({
            where: { id: userId },
            data: {
                email: `${pseudonym}@erased.invalid`,
                name: null,
                deletionRequestedAt: null,
                pseudonymisedAt: new Date(),
                // Any live credential is already gone with `Account` and
                // `AuthSession` above; the bump ends anything mid-flight.
                sessionVersion: { increment: 1 },
            },
        });

        return true;
    });

    logger.info('account-erasure.completed', {
        component: 'account-erasure',
        userId,
        applied,
        // Counts only, never content.
        deleted,
        pseudonymised,
        blockedCount: Object.keys(blocked).length,
    });

    return { userId, applied, deleted, pseudonymised, blocked };
}

/**
 * Accounts whose grace period has run out.
 *
 * `pseudonymisedAt IS NULL` is half the predicate, so a completed erasure is
 * simply not selected again — the same "the queue IS the absence of a marker"
 * shape as `statement-dispatch` and `notice-score`.
 */
export async function findAccountsDueForErasure(limit: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - DELETION_GRACE_DAYS * DAY_MS);
    const rows = await prisma.user.findMany({
        where: {
            deletionRequestedAt: { lt: cutoff, not: null },
            pseudonymisedAt: null,
        },
        // Oldest request first: somebody who asked a month ago has waited
        // longest for an answer.
        orderBy: { deletionRequestedAt: 'asc' },
        take: limit,
        select: { id: true },
    });
    return rows.map((r) => r.id);
}

export interface DeletionRequestResult {
    readonly applied: boolean;
    readonly alreadyRequested: boolean;
    /** When the erasure will run, so the UI can say it. */
    readonly erasesAt: string | null;
    readonly sessionsRevoked: number;
    /**
     * How many ACTIVE listings were withheld from other farms (#1655).
     *
     * Reported rather than inferred: the privacy notice promises the account
     * stops being visible, and a request that suppressed zero listings when
     * the person had some is the failure worth seeing in a log. Zero is also
     * the correct answer for somebody who sells nothing.
     */
    readonly listingsSuppressed: number;
}

/**
 * Ask for deletion: the FREEZE.
 *
 * Owner ruling — frozen but recoverable, over a visible grace period. A person
 * who asked to be deleted stops appearing to other farms immediately rather
 * than keeping on showing up in live negotiations for a month; the 30 days
 * protects them from an impulse or a compromised account, not the other way
 * round.
 *
 * Sessions are revoked here, which is also what makes recovery coherent: the
 * person has to sign in again, and signing in is where they are offered the
 * cancellation. `sessionVersion` is bumped and the live `UserSession` rows are
 * stamped, exactly as P5.9's suspension does — the two share the mechanism
 * while deliberately not sharing the column.
 */
/**
 * The freeze, on a caller-supplied transaction.
 *
 * Exists for `actOnNotice`, which is deliberately ONE transaction: calling the
 * wrapper below from inside it would reach for a second pool connection, which
 * is the #1191 P0.8 deadlock shape. Same split as `suspendAccountOnTx`.
 */
/**
 * Withhold the person's listings from other farms, restorably (#1655).
 *
 * ## This is what makes the privacy notice true
 *
 * `privacy.deleteRequest` tells people, in both locales, that their account
 * "stops being visible to other farms straight away". Until this landed that
 * sentence was false: the request wrote `deletionRequestedAt`, bumped
 * `sessionVersion` and revoked sessions, and nothing read the column outside
 * the erasure path — so ACTIVE listings stayed in the marketplace and inbound
 * inquiries kept arriving for the full 30 days.
 *
 * ## `status: 'ACTIVE'` in the WHERE is the whole correctness argument
 *
 * The restore clears every row this column marks, so the suppression must mark
 * ONLY rows it is responsible for hiding. A listing the seller had already
 * WITHDRAWN themselves, or one FULFILLED or EXPIRED, is left alone — otherwise
 * cancelling would resurrect listings the person had deliberately taken down,
 * which is a worse outcome than the bug this fixes. That asymmetry is where I
 * expect a future refactor to break, so it is asserted directly.
 *
 * Idempotent via `suppressedForDeletionAt: null`: asking twice does not restamp,
 * matching `deletionRequestedAt`'s own rule that a second request must not
 * restart the clock.
 */
async function suppressListingsForDeletion(
    tx: TxClient,
    userId: string,
    now: Date,
): Promise<number> {
    const r = await tx.exchangeListing.updateMany({
        where: { sellerUserId: userId, status: 'ACTIVE', suppressedForDeletionAt: null },
        data: { suppressedForDeletionAt: now },
    });
    return r.count;
}

/**
 * Put them back, exactly (#1655).
 *
 * Keyed on the column rather than on `status`, so it restores precisely the set
 * `suppressListingsForDeletion` hid and nothing else. Setting every one of the
 * person's listings ACTIVE would be the obvious-looking implementation and is
 * the bug described above.
 *
 * The rows come back with their original `status` because suppression never
 * touched it — which is the reason the hiding is a separate column and not a
 * fifth `ExchangeListingStatus` value.
 */
async function restoreListingsAfterCancel(tx: TxClient, userId: string): Promise<number> {
    const r = await tx.exchangeListing.updateMany({
        where: { sellerUserId: userId, suppressedForDeletionAt: { not: null } },
        data: { suppressedForDeletionAt: null },
    });
    return r.count;
}

export async function requestAccountDeletionOnTx(
    tx: TxClient,
    userId: string,
    /**
     * WHO asked. REQUIRED — no default, deliberately (#1671).
     *
     * A default would make the distinction optional at the very call site that
     * has to get it right, and the failure is silent: a termination recorded
     * as `SELF` becomes cancellable by its subject, which is the defect this
     * column exists to close. TypeScript refusing the call is the cheapest
     * possible reminder.
     */
    initiator: DeletionInitiator,
): Promise<DeletionRequestResult> {
    const existing = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, deletionRequestedAt: true, pseudonymisedAt: true },
    });
    if (!existing || existing.pseudonymisedAt) {
        return {
            applied: false, alreadyRequested: false, erasesAt: null,
            sessionsRevoked: 0, listingsSuppressed: 0,
        };
    }
    if (existing.deletionRequestedAt) {
        return {
            applied: true,
            alreadyRequested: true,
            erasesAt: new Date(
                existing.deletionRequestedAt.getTime() + DELETION_GRACE_DAYS * DAY_MS,
            ).toISOString(),
            sessionsRevoked: 0,
            listingsSuppressed: 0,
        };
    }

    const now = new Date();
    await tx.user.update({
        where: { id: userId },
        data: {
            deletionRequestedAt: now,
            deletionRequestedBy: initiator,
            sessionVersion: { increment: 1 },
        },
    });
    const revoked = await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
    });
    // In the SAME transaction as the request, so a rolled-back request cannot
    // leave listings hidden with nothing recording why.
    const listingsSuppressed = await suppressListingsForDeletion(tx, userId, now);

    return {
        applied: true,
        alreadyRequested: false,
        erasesAt: new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS).toISOString(),
        sessionsRevoked: revoked.count,
        listingsSuppressed,
    };
}

export async function requestAccountDeletion(userId: string): Promise<DeletionRequestResult> {
    // DELEGATES rather than repeating the body, and that is a fix as much as a
    // tidy-up. This function was a near-verbatim copy of
    // `requestAccountDeletionOnTx` differing only in opening the transaction,
    // so #1655's listing suppression would have landed in one path and not the
    // other — a moderator-driven termination freezing listings while a
    // self-service request did not, or the reverse. "Two spellings of one
    // policy" is how this repo has repeatedly ended up with a control enforced
    // on one path only.
    // SELF: this is the self-service route. The moderator path is
    // `actOnNotice`, which passes MODERATION (#1671).
    const result = await prisma.$transaction((tx) =>
        requestAccountDeletionOnTx(tx, userId, 'SELF'),
    );

    // AFTER the commit and DIRECTLY awaited, not through `afterCommit`.
    // `afterCommit` only defers when a scope is open, and a scope is opened by
    // the `db-context.ts` helpers rather than by a bare `prisma.$transaction` —
    // which is what this uses. #1619 shipped that mistake and the effect fired
    // un-awaited; the measured symptom there was zero rows written.
    if (result.applied && !result.alreadyRequested) {
        await invalidateDeletionPendingCache(userId);
    }
    return result;
}

/**
 * Change your mind.
 *
 * Clears the freeze. Does NOT restore the revoked sessions — reinstatement
 * returns the ability to sign in, not credentials that may since have been
 * shared, which is the same one-way rule `liftSuspension` follows.
 *
 * ## A MODERATION-initiated erasure is refused here, not at the route
 *
 * Termination finalises (owner ruling on #1654), so its subject may not undo
 * it. That is a property of the erasure rather than of one HTTP surface, so
 * the rule lives in the usecase and any future caller inherits it — a second
 * cancel path deciding this for itself is how a control ends up enforced on
 * one route only, which this repo has paid for repeatedly.
 *
 * It refuses on the INITIATOR, not on `suspendedAt`. Until #1671 the only
 * thing stopping a self-undo was the cancel route refusing a suspended
 * account, which is a side effect of a different control rather than a
 * property of this one — and #1667 removed that control with every required
 * check green, because nothing asserted the protection directly.
 *
 * A distinct code, not `ACCOUNT_SUSPENDED`: that one invites an appeal, and an
 * appeal would not restore anything here.
 */
export async function cancelAccountDeletion(
    userId: string,
): Promise<{ applied: boolean; wasRequested: boolean; listingsRestored?: number }> {
    const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                deletionRequestedAt: true,
                deletionRequestedBy: true,
                terminatedAt: true,
                pseudonymisedAt: true,
            },
        });
        // Past the point of no return: there is nothing left to cancel, and
        // saying so is better than pretending it worked.
        if (!existing || existing.pseudonymisedAt) {
            return { applied: false, wasRequested: false };
        }
        if (!existing.deletionRequestedAt) return { applied: true, wasRequested: false };

        // TWO signals, and neither is alone load-bearing.
        //
        // `terminatedAt` is the one that holds in the case the other misses: a
        // person may ask to leave and be terminated afterwards, and
        // `requestAccountDeletionOnTx` early-returns on an existing request
        // without writing the initiator — so the row stays `SELF` and this
        // cancel would have been allowed, leaving the account terminated,
        // suspended and with no erasure at all. Found by agrent-ios.
        //
        // The initiator check stays because it answers a different question —
        // whose erasure this is — and `liftSuspension` reads it to decide
        // whether a reinstatement clears the erasure or leaves the person's own
        // request standing.
        //
        // A NULL initiator reads as SELF: every row predating #1671 is a
        // self-service request.
        //
        // Routed through the shared predicate rather than spelled again here.
        // The two early returns above have already excluded its other two
        // signals, so at this point `!subjectMayCancelErasure` is exactly the
        // condition this used to test inline — and `/api/auth/me` now reads the
        // same function, so a third signal cannot reach one and miss the other.
        if (!subjectMayCancelErasure(existing)) {
            throw codedForbidden('ACCOUNT_TERMINATED', 'ACCOUNT_TERMINATED');
        }

        await tx.user.update({ where: { id: userId }, data: { deletionRequestedAt: null } });
        const listingsRestored = await restoreListingsAfterCancel(tx, userId);
        return { applied: true, wasRequested: true, listingsRestored };
    });

    // AFTER the commit, directly awaited — see `requestAccountDeletion` for why
    // this is not `afterCommit`. This is the edge where a lost invalidation is
    // least forgivable: the person has just recovered their account and would
    // otherwise stay frozen for the remainder of the TTL while watching.
    if (result.wasRequested) {
        await invalidateDeletionPendingCache(userId);
    }
    return result;
}
