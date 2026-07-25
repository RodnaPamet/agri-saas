/**
 * Contract delivery-window state — the "closing soon" / "overdue"
 * signal.
 *
 * `deliveryStart` / `deliveryEnd` were write-only decoration: the form
 * captured them, the list showed the start date, and nothing ever asked
 * whether a window had run out. The `[tenantId, deliveryStart]` index
 * backed zero queries.
 *
 * This module is the single definition of "late", shared by the list
 * badge and the daily `contract-delivery-window-sweep` job so the badge
 * a farmer sees and the notification they receive can never disagree.
 *
 * ## Scoped to ACTIVE, deliberately
 *
 * Only an ACTIVE contract can be late:
 *   - `DRAFT`      — unsigned. Nothing is owed yet.
 *   - `CANCELLED`  — void. Nobody is waiting for this grain.
 *   - `DELIVERED` / `SETTLED` — already fulfilled; flagging them would
 *     train operators to ignore the badge.
 *
 * A contract with no `deliveryEnd` has no window to miss and is never
 * flagged — absence of a date is not a deadline of zero.
 */

/** Days before `deliveryEnd` at which a contract starts warning. */
export const CLOSING_SOON_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ContractWindowState = 'overdue' | 'closing-soon';

export interface ContractWindowSignal {
    state: ContractWindowState;
    /** Whole days until `deliveryEnd`; negative once overdue. */
    daysRemaining: number;
}

/** Midnight-UTC epoch for a date, so "days" counts calendar days and a
 *  contract does not flip state purely because of the time of day. */
function startOfUtcDay(d: Date): number {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole calendar days from `now` until `deliveryEnd`. Zero on the last
 * day of the window (still in time); negative afterwards.
 */
export function daysUntil(deliveryEnd: Date, now: Date): number {
    return Math.round((startOfUtcDay(deliveryEnd) - startOfUtcDay(now)) / MS_PER_DAY);
}

/**
 * The window signal for a contract, or `null` when there is nothing to
 * say — which is the common case and must stay cheap.
 *
 * `overdue` wins over `closing-soon`: past the end date the contract is
 * late, not approaching.
 */
export function deriveContractWindowState(
    status: string,
    deliveryEnd: Date | string | null | undefined,
    now: Date,
    withinDays: number = CLOSING_SOON_DAYS,
): ContractWindowSignal | null {
    if (status !== 'ACTIVE') return null;
    if (deliveryEnd == null) return null;

    const end = deliveryEnd instanceof Date ? deliveryEnd : new Date(deliveryEnd);
    if (Number.isNaN(end.getTime())) return null;

    const daysRemaining = daysUntil(end, now);
    if (daysRemaining < 0) return { state: 'overdue', daysRemaining };
    if (daysRemaining <= withinDays) return { state: 'closing-soon', daysRemaining };
    return null;
}
