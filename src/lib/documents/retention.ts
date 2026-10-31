/**
 * When a farm document expires, as a CALENDAR DAY.
 *
 * `FarmDocument.expiresOn` is a day key (`YYYY-MM-DD`), not an instant, and
 * `files.prisma` states why: the product concept is a date — «Пази се 1
 * година, до 14 март 2027» — so a timestamp would carry information the
 * concept does not have and every reader would then decide which day it meant.
 *
 * Three ways this could be wrong by a day, all avoided here rather than
 * handled:
 *
 * 1. **The zone.** Computed in `FARM_TIME_ZONE` (Europe/Sofia), never
 *    `NOTIFICATIONS_TZ` — which defaults to Europe/London and is `task-due`'s
 *    window zone. Using the obvious one would put every expiry a day out for
 *    half the year. A document uploaded at 23:30 Sofia belongs to ITS Sofia
 *    day, which is the next UTC day.
 * 2. **The month arithmetic.** CALENDAR months, clamped — «1 година» must end
 *    on the same date next year, and 31 January + 1 month is 28/29 February
 *    rather than 3 March. `addMonths` from `@/lib/evidence/review-cadence`
 *    already clamps exactly this way and carries the docblock about the
 *    overflow trap, so it is REUSED rather than reimplemented: two copies of
 *    a clamping rule is how two answers diverge.
 * 3. **The comparison.** Lexicographic order on a day key IS calendar order,
 *    so the sweep is a string compare against `farmToday()` and there is no
 *    Date arithmetic at the boundary to get wrong.
 *
 * The `Date` that `addMonths` operates on is built at UTC MIDNIGHT from the
 * already-resolved Sofia day, so the month arithmetic cannot itself cross a
 * day boundary — the zone question is settled before it runs, and never again
 * after.
 */
import { addMonths } from '@/lib/evidence/review-cadence';
import { dayKeyInTz, FARM_TIME_ZONE, farmToday } from '@/lib/calendar-day-key';

import type { DocumentRetention } from '@prisma/client';

/**
 * How many MONTHS each retention period runs for, or null for «Без срок».
 *
 * Months and not days: a period expressed in days cannot keep the
 * same-date-next-year promise, and `P1Y` as 365 days is wrong in a leap year.
 * Spelled as a total map over the enum so a new member is a compile error
 * rather than a silent `undefined` that would read as «Без срок» — the
 * failure direction that keeps a document for ever.
 */
export const RETENTION_MONTHS: Readonly<Record<DocumentRetention, number | null>> = {
    P3M: 3,
    P6M: 6,
    P1Y: 12,
    P2Y: 24,
    P5Y: 60,
    NONE: null,
};

/** The day key for `at` in the farm's own zone. Exported for the callers that need "today". */
export function farmDayKey(at: Date): string {
    return dayKeyInTz(at, FARM_TIME_ZONE);
}

/**
 * `expiresOn` for a document uploaded at `uploadedAt` under `retention`.
 *
 * Returns null for `NONE`, which the sweep must read as NEVER and not as the
 * beginning of time — a `lte` over a nullable column is exactly where null
 * behaves like epoch and deletes everything.
 */
export function expiryDayKey(retention: DocumentRetention, uploadedAt: Date): string | null {
    const months = RETENTION_MONTHS[retention];
    if (months === null || months === undefined) return null;

    // Resolve the Sofia day FIRST, then do month arithmetic on a UTC-midnight
    // Date built from it. The two steps never interact, which is what makes
    // the result independent of the host's zone and of DST.
    const [y, m, d] = farmDayKey(uploadedAt).split('-').map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d));
    return addMonths(anchor, months).toISOString().slice(0, 10);
}

/**
 * Has a document with this `expiresOn` reached its last day?
 *
 * `<=` because the day key names the day the retention period ENDS, and a
 * document is kept THROUGH that day — «до 14 март» includes the 14th. Null is
 * never.
 */
export function hasExpired(expiresOn: string | null, now: Date = new Date()): boolean {
    if (expiresOn === null) return false;
    return expiresOn <= farmToday(now);
}
