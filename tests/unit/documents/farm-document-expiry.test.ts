/**
 * The expiry day key is calendar arithmetic, not `Date` arithmetic (#2495).
 *
 * `FarmDocument.expiresOn` is a `YYYY-MM-DD` string rather than a `DateTime`,
 * and the schema docblock says why: the concept IS a calendar date, so a
 * timestamp would carry information the concept does not have and every
 * reader would then decide which day it meant. The retention sweep is a
 * string compare against `farmToday()`, which only works if these keys are
 * built the same way.
 *
 * Two things can go wrong and neither is visible in a green build:
 *
 *   - **Month-end overflow.** `setMonth(getMonth() + 3)` on 31 January gives
 *     1 May, because JavaScript rolls the overflow forward rather than
 *     clamping. A retention period would then quietly expire a document late,
 *     and 31 August + 6 months lands in March instead of February.
 *   - **The wrong timezone.** `FARM_TIME_ZONE` is Europe/Sofia;
 *     `env.NOTIFICATIONS_TZ` defaults to Europe/London. Those differ by two
 *     hours, so an upload between 22:00 and midnight Sofia time is dated to
 *     the PREVIOUS day under the wrong one — and the whole retention period
 *     is then a day out, for exactly the documents uploaded after a working
 *     day ends.
 */
import { documentExpiryDayKey } from '@/app-layer/usecases/farm-documents';

describe('documentExpiryDayKey', () => {
    it('adds whole months for each period', () => {
        const d = new Date('2026-03-15T09:00:00Z');
        expect(documentExpiryDayKey('P3M', d)).toBe('2026-06-15');
        expect(documentExpiryDayKey('P6M', d)).toBe('2026-09-15');
        expect(documentExpiryDayKey('P1Y', d)).toBe('2027-03-15');
        expect(documentExpiryDayKey('P2Y', d)).toBe('2028-03-15');
        expect(documentExpiryDayKey('P5Y', d)).toBe('2031-03-15');
    });

    it('answers null for «Без срок», which is not a far-future sentinel', () => {
        // A sentinel date would be compared by the sweep and would eventually
        // expire the document; null is excluded by the sweep's own
        // `expiresOn IS NOT NULL` clause.
        expect(documentExpiryDayKey('NONE', new Date('2026-03-15T09:00:00Z'))).toBeNull();
    });

    it('CLAMPS into a shorter month instead of rolling forward', () => {
        // 31 January + 3 months is April, which has 30 days.
        expect(documentExpiryDayKey('P3M', new Date('2026-01-31T09:00:00Z'))).toBe('2026-04-30');
        // 31 October + 6 months is April again, from the other direction.
        expect(documentExpiryDayKey('P6M', new Date('2026-10-31T09:00:00Z'))).toBe('2027-04-30');
        // 31 August + 6 months is February — the case `setMonth` overshoots.
        expect(documentExpiryDayKey('P6M', new Date('2026-08-31T09:00:00Z'))).toBe('2027-02-28');
    });

    it('clamps to 28 or 29 February according to the TARGET year', () => {
        expect(documentExpiryDayKey('P1Y', new Date('2023-02-28T09:00:00Z'))).toBe('2024-02-28');
        // 29 February 2026 does not exist; 2026-02-29 parses as 1 March, and
        // +2 years is 1 March 2028. Asserting the real behaviour rather than
        // a date the calendar does not have.
        expect(documentExpiryDayKey('P2Y', new Date('2024-02-29T09:00:00Z'))).toBe('2026-02-28');
    });

    it('rolls the year over correctly', () => {
        expect(documentExpiryDayKey('P3M', new Date('2026-11-15T09:00:00Z'))).toBe('2027-02-15');
        expect(documentExpiryDayKey('P6M', new Date('2026-12-01T09:00:00Z'))).toBe('2027-06-01');
        expect(documentExpiryDayKey('P1Y', new Date('2026-12-31T09:00:00Z'))).toBe('2027-12-31');
    });

    it('resolves the upload DAY in Europe/Sofia, not UTC', () => {
        // 22:30 UTC on 31 December is 00:30 on 1 January in Sofia (UTC+2 in
        // winter). Reading this in UTC would date the upload to 31 December
        // and skew the expiry by a day for the document's whole life.
        expect(documentExpiryDayKey('P3M', new Date('2026-12-31T22:30:00Z'))).toBe('2027-04-01');
        expect(documentExpiryDayKey('P1Y', new Date('2026-12-31T22:30:00Z'))).toBe('2028-01-01');
    });

    it('is zero-padded, which is what makes the sweep's string compare safe', () => {
        const early = documentExpiryDayKey('P3M', new Date('2026-01-05T09:00:00Z'))!;
        const late = documentExpiryDayKey('P3M', new Date('2026-01-15T09:00:00Z'))!;
        expect(early < late).toBe(true);
        // Without padding a single-digit month sorts above a double-digit
        // one, which is the defect that makes string comparison unsafe.
        for (const d of ['2026-01-05', '2026-03-05', '2026-09-30']) {
            expect(documentExpiryDayKey('P6M', new Date(`${d}T09:00:00Z`))).toMatch(
                /^\d{4}-\d{2}-\d{2}$/,
            );
        }
    });
});
