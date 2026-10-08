/**
 * PAST_DUE grace, and what a tenant loses when it runs out (#1325).
 *
 * Owner-ruled 2026-10-06, refined 2026-10-08. A tenant whose payment has
 * failed keeps everything for **14 days**, then loses a NAMED set of
 * capabilities — not its plan.
 *
 * ## It is a capability list, not a downgrade to FREE
 *
 * #1325 opened as "degrade to FREE after a grace period" and the owner's
 * actual ruling is narrower and different in kind. FREE is a set of COUNT
 * limits (3 users, 5 locations, 5 listings); a tenant pushed onto it would
 * keep browsing the exchange and keep writing journal entries while being
 * told it has too many users — which punishes the wrong thing and would
 * require deciding what happens to the 4th user who already exists.
 *
 * What the owner asked for is a growth freeze with two surfaces hidden. So
 * `plan` is left alone and nothing is deleted, counted or reconciled. The
 * single rule is: **read what you have, add nothing new, and the two market
 * surfaces close.**
 *
 * ## The clock is a COLUMN, not a derivation
 *
 * `pastDueSince` is written by the webhook when the status enters PAST_DUE
 * and cleared when it leaves. `currentPeriodEnd` was the tempting
 * alternative — it needs no migration and for a past_due subscription it IS
 * the moment payment was due — but it is Stripe's field, nullable, and
 * Stripe advances it on events we do not model. A fourteen-day countdown to
 * a user-visible restriction should not depend on inferring intent from
 * somebody else's column.
 *
 * ## There is no sweep, and that is the design
 *
 * #1325 assumed a scheduled job and then named the problem with one: a sweep
 * must not race a `payment_succeeded` that re-activates the account, or a
 * customer who pays on day 6 of the grace is downgraded anyway. Both
 * dissolve if the restriction is COMPUTED at request time instead of
 * written. The webhook clears `pastDueSince`, the predicate stops answering
 * true on the very next request, and there is no job, no idempotency key and
 * no ordering to get wrong. Do not "optimise" this into a cron.
 *
 * ## What is deliberately NOT restricted
 *
 * The owner chose the narrow scope on every one of these:
 *
 *   * **Existing listings stay visible to every other farm**, and inbound
 *     messages keep arriving. The restriction is on the unpaid tenant's own
 *     view. Pulling their listings would break live negotiations with
 *     PAYING buyers — third parties who did nothing wrong — and would need a
 *     suppressed-but-not-withdrawn state to restore them from. Nothing has
 *     to be restored when they pay, which is what makes this safe.
 *   * **Reading** anything: the journal, the map, tasks, the dashboard.
 *   * **The map itself.** Only uploads stop; an operator in a field can
 *     still see their parcels.
 */
import type { BillingStatus } from '@prisma/client';

/**
 * How long a failed payment keeps full access.
 *
 * Anchored to Stripe's own smart-retry window (~2 weeks): shorter means
 * revoking access while Stripe is still trying to collect, which produces
 * support load for cards that would have succeeded on retry.
 */
export const PAST_DUE_GRACE_DAYS = 14;
export const PAST_DUE_GRACE_MS = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The capabilities a tenant loses when the grace expires.
 *
 * Spelled as a union rather than strings at call sites so a typo is a
 * compile error — a mis-spelled capability in a gate would read as
 * "unrestricted" and the gate would silently never fire.
 */
export type RestrictedCapability =
    /** Browsing the exchange, and listing anything on it. Their OWN view. */
    | 'exchange'
    /** The market trends surface. */
    | 'trends'
    /** Creating a task. Existing tasks stay readable and completable. */
    | 'task.create'
    /** Any upload. The map stays; new imagery and documents do not. */
    | 'upload'
    /** Writing a journal entry. The journal stays readable. */
    | 'journal.create';

export const RESTRICTED_CAPABILITIES: readonly RestrictedCapability[] = [
    'exchange',
    'trends',
    'task.create',
    'upload',
    'journal.create',
] as const;

/** The minimum a caller has to read to decide. */
export interface PastDueFacts {
    status: BillingStatus;
    pastDueSince: Date | null;
}

export interface PastDueState {
    /** True once the grace has expired and the capabilities below are gone. */
    restricted: boolean;
    /** True while PAST_DUE but still inside the grace — warn, do not block. */
    inGrace: boolean;
    /** When the grace ends. Null when not PAST_DUE. */
    graceEndsAt: Date | null;
    /** Whole days left, floored at 0. Null when not PAST_DUE. */
    daysRemaining: number | null;
}

const NOT_PAST_DUE: PastDueState = {
    restricted: false,
    inGrace: false,
    graceEndsAt: null,
    daysRemaining: null,
};

/**
 * Resolve the state from the two columns.
 *
 * Pure and synchronous on purpose: every gate and every page banner has to
 * agree, and the only way to be sure of that is for there to be one function
 * and no second arithmetic anywhere.
 *
 * **A PAST_DUE account with a NULL `pastDueSince` is treated as in-grace,
 * never as restricted.** That is the state of every account that was already
 * PAST_DUE when this shipped, and of any row the webhook touched before the
 * column existed. Reading a null clock as "the grace expired long ago" would
 * restrict those tenants the moment this deploys, with no warning and no
 * fourteen days — the exact opposite of the ruling.
 */
export function resolvePastDueState(
    facts: PastDueFacts | null,
    now: Date = new Date(),
): PastDueState {
    if (!facts || facts.status !== 'PAST_DUE') return NOT_PAST_DUE;

    if (facts.pastDueSince === null) {
        return { restricted: false, inGrace: true, graceEndsAt: null, daysRemaining: null };
    }

    const graceEndsAt = new Date(facts.pastDueSince.getTime() + PAST_DUE_GRACE_MS);
    const msLeft = graceEndsAt.getTime() - now.getTime();
    return {
        restricted: msLeft <= 0,
        inGrace: msLeft > 0,
        graceEndsAt,
        daysRemaining: Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000))),
    };
}

/** Whether this specific capability is currently withheld. */
export function isCapabilityRestricted(
    facts: PastDueFacts | null,
    capability: RestrictedCapability,
    now: Date = new Date(),
): boolean {
    // Every listed capability falls together — the ruling is one deadline,
    // not a staggered ladder. The parameter exists so a call site names what
    // it is gating (which is what the error message and the guard population
    // are built from), not because the answers differ.
    return RESTRICTED_CAPABILITIES.includes(capability) && resolvePastDueState(facts, now).restricted;
}

// ─── Writing the clock ──────────────────────────────────────────────

/**
 * Build the `{ status, pastDueSince }` pair for a status write.
 *
 * Every site in `src/lib/stripe.ts` that writes `status` must spread this
 * instead of writing `status` alone, so the clock cannot be updated
 * independently of the status it measures. Four separate sites each
 * remembering to maintain a second column is #1403's shape exactly: a rename
 * that stopped at one body while three callers kept compiling.
 *
 * ## The case this exists for: a retry must NOT restart the clock
 *
 * Stripe fires `invoice.payment_failed` on EVERY smart retry, not once. A
 * site writing `pastDueSince: new Date()` on each failure would push the
 * deadline out roughly four times across the retry window, and the
 * restriction would never trigger — a fourteen-day grace that silently lasts
 * for ever, with every test that checks "entering PAST_DUE sets the clock"
 * still passing. So an account ALREADY past due keeps its original
 * timestamp, and that is the arm worth reading twice.
 */
export function pastDueStatusPatch(
    previousStatus: BillingStatus,
    nextStatus: BillingStatus,
    existingPastDueSince: Date | null,
    now: Date = new Date(),
): { status: BillingStatus; pastDueSince: Date | null } {
    if (nextStatus !== 'PAST_DUE') {
        // Leaving (or never in) PAST_DUE clears the clock. This is what makes
        // a sweep unnecessary: a `payment_succeeded` nulls the column and the
        // predicate stops answering true on the next request, with no job to
        // race.
        return { status: nextStatus, pastDueSince: null };
    }

    if (previousStatus === 'PAST_DUE') {
        // Still past due — a retry, not a new failure. Keep the ORIGINAL
        // timestamp, including when it is null (an account that was already
        // past due before this column existed stays in-grace rather than
        // being handed a fresh fourteen days or an expired one).
        return { status: 'PAST_DUE', pastDueSince: existingPastDueSince };
    }

    return { status: 'PAST_DUE', pastDueSince: now };
}
