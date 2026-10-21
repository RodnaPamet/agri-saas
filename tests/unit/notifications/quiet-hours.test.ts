/**
 * The quiet-hours window — P7.5 (#1994).
 *
 * Every case fixes an instant in UTC and asserts what the farm's zone makes of
 * it, because the whole module exists to get that conversion right. The two
 * hazards it is written against are the midnight crossing and DST, and both
 * have cases that fail on the obvious implementation.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
    isQuietHours,
    quietNightKey,
    quietWindowEnd,
    quietWindowBounds,
    QUIET_START_HOUR,
    QUIET_END_HOUR,
} from '@/lib/notifications/quiet-hours';

/** Europe/Sofia is UTC+2 in winter (EET) and UTC+3 in summer (EEST). */
const WINTER = (localHour: number, day = 15) =>
    new Date(Date.UTC(2026, 10, day, localHour - 2, 0, 0)); // November
const SUMMER = (localHour: number, day = 15) =>
    new Date(Date.UTC(2026, 6, day, localHour - 3, 0, 0)); // July

describe('the window', () => {
    it('is 22:00 to 06:00, per OD18', () => {
        expect(QUIET_START_HOUR).toBe(22);
        expect(QUIET_END_HOUR).toBe(6);
    });

    it.each([
        ['22:00 — the first quiet hour', 22, true],
        ['23:00', 23, true],
        ['01:00 — after midnight, still quiet', 1, true],
        ['05:00 — the last quiet hour', 5, true],
        ['06:00 — awake', 6, false],
        ['12:00 — midday', 12, false],
        ['21:00 — the hour before', 21, false],
    ])('%s', (_name, localHour, expected) => {
        expect(isQuietHours(WINTER(localHour))).toBe(expected);
    });

    it('holds on BOTH sides of midnight — the union, not a range', () => {
        // The case that fails the obvious `h >= 22 && h < 6`, which is false
        // for every hour and would suppress nothing all night while passing
        // any daytime assertion.
        expect(isQuietHours(WINTER(23))).toBe(true);
        expect(isQuietHours(WINTER(1))).toBe(true);
        // And the control, so a predicate hard-coded to `true` fails.
        expect(isQuietHours(WINTER(12))).toBe(false);
    });

    it('reads the hour in the ZONE, not in UTC', () => {
        // 21:00 UTC in July is 00:00 Sofia — quiet. A UTC-based check would
        // call it 21:00 and awake, so this single case separates the two
        // implementations.
        const midnightSofia = new Date(Date.UTC(2026, 6, 15, 21, 0, 0));
        expect(isQuietHours(midnightSofia)).toBe(true);

        // And the mirror: 04:00 UTC in July is 07:00 Sofia — awake, where a
        // UTC check would call it 04:00 and quiet.
        const sevenAmSofia = new Date(Date.UTC(2026, 6, 15, 4, 0, 0));
        expect(isQuietHours(sevenAmSofia)).toBe(false);
    });

    it('treats midnight itself as quiet', () => {
        expect(isQuietHours(WINTER(0))).toBe(true);
        expect(isQuietHours(SUMMER(0))).toBe(true);
    });

    it('pins the hour cycle in SOURCE, because behaviour cannot show it here', () => {
        // `hourCycle: 'h23'` and `hour12: false` are not synonyms: the latter
        // leaves the cycle to the locale, and `en-GB` has resolved it to `h24`
        // — midnight as `24` instead of `00`. Under `h24`, `quietNightKey`
        // would read midnight as `24 >= 22` and assign it to the FOLLOWING
        // night, scheduling a second summary job for one night.
        //
        // This build renders `00` under both options, which I measured by
        // mutating the module and watching all 19 cases still pass. So there
        // is no input available here that separates them, and a behavioural
        // assertion would be a control that cannot express the failure. My
        // first attempt at this case asserted a formatter the TEST configured,
        // which graded a copy of the right answer rather than the module's
        // choice — green for the wrong reason.
        //
        // A source assertion is the only thing that can fail on this build,
        // and it is honest about what it checks: the option is present, not
        // that the output is right.
        const src = fs.readFileSync(
            path.join(__dirname, '../../../src/lib/notifications/quiet-hours.ts'),
            'utf8',
        );

        // Scoped to the formatter's OPTION BLOCK, not the whole file. The
        // first version asserted over the whole source and failed on the
        // unmutated module, because the docblock above the call names
        // `hour12: false` while explaining why it is not used — a negated
        // assertion over prose, which is the same class of mistake #2106 is
        // about, committed in a test this time.
        //
        // Sliced rather than comment-blanked on purpose: `blankNonCode` is the
        // repo's tool for this and it is currently unreliable (#2106), so a
        // window bounded by the call's own syntax is the narrower dependency.
        const callAt = src.indexOf('new Intl.DateTimeFormat(');
        expect(callAt).toBeGreaterThan(-1);
        const options = src.slice(callAt, src.indexOf('})', callAt));

        expect(options).toMatch(/hourCycle:\s*'h23'/);
        expect(options).not.toMatch(/hour12/);
        // The window is the right one: it contains the zone this module is about.
        expect(options).toContain('FARM_TIME_ZONE');
    });
});

describe('quietNightKey', () => {
    it('names the evening the window opened, on both sides of midnight', () => {
        // The property that keeps one night to one summary job: an id keyed on
        // the calendar date would schedule twice, and the person would get a
        // 06:00 summary for the evening and another for the small hours.
        expect(quietNightKey(WINTER(23, 5))).toBe('2026-11-05');
        expect(quietNightKey(WINTER(1, 6))).toBe('2026-11-05');
    });

    it('is null outside the window — there is no night to name', () => {
        expect(quietNightKey(WINTER(12))).toBeNull();
        expect(quietNightKey(WINTER(6))).toBeNull();
    });

    it('agrees across the whole window, hour by hour', () => {
        // Every hour of one night must produce the same key. A single sampled
        // hour would pass on an implementation that got only that hour right.
        const keys = new Set<string | null>();
        for (const h of [22, 23]) keys.add(quietNightKey(WINTER(h, 5)));
        for (const h of [0, 1, 2, 3, 4, 5]) keys.add(quietNightKey(WINTER(h, 6)));

        expect(keys.size).toBe(1);
        expect([...keys][0]).toBe('2026-11-05');
    });
});

describe('quietWindowEnd', () => {
    it('lands on 06:00 local, from either side of midnight', () => {
        const fromEvening = quietWindowEnd(WINTER(23, 5));
        const fromSmallHours = quietWindowEnd(WINTER(2, 6));

        for (const d of [fromEvening, fromSmallHours]) {
            const localHour = Number(
                new Intl.DateTimeFormat('en-GB', {
                    timeZone: 'Europe/Sofia',
                    hour: '2-digit',
                    hourCycle: 'h23',
                }).format(d),
            );
            expect(localHour).toBe(6);
        }
        // Both resolve to the SAME instant: one night, one 06:00.
        expect(fromEvening.getTime()).toBe(fromSmallHours.getTime());
    });

    it('is always in the future and no longer than the window', () => {
        const at = WINTER(23, 5);
        const end = quietWindowEnd(at);

        expect(end.getTime()).toBeGreaterThan(at.getTime());
        // Seven hours from 23:00 to 06:00, with DST slack either way.
        expect(end.getTime() - at.getTime()).toBeLessThanOrEqual(9 * 60 * 60 * 1000);
    });

    it('survives the spring-forward night, when the window is SHORT', () => {
        // Europe/Sofia springs forward at 03:00 local on the last Sunday in
        // March — 2026-03-29. The window from 22:00 to 06:00 is seven hours of
        // wall clock, not eight, so anything that added eight hours would land
        // at 07:00 and push an hour late.
        const at = new Date(Date.UTC(2026, 2, 28, 20, 0, 0)); // 22:00 Sofia (UTC+2)
        expect(isQuietHours(at)).toBe(true);

        const end = quietWindowEnd(at);
        const localHour = Number(
            new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Europe/Sofia',
                hour: '2-digit',
                hourCycle: 'h23',
            }).format(end),
        );

        expect(localHour).toBe(6);
        // Seven hours of real time, which is the DST evidence: a fixed +8
        // cannot produce this.
        expect(end.getTime() - at.getTime()).toBe(7 * 60 * 60 * 1000);
    });

    it('survives the autumn-back night, when the window is LONG', () => {
        // Falls back at 04:00 local on the last Sunday in October —
        // 2026-10-25 — so 22:00 to 06:00 is nine hours.
        const at = new Date(Date.UTC(2026, 9, 24, 19, 0, 0)); // 22:00 Sofia (UTC+3)
        expect(isQuietHours(at)).toBe(true);

        const end = quietWindowEnd(at);
        expect(end.getTime() - at.getTime()).toBe(9 * 60 * 60 * 1000);
    });
});

describe('quietWindowBounds', () => {
    it('spans 22:00 on the key night to the following 06:00', () => {
        const { start, end } = quietWindowBounds('2026-11-05');
        const hourIn = (d: Date) =>
            Number(
                new Intl.DateTimeFormat('en-GB', {
                    timeZone: 'Europe/Sofia',
                    hour: '2-digit',
                    hourCycle: 'h23',
                }).format(d),
            );
        const dayIn = (d: Date) =>
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Sofia',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(d);

        expect(hourIn(start)).toBe(22);
        expect(dayIn(start)).toBe('2026-11-05');
        expect(hourIn(end)).toBe(6);
        // The NEXT day — the window crosses midnight, which is the whole
        // reason the key names an evening rather than a date.
        expect(dayIn(end)).toBe('2026-11-06');
    });

    it('agrees with what resolveDelivery deferred — the round trip', () => {
        // The property the summary depends on: a notification suppressed
        // during the night must fall inside the bounds the 06:00 job queries.
        // If these two disagree by so much as a minute, the summary silently
        // under-counts.
        const suppressedAt = new Date(Date.UTC(2026, 10, 5, 23, 30, 0)); // 01:30 Sofia, the 6th
        const key = quietNightKey(suppressedAt);
        expect(key).toBe('2026-11-05');

        const { start, end } = quietWindowBounds(key!);
        expect(suppressedAt.getTime()).toBeGreaterThanOrEqual(start.getTime());
        expect(suppressedAt.getTime()).toBeLessThan(end.getTime());
    });

    it('is nine hours on the autumn-back night and seven on spring-forward', () => {
        const autumn = quietWindowBounds('2026-10-24');
        const spring = quietWindowBounds('2026-03-28');

        expect(autumn.end.getTime() - autumn.start.getTime()).toBe(9 * 60 * 60 * 1000);
        expect(spring.end.getTime() - spring.start.getTime()).toBe(7 * 60 * 60 * 1000);
    });
});
