import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonWithETag } from '@/lib/http/etag';
import { dayKeyInTz } from '@/lib/calendar-day-key';
import { LUNAR_TIME_ZONE, MAX_LUNAR_DAYS, lunarRange } from '@/lib/lunar/lunar-day';

/**
 * `GET /api/lunar?from=&to=` — the lunar sowing calendar (#3070 stage 1).
 *
 * ## Person-scoped and FARM-FREE, deliberately
 *
 * `getUserCtx`, not `getTenantCtx`: there is no slug in the path and no farm
 * in the answer. The owner's requirement is that «Лунен календар» works
 * without Google and without a farm, and the output is identical for everyone
 * in the country on a given date — it is astronomy, not tenant data.
 *
 * That is also why it does NOT flag agro-signal conflicts, which was asked
 * for and answered with a measurement: `AgroSignal` is keyed
 * `(tenantId, locationId, kind, signalDate)` — per BLOCK. A farmer with twelve
 * blocks can have frost on two, so a day-level boolean would either
 * over-suppress everything or say nothing about which block. The conflict is a
 * property of a (day, LOCATION) pair, so the client composes it where it holds
 * the location. Adding it here would also make a farm-free, cacheable read
 * into a per-person one.
 *
 * ## The range is capped, because the work is per DAY
 *
 * Each day costs a Moon position plus a bisection for its sign change, so an
 * unbounded span is a CPU sink an authenticated caller could trip by accident
 * with a hand-edited URL. 62 days covers any month view with both neighbours.
 *
 * ## Validation is borrowed, not re-spelled
 *
 * `parseDateRangeParam` already does the two checks that matter — the shape,
 * and a ROUND TRIP, because `new Date('2026-02-30')` silently becomes 2 March
 * rather than failing. It takes one `from|to` token where this endpoint takes
 * two params (the #3070 §2 contract the phone is built against), so the two
 * are joined on the way in. Re-implementing the round trip here would be a
 * second spelling of a rule that has already been got right once.
 */
import { parseDateRangeParam } from '@/lib/validation/query-params';

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled('lunar.enabled', ctx.userId);

    const params = req.nextUrl.searchParams;
    const rawFrom = params.get('from');
    const rawTo = params.get('to');
    if (!rawFrom || !rawTo) {
        throw badRequest('Both `from` and `to` are required, as YYYY-MM-DD');
    }

    // Joined so the shape and round-trip checks are the shared ones.
    const range = parseDateRangeParam(`${rawFrom}|${rawTo}`, 'range');
    if (!range?.from || !range.to) {
        throw badRequest('Both `from` and `to` are required, as YYYY-MM-DD');
    }

    // Labelled in the calendar's own zone, so the keys the engine walks are
    // the keys the caller asked for rather than UTC's idea of the same days.
    const fromKey = dayKeyInTz(range.from, LUNAR_TIME_ZONE);
    const toKey = dayKeyInTz(range.to, LUNAR_TIME_ZONE);

    const days = lunarRange(fromKey, toKey, MAX_LUNAR_DAYS);

    // Wrapped rather than a bare array — the `{ books }` precedent: it leaves
    // room for a future field without changing the response's TYPE.
    //
    // ETagged because this answer is DETERMINISTIC: the same range returns the
    // same bytes for every caller for ever, so a phone re-opening the screen
    // gets a 304 rather than recomputing 62 days of ephemeris.
    return jsonWithETag(req, { days, timeZone: LUNAR_TIME_ZONE, maxDays: MAX_LUNAR_DAYS });
});
