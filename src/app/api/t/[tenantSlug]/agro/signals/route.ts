import type { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonWithETag } from '@/lib/http/etag';
import { parseDateRangeParam } from '@/lib/validation/query-params';
import { listAgroSignals } from '@/app-layer/usecases/agro-signals-read';
import { MAX_SIGNAL_DAYS } from '@/lib/agro/signal-window';

/**
 * `GET /api/t/{tenantSlug}/agro/signals?from=&to=` — the farm's agro warnings
 * for a date range (#3077).
 *
 * ## Why a client needs the ROWS rather than a verdict
 *
 * «Лунен календар» must not advise sowing on a frost or spray-warning day
 * (owner, 2026-11-15), and `AgroSignal` is keyed
 * `(tenantId, locationId, kind, signalDate)` — per BLOCK. A farm with twelve
 * blocks can have frost on two, so a day-level boolean computed here would
 * either over-suppress the whole farm or say nothing about which block. The
 * client composes the suppression where it holds the location, and renders
 * «Предупреждение за слана в 2 блока».
 *
 * ## TENANT-scoped, unlike `/api/lunar`
 *
 * The lunar read is farm-free on purpose — it is astronomy, identical for
 * everyone in the country. This one is the opposite: it is the farm's own
 * blocks, so it lives under `/api/t/{tenantSlug}` and nowhere else. A lunar
 * route that wanted this data would belong here too, which is what the
 * `tenant-isolation-structural` exemption for `app/api/lunar` says.
 *
 * ## The range is capped the same way, for a different reason
 *
 * `/api/lunar` caps at 62 days because each day costs an ephemeris
 * computation. Here the cost is rows, and the cap keeps the response bounded
 * for a farm with many blocks and a bad month. The same number, so a client
 * can use one window for both reads.
 */

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const sp = req.nextUrl.searchParams;
        const rawFrom = sp.get('from');
        const rawTo = sp.get('to');
        if (!rawFrom || !rawTo) {
            throw badRequest('Both `from` and `to` are required, as YYYY-MM-DD');
        }

        // Borrowed, not re-spelled: `parseDateRangeParam` already does the
        // shape check AND a round trip, because `new Date('2026-02-30')`
        // silently becomes 2 March rather than failing. It takes one
        // `from|to` token, so the two params are joined on the way in — the
        // same bridge `/api/lunar` uses.
        const parsed = parseDateRangeParam(`${rawFrom}|${rawTo}`, 'range');
        // Destructured into locals so the narrowing STICKS: the parser's
        // return type has both fields optional, and passing the object
        // through does not convince the compiler the guard above ran.
        const from = parsed?.from;
        const to = parsed?.to;
        if (!from || !to) {
            throw badRequest('Both `from` and `to` are required, as YYYY-MM-DD');
        }
        const spanDays = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
        if (spanDays > MAX_SIGNAL_DAYS) {
            throw badRequest(`The range must be at most ${MAX_SIGNAL_DAYS} days`);
        }

        const view = await listAgroSignals(ctx, { from, to });

        // ETagged like the other hot list reads. NOT deterministic the way
        // `/api/lunar` is — a weather pull rewrites the answer, and a
        // retraction can REMOVE a row — so this is a conditional-GET
        // optimisation rather than a promise that the bytes never change.
        return jsonWithETag(req, view);
    },
);
