/**
 * Epic 49 — `GET /api/t/[tenantSlug]/calendar` route.
 *
 * Returns the unified calendar event stream for the given
 * date range. Powers the heatmap, monthly grid, and Gantt views.
 *
 * Query params (validated by `CalendarQuerySchema`):
 *   - `from` (required) — ISO date / datetime
 *   - `to`   (required) — ISO date / datetime
 *   - `types`      (optional) — comma-separated CalendarEventType list
 *   - `categories` (optional) — comma-separated CalendarEventCategory list
 *
 * Response: `CalendarResponse` (events + counts + range).
 *
 * Tenant safety: `getTenantCtx(params, req)` resolves the slug → ctx,
 * verifies membership, and the underlying usecase always filters on
 * `tenantId: ctx.tenantId`.
 */

import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getCalendarEvents } from '@/app-layer/usecases/calendar';
import { CalendarQuerySchema } from '@/app-layer/schemas/calendar.schemas';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
        const query = CalendarQuerySchema.parse(sp);

        const response = await getCalendarEvents(ctx, {
            from: new Date(query.from),
            to: new Date(query.to),
            types: query.types,
            categories: query.categories,
        });

        return jsonResponse(response);
    },
);
