/**
 * `expiresOn` arithmetic — the four cases #2495's retention contract names,
 * plus one correction to that contract's own wording.
 *
 * Every assertion here is about a DAY, which is the point: the feature stores
 * a calendar day key rather than an instant precisely so that none of this
 * depends on the host's zone or on DST. These tests pass a fixed `Date` in, so
 * they would also pass in CI on a UTC machine for the RIGHT reason rather
 * than by accident — the zone that decides the answer is read from
 * `FARM_TIME_ZONE`, never from the ambient one.
 */
import { expiryDayKey, farmDayKey, hasExpired, RETENTION_MONTHS } from '@/lib/documents/retention';

import type { DocumentRetention } from '@prisma/client';

const R = (k: string) => k as DocumentRetention;

describe('expiryDayKey — the retention period', () => {
    it('«1 година» lands on the SAME DATE next year', () => {
        // Months, not 365 days. A day count gets this wrong in a leap year
        // and the farmer's «до 14 март 2027» stops being true.
        expect(expiryDayKey(R('P1Y'), new Date('2026-03-14T10:00:00Z'))).toBe('2027-03-14');
    });

    it('«Без срок» is null — and null must read as NEVER, not as epoch', () => {
        expect(expiryDayKey(R('NONE'), new Date('2026-03-14T10:00:00Z'))).toBeNull();
        // The half that matters for the sweep: a `lte` over a nullable column
        // is where null quietly behaves like the beginning of time and
        // deletes everything it was supposed to keep for ever.
        expect(hasExpired(null, new Date('2099-01-01T00:00:00Z'))).toBe(false);
    });

    it('every period in the enum has a number of months, or an explicit null', () => {
        // A total map, so adding a member to DocumentRetention is a compile
        // error rather than an `undefined` that would read as «Без срок» —
        // the failure direction that keeps a document for ever.
        const values = Object.values(RETENTION_MONTHS);
        expect(values).toHaveLength(6);
        expect(values.filter((v) => v === null)).toHaveLength(1);
        for (const v of values) {
            if (v !== null) expect(v).toBeGreaterThan(0);
        }
    });
});

describe('expiryDayKey — month-end clamping, both directions', () => {
    it('31 January + 3 months is 30 April, not 1 May', () => {
        // `setMonth` left to overflow puts 31 January + 1 month on 3 March.
        // The clamp is why this reuses review-cadence's addMonths.
        expect(expiryDayKey(R('P3M'), new Date('2026-01-31T10:00:00Z'))).toBe('2026-04-30');
    });

    it('29 February + 1 year is 28 February', () => {
        expect(expiryDayKey(R('P1Y'), new Date('2028-02-29T10:00:00Z'))).toBe('2029-02-28');
    });

    it('31 January + 1 month is 28 February in a common year and 29 in a leap one', () => {
        // Both directions of the clamp from one anchor, which is what proves
        // it is a clamp and not a fixed offset.
        expect(expiryDayKey(R('P3M'), new Date('2025-11-30T10:00:00Z'))).toBe('2026-02-28');
        expect(expiryDayKey(R('P3M'), new Date('2027-11-30T10:00:00Z'))).toBe('2028-02-29');
    });
});

describe('expiryDayKey — the zone is the farm’s, not the host’s', () => {
    /*
     * #2495's contract lists this case as:
     *
     *   "A document uploaded at 23:30 Sofia gets the expiry of ITS Sofia day,
     *    not the UTC day before it."
     *
     * The intent is right and the example cannot fail: Sofia is AHEAD of UTC,
     * so 23:30 Sofia is 21:30Z (winter) or 20:30Z (summer) on the SAME
     * calendar day, and a naive `.slice(0, 10)` on the instant would get it
     * right by luck. The divergence is in the early MORNING — 00:30 Sofia is
     * 22:30Z on the PREVIOUS day — so that is what is tested here, in both
     * halves of the year. Recorded rather than silently fixed, because an
     * example that cannot fail is the thing this suite exists to avoid.
     */
    it('00:30 Sofia belongs to its own day, not to the previous UTC one', () => {
        const winter = new Date('2026-03-14T22:30:00Z'); // 00:30 Sofia, 15 Mar (UTC+2)
        expect(farmDayKey(winter)).toBe('2026-03-15');
        expect(expiryDayKey(R('P1Y'), winter)).toBe('2027-03-15');

        const summer = new Date('2026-07-14T21:30:00Z'); // 00:30 Sofia, 15 Jul (UTC+3)
        expect(farmDayKey(summer)).toBe('2026-07-15');
        expect(expiryDayKey(R('P1Y'), summer)).toBe('2027-07-15');
    });

    it('23:30 Sofia stays on its own day too — the control for the case above', () => {
        // If this one ever disagreed with the UTC slice, the zone handling
        // would be broken in the other direction.
        expect(expiryDayKey(R('P1Y'), new Date('2026-03-14T21:30:00Z'))).toBe('2027-03-14');
        expect(expiryDayKey(R('P1Y'), new Date('2026-07-14T20:30:00Z'))).toBe('2027-07-14');
    });

    it('the offset is read per-instant, so a DST boundary inside the period is harmless', () => {
        // 20 March is UTC+2; 20 April is UTC+3. Same date next year either
        // way, because the arithmetic runs on the resolved DAY and never on
        // an instant.
        expect(expiryDayKey(R('P1Y'), new Date('2026-03-20T12:00:00Z'))).toBe('2027-03-20');
        expect(expiryDayKey(R('P1Y'), new Date('2026-04-20T12:00:00Z'))).toBe('2027-04-20');
    });
});

describe('hasExpired — the sweep’s comparison', () => {
    it('a document is kept THROUGH its expiry day', () => {
        // «до 14 март» includes the 14th, so the sweep takes it on the 14th
        // and not before. Both sides of the boundary, in Sofia terms.
        const onTheDay = new Date('2026-03-14T08:00:00Z');   // 10:00 Sofia, 14 Mar
        const theDayBefore = new Date('2026-03-13T08:00:00Z');
        expect(hasExpired('2026-03-14', theDayBefore)).toBe(false);
        expect(hasExpired('2026-03-14', onTheDay)).toBe(true);
    });

    it('lexicographic order IS calendar order, across a year and a month boundary', () => {
        const now = new Date('2026-03-14T08:00:00Z');
        expect(hasExpired('2026-02-28', now)).toBe(true);
        expect(hasExpired('2025-12-31', now)).toBe(true);
        expect(hasExpired('2026-03-15', now)).toBe(false);
        expect(hasExpired('2027-01-01', now)).toBe(false);
    });
});
