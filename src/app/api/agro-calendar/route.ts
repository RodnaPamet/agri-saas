import type { NextRequest } from 'next/server';

import { getUserCtx } from '@/app-layer/context';
import { loadLiveCalendarOverrides } from '@/app-layer/usecases/agro-calendar-overrides';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { jsonWithETag } from '@/lib/http/etag';
import { CALENDAR, calendarCropKeys, calendarFor } from '@/lib/agro/calendar/load';

/**
 * `GET /api/agro-calendar?region=north|south` — «Агрономически календар».
 *
 * ## Person-scoped and farm-free, like `/api/lunar`
 *
 * `getUserCtx`, no `tenantSlug`: the answer is published Bulgarian agronomy,
 * identical for every farm in a region. The owner's requirement is that the
 * calendar works before a farmer has a farm, and a tenant route cannot serve
 * somebody with no membership.
 *
 * A farm's own blocks pick the REGION on the client. That is deliberately not
 * done here: resolving it server-side would need the farm, which is exactly
 * what this route does without — and a farm with blocks in both halves of the
 * country has no single answer to inherit.
 *
 * ## Every window carries its sources, because that is the ruling
 *
 * "Publish with sources, the owner corrects afterwards" (owner, 2026-11-15).
 * So the response carries `cites` per window AND the `sources` map, which is
 * why a client can render «Източник: …» without a second call. The loader
 * refuses a dataset with an uncited window or a citation naming an absent
 * source, so a served window always resolves.
 *
 * ## `from > to` WRAPS the year, and the client must handle it
 *
 * Ten of the 126 windows run across the New Year — pruning, 15 December to
 * 30 March. A consumer comparing `from <= today <= to` lexically gets those
 * exactly backwards and reports pruning season for the eight months it is not.
 * `windowCovers` in the loader is the one implementation; the spec says so too.
 *
 * ## Stage 1 of two
 *
 * This serves the committed BASE. The owner also asked for admin corrections
 * ("automated cron job to data file, manual edit from admin screen" —
 * both), which is stage 2: global, platform-admin-gated, per-window
 * overrides with a required `basis`, audited, clearable, and marked in the
 * response so «Коригирано от Agrent» renders instead of a source. Until then
 * every window here is the cited base.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getUserCtx(req);
    await assertFeatureEnabled('agro.calendar', ctx.userId);

    const sp = req.nextUrl.searchParams;
    const region = sp.get('region');
    // An unrecognised region is a 400 rather than a default. A default would
    // serve one half of the country's dates to the other half, silently, and
    // a sowing window is not a thing to guess at.
    if (region !== 'north' && region !== 'south') {
        throw badRequest('`region` must be `north` or `south`');
    }

    const group = sp.get('group') ?? undefined;
    if (group && !['field', 'vegetable', 'perennial'].includes(group)) {
        throw badRequest('`group` must be `field`, `vegetable` or `perennial`');
    }

    const crop = sp.get('crop') ?? undefined;
    if (crop && !calendarCropKeys().includes(crop)) {
        // Named rather than empty: an unknown crop key is a client bug, and an
        // empty list would read as "we cover it and have nothing for it".
        throw badRequest('`crop` is not a crop this calendar covers');
    }

    // #3095 stage 2: the live overrides, merged by the loader. Read per
    // request — a correction takes effect at once (owner, 2026-11-16) — and
    // the ETag below follows the merged payload, so a 304 still happens
    // whenever nothing changed.
    const crops = calendarFor(
        {
            region,
            group: group as 'field' | 'vegetable' | 'perennial' | undefined,
            crop,
        },
        await loadLiveCalendarOverrides(),
    );

    // ETagged and effectively immutable until the dataset changes — the
    // committed file IS the answer, so a phone re-opening the screen gets a
    // 304. Stage 2's overrides will make it mutable, which is the point at
    // which this stops being a promise and becomes an optimisation.
    return jsonWithETag(req, {
        region,
        schemaVersion: CALENDAR.schemaVersion,
        compiledAt: CALENDAR.compiledAt,
        conventions: CALENDAR.conventions,
        sources: CALENDAR.sources,
        crops,
    });
});
