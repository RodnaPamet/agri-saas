/**
 * Rolling `Evidence.nextReviewDate` forward by its `reviewCycle`.
 *
 * `ReviewCadence` (MONTHLY / QUARTERLY / SEMI_ANNUALLY / ANNUALLY) has existed
 * on the model since evidence had a review workflow at all. Nothing ever read
 * it. An operator could set "review this quarterly", approve the evidence, and
 * the date sat where it was: it went overdue on the dashboard and stayed
 * overdue forever, because approving was the one action that should have moved
 * it and didn't. A cadence that never advances is worse than no cadence — the
 * tile is permanently red, so people stop reading the tile.
 *
 * Pure and dependency-free so the arithmetic can be tested directly. Month
 * arithmetic is the whole subject here: see `addMonths`.
 */
import type { ReviewCadence } from '@prisma/client';

/** Months to advance per cadence. */
const MONTHS_BY_CADENCE: Record<ReviewCadence, number> = {
    MONTHLY: 1,
    QUARTERLY: 3,
    SEMI_ANNUALLY: 6,
    ANNUALLY: 12,
};

/**
 * Add whole months, clamping the day to the target month's length.
 *
 * `setMonth` alone overflows: 31 January + 1 month lands on 3 March (or 2
 * March in a leap year), because February has no 31st and the Date object
 * rolls forward rather than refusing. For a review cadence that silently
 * shortens the interval and drifts the date every cycle — a monthly review set
 * on the 31st walks itself to the 3rd within a year. Clamping keeps the
 * anniversary stable: 31 Jan → 28/29 Feb → 31 Mar.
 */
export function addMonths(from: Date, months: number): Date {
    const year = from.getUTCFullYear();
    const month = from.getUTCMonth();
    const day = from.getUTCDate();

    const targetMonthIndex = month + months;
    // Day 0 of the following month is the last day of the target month.
    const daysInTargetMonth = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();

    return new Date(Date.UTC(
        year,
        targetMonthIndex,
        Math.min(day, daysInTargetMonth),
        from.getUTCHours(),
        from.getUTCMinutes(),
        from.getUTCSeconds(),
        from.getUTCMilliseconds(),
    ));
}

/**
 * The next review date after a review has just happened.
 *
 * Measured from `reviewedAt`, not from the previous `nextReviewDate`. Both are
 * defensible, but anchoring to the old date means a review completed three
 * months late immediately schedules the next one in the past — the row would
 * arrive back on the overdue tile the moment it was signed off, which is how a
 * queue stops being believed. Anchoring to the review itself gives the full
 * interval from the moment someone actually looked.
 *
 * Returns null when there is no cadence — evidence without one is reviewed
 * on demand, and inventing a date for it would create work nobody asked for.
 */
export function nextReviewDateAfter(
    cadence: ReviewCadence | null | undefined,
    reviewedAt: Date,
): Date | null {
    if (!cadence) return null;
    const months = MONTHS_BY_CADENCE[cadence];
    if (!months) return null;
    return addMonths(reviewedAt, months);
}
