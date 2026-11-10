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
 * `src/lib/format-date.ts` deliberately hardcodes the zone every date
 * VALUE it renders — that module exists to stop server/client hydration
 * mismatches caused by the HOST's OS/browser locale drifting between
 * renders. It renders in `FARM_TIME_ZONE` (below), which it imports from
 * here; this docblock said "en-GB/UTC" until 2026-10-14, which stopped
 * being true when that module moved off UTC because a spray logged at
 * 18:00 local was rendering as 16:00. The PROPERTY it needs is an
 * EXPLICIT zone rather than UTC specifically.
 *
 * This helper solves a different problem (which calendar day an event
 * belongs to, per a business-defined "local day" boundary) and mirrors
 * the private `dayKeyInTz` in
 * `@/app-layer/notifications/task-due`, which the task-due cron
 * already uses for the same "due today / tomorrow" classification.
 * Kept as a separate copy (not imported from there) because that
 * module lives in the app layer while this one is a dependency-free
 * helper safe to import from client UI components.
 */

/**
 * The zone that decides which calendar day a farm is having.
 *
 * One spelling, shared by display (`format-date.ts`) and by the server-side
 * guards that ask "is this day in the future". Two spellings would let the
 * two disagree about today, which is not hypothetical: the #1740 treatment
 * guard compared a submitted day against the end of the SERVER's UTC day, so
 * between local midnight and 02:00 (winter) or 03:00 (summer) a farmer
 * recording what they had just sprayed TODAY was refused
 * `TREATMENT_DATE_IN_FUTURE` — while the screen beside them, rendered through
 * `format-date.ts`, showed that same day as today. Found by the iOS client
 * reading the code against the contract, not by a test.
 *
 * Why a constant and not a per-tenant column: there is no timezone column on
 * `Tenant` or `FarmProfile`, and `format-date.ts` records the reason — every
 * user of this product is a Bulgarian farm. A farm genuinely west of here
 * would be allowed to record a day that is still tomorrow locally, which is
 * a bounded one-day loosening for a population that does not exist yet, and
 * strictly better than refusing a real farmer's today. When a tenant zone
 * lands, this is the one place to thread it through.
 *
 * Note `task-due.ts` takes a caller-supplied `tz` defaulting to `'UTC'`
 * instead. That is a different question — a notification window the CALLER
 * scopes — and it is not evidence that UTC is the farm day.
 */
export const FARM_TIME_ZONE = 'Europe/Sofia';

/**
 * Today's `YYYY-MM-DD` as the farm sees it.
 *
 * Compare day keys as STRINGS: the format is fixed-width and zero-padded, so
 * lexicographic order IS calendar order, and there is no Date arithmetic to
 * get wrong at a DST boundary.
 */
export function farmToday(now: Date = new Date()): string {
    return dayKeyInTz(now, FARM_TIME_ZONE);
}

/**
 * The `YYYY-MM-DD` calendar-day key of `date` as seen in IANA zone
 * `tz`. `en-CA` is the locale trick that renders `Intl.DateTimeFormat`
 * output as `YYYY-MM-DD` directly — see the identical use in
 * `task-due.ts`.
 */
/** A `YYYY-MM-DD` day key, anchored so a partial match cannot pass. */
export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant that LABELS a calendar day: `YYYY-MM-DD` at UTC midnight.
 *
 * The inverse of `dayKeyInTz` for this codebase's storage convention, and the
 * convention is already everywhere — `query-params.ts`,
 * `calendar-google-sync.ts`, `news-event-extraction.ts`,
 * `support-scheme-extraction.ts` and `JournalRepository.ts` all store a day as
 * `T00:00:00Z`.
 *
 * ## Why UTC midnight and not LOCAL midnight
 *
 * Local midnight encodes the zone in the stored instant, and then every reader
 * and every writer has to agree about which zone — which is how «2 Nov» came
 * to be stored as `2026-11-01T22:00:00Z` and read back as the 1st (#2725).
 * UTC midnight is a LABEL: `dayKeyInTz` recovers the same key for any zone at
 * a non-negative offset, so the round trip is exact for `FARM_TIME_ZONE`
 * (always +2 or +3) and there is no arithmetic left for a client to get wrong.
 *
 * Throws on a malformed key rather than returning an Invalid Date, which would
 * propagate into a Prisma comparison as a silent never-match.
 */
export function dayKeyToInstant(dayKey: string): Date {
    if (!DAY_KEY_PATTERN.test(dayKey)) {
        throw new Error(`Not a YYYY-MM-DD day key: ${JSON.stringify(dayKey)}`);
    }
    const d = new Date(`${dayKey}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`Not a real calendar day: ${JSON.stringify(dayKey)}`);
    }
    return d;
}

/**
 * Today, as the comparable instant that labels it — the floor for comparing a
 * DAY-valued column against the present.
 *
 * `validTo >= farmTodayFloor(now)` is live THROUGH the whole of its last day,
 * where `validTo >= now` expired it at the start of that day (#2752). The
 * asymmetry is the bug: a day-valued column compared against a moment loses
 * the rest of the day.
 */
export function farmTodayFloor(now: Date = new Date()): Date {
    return dayKeyToInstant(farmToday(now));
}

export function dayKeyInTz(date: Date | string, tz: string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/**
 * The offset of IANA zone `tz` at `at`, in milliseconds east of UTC.
 *
 * Derived by formatting the instant AS that zone's wall clock and reading the
 * difference back, which needs no timezone database of our own and is correct
 * across DST because `Intl` already knows the rules.
 */
function tzOffsetMs(at: Date, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    // `en-CA` renders midnight as 24 rather than 00 in some ICU versions.
    const hour = get('hour') % 24;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return asUtc - at.getTime();
}

/**
 * The [start, end) INSTANT range of a farm calendar day.
 *
 * ## Why this is not `dayKeyToInstant`
 *
 * That function returns the UTC-midnight LABEL of a day, which is the right
 * thing for a DAY-VALUED column (`@db.Date`) — `WorkedParcel.date` is stored
 * and compared that way. This one is for a TIMESTAMP column, where the
 * question is "which instants fall inside the farm's 10th of November", and
 * the answer is not UTC midnight: Sofia is UTC+2 or +3, so that day runs from
 * `2026-11-09T22:00:00Z` to `2026-11-10T22:00:00Z`.
 *
 * Using the UTC day for `MachinePosition.recordedAt` would split a night
 * shift across two "days" — which is the thing #2948's contract names
 * explicitly, and the same class as #1740, where comparing a submitted day
 * against the end of the SERVER's UTC day refused a farmer recording what they
 * had just sprayed between local midnight and 02:00.
 *
 * ## DST: the offset is READ, never assumed — and read ONCE, which is a
 * deliberate simplification with a recorded premise
 *
 * Bulgaria's spring-forward day is 23 hours and its autumn-back day is 25, so
 * a hardcoded +2 puts the boundary an hour wrong on both, and an hour of a
 * track is a real amount of work attributed to the wrong day. `Intl` supplies
 * the offset instead.
 *
 * The first version read it TWICE — once at the UTC-midnight label and again
 * at the candidate start — on the theory that those differ on a transition
 * day. Two mutations then survived the whole suite: hardcoding +2, and
 * deleting the re-read. They survived because they COMPENSATE each other, and
 * measuring why settled it:
 *
 *   for `Europe/Sofia` the two reads can never disagree. The transitions are
 *   at 01:00 UTC, and the UTC-midnight label of a day is 00:00 UTC — before
 *   that instant — so the label and the local midnight it resolves to are
 *   always on the same side of the change.
 *
 * So the re-read was unreachable for this zone, and a protection no mutation
 * can kill is one the next reader trusts for a guarantee it does not provide.
 * It is gone, and the fixed-offset mutation is now caught.
 *
 * **The condition under which it must come back**, recorded because this
 * module's own docblock says "when a tenant zone lands, this is the one place
 * to thread it through": the simplification holds only while the UTC-midnight
 * label and the zone's local midnight fall on the same side of any
 * transition. That is true for every zone at a non-negative offset. For a
 * NEGATIVE-offset zone the label is the previous local day, and the two reads
 * can straddle a transition — restore the second read, and give it a test in
 * such a zone rather than keeping it on faith.
 */
export function farmDayRange(dayKey: string): { start: Date; end: Date } {
    const startOf = (key: string): Date => {
        const label = dayKeyToInstant(key); // validates, and throws on nonsense
        const guess = label.getTime();
        const offset = tzOffsetMs(new Date(guess), FARM_TIME_ZONE);
        return new Date(guess - offset);
    };

    const start = startOf(dayKey);
    // The next day's key, derived by stepping a comfortable 36 hours and
    // re-reading the farm day — never by `+1` on the date string, which is
    // wrong at a month or year boundary, and never by `+86_400_000` on the
    // start, which is wrong on a 23- or 25-hour day.
    const nextKey = dayKeyInTz(new Date(start.getTime() + 36 * 3_600_000), FARM_TIME_ZONE);
    return { start, end: startOf(nextKey) };
}
