/**
 * Epic 49 — `GET /api/t/[tenantSlug]/calendar/upcoming-count`.
 *
 * Lightweight count of upcoming + overdue deadlines for the sidebar
 * Calendar nav badge. Capped at 99 (the UI renders `99+` past the cap)
 * so the badge stays scannable. Uses Prisma `count()` + `take` to
 * short-circuit large tenants.
 *
 * Query params:
 *   - `days` (optional, default 7) — forward window in days.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getUpcomingDeadlineCount } from '@/app-layer/usecases/calendar';

const QuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(60).optional(),
});

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
        const { days } = QuerySchema.parse(sp);
        const count = await getUpcomingDeadlineCount(ctx, {
            horizonDays: days,
        });
        return jsonResponse({ count });
    },
);
