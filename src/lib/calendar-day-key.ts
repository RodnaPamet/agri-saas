/**
 * Timezone-aware calendar-day bucketing for the farm schedule.
 *
 * `CalendarEvent.date` is an ISO instant. Most sources emit UTC
 * midnight (a pure date), but several agriculture sources carry a real
 * time-of-day (e.g. a farm task due at 01:00). Slicing the ISO string
 * (`date.slice(0, 10)`) reads the UTC calendar day, which is WRONG for
 * a Bulgaria-based farm: a task due at 01:00 Europe/Sofia on the 5th is
 * 22:00 UTC on the 4th, so a naive slice buckets it onto the previous
 * day.
 *
 * `src/lib/format-date.ts` deliberately hardcodes every date VALUE it
 * renders to en-GB/UTC — that module exists to stop server/client
 * hydration mismatches caused by the HOST's OS/browser locale drifting
 * between renders. This helper solves a different problem (which
 * calendar day an event belongs to, per a business-defined "local day"
 * boundary) and mirrors the private `dayKeyInTz` in
 * `@/app-layer/notifications/task-due`, which the task-due cron
 * already uses for the same "due today / tomorrow" classification.
 * Kept as a separate copy (not imported from there) because that
 * module lives in the app layer while this one is a dependency-free
 * helper safe to import from client UI components.
 */

/**
 * The `YYYY-MM-DD` calendar-day key of `date` as seen in IANA zone
 * `tz`. `en-CA` is the locale trick that renders `Intl.DateTimeFormat`
 * output as `YYYY-MM-DD` directly — see the identical use in
 * `task-due.ts`.
 */
export function dayKeyInTz(date: Date | string, tz: string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}
