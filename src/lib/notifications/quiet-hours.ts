/**
 * The quiet-hours window — P7.5 (#1994).
 *
 * `docs/adr/0002-social-network-owner-decisions.md` OD18 gives the window as
 * 22:00–06:00. Its row is headed "Push for DMs", which left the scope open;
 * the owner ruled on 2026-10-21 that it applies to **all push**, not only DMs
 * and channels, and that the window is fixed rather than per-user. That is why
 * these are constants and not columns.
 *
 * ## The window crosses midnight, so the obvious comparison is wrong
 *
 * With `start = 22` and `end = 6`, no hour satisfies `h >= start && h < end` —
 * the naive range check is false for every hour of the window, so it would
 * suppress nothing all night and every test written against a daytime hour
 * would pass. The predicate is therefore a UNION of two ranges, and the test
 * for it checks an hour on each side of midnight: a check that holds at 23:00
 * and fails at 01:00 is the same defect half-fixed.
 *
 * ## Europe/Sofia, evaluated in the zone rather than by offset
 *
 * `FARM_TIME_ZONE` is the product's one timezone and no per-user timezone
 * column exists anywhere in the schema — consistent for a Bulgaria-based
 * product rather than an omission. The zone observes DST, so 06:00 local is
 * not a fixed number of hours after 22:00 local: on the spring-forward night
 * the window is seven hours long and on the autumn night it is nine. Anything
 * computed by adding eight hours is wrong twice a year, which is the standing
 * rule `format-date.ts` records.
 *
 * So the hour is read IN the zone via `Intl`, and the 06:00 target is
 * constructed by searching for the instant whose local hour is 6 rather than
 * by arithmetic on the suppressed notification's timestamp.
 */
import { FARM_TIME_ZONE, dayKeyInTz } from '@/lib/calendar-day-key';

/** First hour (inclusive) of the window, local time. OD18. */
export const QUIET_START_HOUR = 22;
/** First hour AFTER the window, local time. OD18 — 06:00 is awake. */
export const QUIET_END_HOUR = 6;

/**
 * The local hour (0-23) of `at` in the farm's zone.
 *
 * `hourCycle: 'h23'` is the load-bearing option, not `hour12: false`. The two
 * are not synonyms: `hour12: false` leaves the cycle to the locale, and
 * `en-GB` has historically resolved it to `h24`, which renders midnight as
 * `24` rather than `00`. Measured on this build it renders `00`, so the
 * divergence is latent here — which is exactly why it is pinned rather than
 * compensated for. A modulo would be a correction for an input this build
 * never produces, so no test could prove it was needed; `h23` makes the range
 * a property of the call instead of of the ICU version underneath it.
 *
 * The consequence if it ever rendered `24` would not be in `isQuietHours` —
 * midnight reads as quiet either way, since `24 >= 22` and `0 < 6` are both
 * true — but in {@link quietNightKey}, which would assign midnight to the
 * following night and schedule a second summary job for one night.
 */
function hourInFarmZone(at: Date): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: FARM_TIME_ZONE,
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(at);
    return Number(parts.find((p) => p.type === 'hour')?.value);
}

/**
 * True when `at` falls inside the quiet window, in the farm's zone.
 *
 * A UNION, not a range: see the docblock for why `h >= 22 && h < 6` is false
 * for every hour.
 */
export function isQuietHours(at: Date): boolean {
    const h = hourInFarmZone(at);
    return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/**
 * Which NIGHT `at` belongs to, as a `YYYY-MM-DD` key.
 *
 * The key names the evening the window opened, so 23:00 on the 5th and 01:00
 * on the 6th return `2026-10-05` — the same night. Without that, a summary job
 * keyed on the calendar date would schedule twice for one night, and the
 * person would get a 06:00 summary for the late evening and another for the
 * small hours.
 *
 * Returns null outside the window, because there is no night to name.
 */
export function quietNightKey(at: Date): string | null {
    if (!isQuietHours(at)) return null;
    const h = hourInFarmZone(at);
    if (h >= QUIET_START_HOUR) return dayKeyInTz(at, FARM_TIME_ZONE);
    // Before 06:00 — the window opened the previous evening. Stepping back a
    // whole day and re-reading the key in the zone, rather than subtracting
    // from the date parts, so a DST transition during the night cannot move it.
    return dayKeyInTz(new Date(at.getTime() - 24 * 60 * 60 * 1000), FARM_TIME_ZONE);
}

/**
 * The instant the window containing `at` ends — 06:00 local, in the zone.
 *
 * Found by probing forward rather than by adding hours, for the DST reason in
 * the docblock. The probe is minute-granular and bounded at 14 hours, which
 * comfortably covers the longest possible window (nine hours on the
 * autumn-back night) without an unbounded loop.
 */
export function quietWindowEnd(at: Date): Date {
    const stepMs = 60_000;
    const limit = 14 * 60; // minutes
    let t = at.getTime();
    for (let i = 0; i < limit; i++) {
        t += stepMs;
        const probe = new Date(t);
        if (!isQuietHours(probe)) return probe;
    }
    // Unreachable for any real zone. Returning the bound rather than throwing:
    // a push delivered late is recoverable, a thrown job is a notification
    // nobody ever gets.
    return new Date(t);
}

/**
 * The instants a night's window spans, from its {@link quietNightKey}.
 *
 * `start` is 22:00 on the evening the key names, `end` is the following 06:00.
 * The 06:00 summary needs both: its whole job is "what did the window hold
 * back", and that is a range over `Notification.createdAt`.
 *
 * Both ends are found by probing in the zone rather than by arithmetic on the
 * key's date, for the DST reason the file docblock gives — on the
 * autumn-back night 22:00 to 06:00 is nine hours, and on the spring-forward
 * night seven, so no fixed offset describes the pair.
 *
 * Takes the key rather than an instant because the job that calls it has only
 * the key: it was scheduled hours earlier and its own `Date.now()` is 06:00,
 * which is OUTSIDE the window it needs to describe.
 */
export function quietWindowBounds(nightKey: string): { start: Date; end: Date } {
    // Midday UTC on the key's date is inside that calendar day in Europe/Sofia
    // whatever the offset, so it is a safe anchor from which to walk forward
    // to 22:00 without a timezone round-trip on the date parts themselves.
    const [y, m, d] = nightKey.split('-').map(Number);
    const anchor = Date.UTC(y, m - 1, d, 12, 0, 0);

    const stepMs = 60_000;
    let start: Date | null = null;
    // 22:00 is at most 12 hours after midday; 13 gives slack for DST.
    for (let i = 0; i <= 13 * 60; i++) {
        const probe = new Date(anchor + i * stepMs);
        if (isQuietHours(probe)) {
            start = probe;
            break;
        }
    }
    // Unreachable: every day has a 22:00. Falling back to the anchor keeps the
    // summary querying a real range rather than throwing inside a job.
    const windowStart = start ?? new Date(anchor);
    return { start: windowStart, end: quietWindowEnd(windowStart) };
}
