/**
 * `farmDayRange` — the [start, end) INSTANT range of a farm calendar day.
 *
 * ## Why this is not `dayKeyToInstant`, and why that distinction gets its own file
 *
 * `dayKeyToInstant` returns the UTC-midnight LABEL of a day, which is correct
 * for a DAY-VALUED column (`WorkedParcel.date` is `@db.Date`). This is for a
 * TIMESTAMP column — `MachinePosition.recordedAt` — where the question is
 * which instants fall inside the farm's day, and the answer is not UTC
 * midnight. Sofia is UTC+2 or +3.
 *
 * Getting it wrong splits a night shift across two "days", which #2948's
 * contract names explicitly, and is the same class as #1740: comparing a
 * submitted day against the end of the SERVER's UTC day refused a farmer
 * recording what they had just sprayed between local midnight and 02:00.
 *
 * ## The DST cases are the point
 *
 * Bulgaria's spring-forward day is 23 hours and its autumn-back day is 25. A
 * fixed +2 offset puts the boundary an hour wrong on both — and an hour of a
 * track is a real amount of work attributed to the wrong day. Those two days
 * are the only tests here that a wrong implementation cannot also pass.
 */
import { farmDayRange, dayKeyInTz, FARM_TIME_ZONE } from '@/lib/calendar-day-key';

const HOURS = (ms: number) => ms / 3_600_000;

describe('§1 an ordinary day is 24 hours and starts at local midnight', () => {
    it('winter (UTC+2)', () => {
        const { start, end } = farmDayRange('2026-11-10');
        expect(start.toISOString()).toBe('2026-11-09T22:00:00.000Z');
        expect(end.toISOString()).toBe('2026-11-10T22:00:00.000Z');
        expect(HOURS(end.getTime() - start.getTime())).toBe(24);
    });

    it('summer (UTC+3)', () => {
        const { start, end } = farmDayRange('2026-07-15');
        expect(start.toISOString()).toBe('2026-07-14T21:00:00.000Z');
        expect(end.toISOString()).toBe('2026-07-15T21:00:00.000Z');
        expect(HOURS(end.getTime() - start.getTime())).toBe(24);
    });

    it('is NOT the UTC day — the assertion a naive implementation fails', () => {
        // Everything else here is also satisfied by `T00:00:00Z` ranges on a
        // day whose offset happens to be zero. This is not.
        const { start } = farmDayRange('2026-11-10');
        expect(start.toISOString()).not.toBe('2026-11-10T00:00:00.000Z');
    });
});

describe('§2 DST — the cases a fixed offset cannot pass', () => {
    it('spring forward is 23 hours (2026-03-29)', () => {
        const { start, end } = farmDayRange('2026-03-29');
        expect(HOURS(end.getTime() - start.getTime())).toBe(23);
    });

    it('autumn back is 25 hours (2026-10-25)', () => {
        const { start, end } = farmDayRange('2026-10-25');
        expect(HOURS(end.getTime() - start.getTime())).toBe(25);
    });

    it('both transition days still START at local midnight', () => {
        for (const key of ['2026-03-29', '2026-10-25']) {
            const { start } = farmDayRange(key);
            // The first instant of the day must read as that day locally…
            expect(dayKeyInTz(start, FARM_TIME_ZONE)).toBe(key);
            // …and the instant before it must read as the previous day.
            expect(dayKeyInTz(new Date(start.getTime() - 1), FARM_TIME_ZONE)).not.toBe(key);
        }
    });

    it('the day either side of a transition is back to 24 hours', () => {
        // A control: the 23/25-hour assertions above would also pass if the
        // function were wrong by an hour on EVERY day in that season.
        for (const key of ['2026-03-28', '2026-03-30', '2026-10-24', '2026-10-26']) {
            const { start, end } = farmDayRange(key);
            expect(HOURS(end.getTime() - start.getTime())).toBe(24);
        }
    });
});

describe('§3 the night-shift property, which is why the helper exists', () => {
    it('contains 23:30 local and EXCLUDES 00:30 the next morning', () => {
        const { start, end } = farmDayRange('2026-11-10');
        const lateShift = new Date('2026-11-10T21:30:00.000Z'); // 23:30 Sofia
        const afterMidnight = new Date('2026-11-10T22:30:00.000Z'); // 00:30 the 11th
        expect(lateShift >= start && lateShift < end).toBe(true);
        expect(afterMidnight >= start && afterMidnight < end).toBe(false);
        // And the excluded instant belongs to the NEXT day, not to nothing.
        expect(dayKeyInTz(afterMidnight, FARM_TIME_ZONE)).toBe('2026-11-11');
    });

    it('a UTC-day range would have made the opposite call on both', () => {
        // Spelling out the defect: under `T00:00:00Z` bounds, 21:30Z on the
        // 10th is inside the 10th (agreeing by luck) while 22:30Z is too —
        // putting half an hour of the 11th's work on the 10th.
        const utcStart = new Date('2026-11-10T00:00:00.000Z');
        const utcEnd = new Date('2026-11-11T00:00:00.000Z');
        const afterMidnight = new Date('2026-11-10T22:30:00.000Z');
        expect(afterMidnight >= utcStart && afterMidnight < utcEnd).toBe(true);
        expect(dayKeyInTz(afterMidnight, FARM_TIME_ZONE)).toBe('2026-11-11');
    });

    it('consecutive days ABUT exactly — no gap and no overlap', () => {
        // A gap loses a point; an overlap counts it twice. Checked across both
        // transitions, where an off-by-an-hour would show up.
        for (const [a, b] of [
            ['2026-11-10', '2026-11-11'],
            ['2026-03-28', '2026-03-29'],
            ['2026-03-29', '2026-03-30'],
            ['2026-10-25', '2026-10-26'],
        ]) {
            expect(farmDayRange(a).end.toISOString()).toBe(farmDayRange(b).start.toISOString());
        }
    });
});

describe('§4 boundaries and refusals', () => {
    it('crosses a month boundary', () => {
        expect(farmDayRange('2026-10-31').end.toISOString())
            .toBe(farmDayRange('2026-11-01').start.toISOString());
    });

    it('crosses a year boundary', () => {
        expect(farmDayRange('2026-12-31').end.toISOString())
            .toBe(farmDayRange('2027-01-01').start.toISOString());
    });

    it('handles a leap day', () => {
        const { start, end } = farmDayRange('2028-02-29');
        expect(HOURS(end.getTime() - start.getTime())).toBe(24);
        expect(farmDayRange('2028-02-29').end.toISOString())
            .toBe(farmDayRange('2028-03-01').start.toISOString());
    });

    it('THROWS on a malformed key rather than returning an Invalid Date', () => {
        // An Invalid Date propagates into a Prisma comparison as a silent
        // never-match — a day that returns no points and no error.
        for (const bad of ['', '2026-11', '2026-13-01', 'yesterday', '2026-11-10T00:00:00Z']) {
            expect(() => farmDayRange(bad)).toThrow();
        }
    });
});
