/**
 * Calendar page (server component shell).
 *
 * Resolves tenant context, fetches the range the client will actually
 * render first, and hands off to the client island for range navigation.
 * Subsequent fetches go through React Query, so the server payload is
 * purely a warm cache.
 *
 * The range comes from the shared `monthGridRange` helper rather than being
 * computed here: the client seeds its cache only when the server's range
 * matches its own, and two independent calculations could never be relied on
 * to agree. See ./range.ts for the failure this replaced.
 */

import { getTenantCtx } from '@/app-layer/context';
import { getCalendarEvents } from '@/app-layer/usecases/calendar';
import { env } from '@/env';
import { CalendarClient } from './CalendarClient';
import { monthGridRange, startOfUtcMonth } from './range';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    // Match the client's first render exactly: it opens on the current
    // month, so prefetch that month's grid range and nothing more. This is
    // also ~45 days of aggregation instead of the previous 360.
    const now = new Date();
    const { from, to } = monthGridRange(startOfUtcMonth(now));

    const initial = await getCalendarEvents(ctx, {
        from,
        to,
        now,
    });

    return (
        <CalendarClient
            tenantSlug={tenantSlug}
            initial={JSON.parse(JSON.stringify(initial))}
            initialRange={{
                from: from.toISOString(),
                to: to.toISOString(),
            }}
            // Events are bucketed into day cells in this zone, not UTC —
            // see calendar-day-key.ts. Same value the task-due cron uses
            // for its own "due today" classification.
            tz={env.NOTIFICATIONS_TZ}
        />
    );
}
