/**
 * `nextReviewDateAfter` / `addMonths`.
 *
 * `ReviewCadence` had no reader in the codebase: an operator could set "review
 * quarterly" and nothing ever advanced `nextReviewDate`, so the dashboard's
 * overdue tile went red once and stayed red. The arithmetic is small enough to
 * look obvious and is exactly where a review cadence goes wrong — month
 * addition on a 31st is the classic case, and getting it wrong shortens every
 * interval a little more than the last.
 */
import { addMonths, nextReviewDateAfter } from '@/lib/evidence/review-cadence';

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describe('addMonths — day clamping', () => {
    it('keeps the anniversary day when the target month is long enough', () => {
        expect(iso(addMonths(new Date('2026-03-15T00:00:00Z'), 3))).toBe('2026-06-15');
    });

    it('clamps 31 January + 1 month to the end of February, not into March', () => {
        // `setMonth` alone rolls forward to 3 March. For a monthly cadence that
        // walks the date a few days later every single cycle.
        expect(iso(addMonths(new Date('2026-01-31T00:00:00Z'), 1))).toBe('2026-02-28');
    });

    it('clamps to 29 February in a leap year', () => {
        expect(iso(addMonths(new Date('2028-01-31T00:00:00Z'), 1))).toBe('2028-02-29');
    });

    it('does not drift: 31 Jan → Feb → Mar returns to the 31st', () => {
        // Anchoring each step to the ORIGINAL date is what keeps the
        // anniversary. Chaining from the clamped result would ratchet down to
        // the 28th and stay there.
        const start = new Date('2026-01-31T00:00:00Z');
        expect(iso(addMonths(start, 1))).toBe('2026-02-28');
        expect(iso(addMonths(start, 2))).toBe('2026-03-31');
    });

    it('rolls across a year boundary', () => {
        expect(iso(addMonths(new Date('2026-11-30T00:00:00Z'), 3))).toBe('2027-02-28');
    });

    it('preserves the time of day', () => {
        const d = addMonths(new Date('2026-03-15T09:30:45.123Z'), 1);
        expect(d.toISOString()).toBe('2026-04-15T09:30:45.123Z');
    });
});

describe('nextReviewDateAfter', () => {
    const reviewedAt = new Date('2026-03-20T12:00:00Z');

    it.each([
        ['MONTHLY', '2026-04-20'],
        ['QUARTERLY', '2026-06-20'],
        ['SEMI_ANNUALLY', '2026-09-20'],
        ['ANNUALLY', '2027-03-20'],
    ] as const)('%s advances to %s', (cadence, expected) => {
        expect(iso(nextReviewDateAfter(cadence, reviewedAt))).toBe(expected);
    });

    it('returns null with no cadence — no date is invented', () => {
        // Evidence without a cadence is reviewed on demand. Giving it a date
        // would manufacture work nobody asked for, on a tile people rely on.
        expect(nextReviewDateAfter(null, reviewedAt)).toBeNull();
        expect(nextReviewDateAfter(undefined, reviewedAt)).toBeNull();
    });

    it('measures from the review, not from the date that was missed', () => {
        // A review completed three months late must not immediately schedule
        // the next one in the past — the row would land back on the overdue
        // tile the moment it was signed off.
        const lateReview = new Date('2026-06-20T00:00:00Z');
        const next = nextReviewDateAfter('QUARTERLY', lateReview);
        expect(next!.getTime()).toBeGreaterThan(lateReview.getTime());
        expect(iso(next)).toBe('2026-09-20');
    });
});
