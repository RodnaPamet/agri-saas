/**
 * Delete usage events past their 90-day life (#493).
 *
 * Daily. The retention period is 90 days, so the cadence only decides how long
 * past day 90 a row waits — up to 24 hours, which is within any reading of
 * "kept for 90 days" and far cheaper than a tighter beat.
 *
 * ## Why this exists at all
 *
 * App Privacy declares these events as Product Interaction **linked to the
 * user**, which makes them personal data. Without a sweep, "90-day retention"
 * is a sentence in a privacy notice with nothing enforcing it — and this table
 * grows monotonically, so the gap widens rather than staying constant. The
 * period itself lives in `USAGE_EVENT_RETENTION_DAYS`, shared with the notice,
 * because the two drifting apart means promising a shorter life than the data
 * gets.
 *
 * ## Chunked, and bounded per run
 *
 * `deleteMany` takes no `take`, so a naive call is one unbounded DELETE holding
 * one of twelve pool connections for as long as it takes — on a table whose
 * whole purpose is to accumulate rows. The delete is therefore a raw statement
 * with its own `LIMIT` inside a subquery, repeated until a chunk comes back
 * short or the per-run cap is reached.
 *
 * The cap is not a safety valve to be removed later: it is what keeps the worst
 * run bounded after an outage, when a backlog could otherwise make the first
 * sweep after recovery the longest-running statement on the box. Rows not
 * reached today are reached tomorrow, and a telemetry row living an extra day
 * costs nothing.
 *
 * ## It runs with no tenant context, deliberately
 *
 * Retention is a PLATFORM duty across every farm, not something done per
 * tenant — and `UsageEvent`'s RLS admits this because the app's connection has
 * `role` unset, which satisfies `superuser_bypass`. A per-tenant loop would
 * need a tenant list, would take a connection per tenant, and would silently
 * skip any farm the loop forgot.
 */
import { randomUUID } from 'node:crypto';

import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { USAGE_EVENT_RETENTION_DAYS } from '@/app-layer/telemetry/usage-events';
import type { JobRunResult, UsageEventRetentionPayload } from './types';

/** Rows per statement. */
const CHUNK = 5_000;

/**
 * Statements per run — so one sweep is at most CHUNK * MAX_CHUNKS rows.
 *
 * 100k a day is far above any plausible volume for this deployment and still
 * bounded, which is the property that matters after an outage.
 */
const MAX_CHUNKS = 20;

export async function runUsageEventRetention(
    payload: UsageEventRetentionPayload = {},
): Promise<{ result: JobRunResult }> {
    const jobRunId = `uer-${randomUUID()}`;
    const startedAt = new Date();

    const chunk = payload.chunk ?? CHUNK;
    const maxChunks = payload.maxChunks ?? MAX_CHUNKS;
    const cutoff = payload.before
        ? new Date(payload.before)
        : new Date(Date.now() - USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    let deleted = 0;
    let chunks = 0;
    let reachedCap = false;

    for (; chunks < maxChunks; chunks++) {
        // `receivedAt`, never `at`: the client's clock is advisory and a phone
        // reporting 1970 would otherwise have its events deleted on arrival,
        // while one reporting 2030 would keep them for ever. Retention has to
        // run on the timestamp the SERVER controls.
        const n = await prisma.$executeRaw`
            DELETE FROM "UsageEvent"
            WHERE "id" IN (
                SELECT "id" FROM "UsageEvent"
                WHERE "receivedAt" < ${cutoff}
                LIMIT ${chunk}
            )
        `;
        deleted += n;
        if (n < chunk) break;
        if (chunks + 1 >= maxChunks) reachedCap = true;
    }

    if (reachedCap) {
        // Worth a line: hitting the cap means a backlog that one run could not
        // clear, so rows older than the stated retention are still on disk when
        // this returns. Tomorrow clears more, but a persistent cap-hit means
        // the cap is too low for the volume and needs a human.
        logger.warn('usage-event-retention.reached_cap', {
            component: 'usage-event-retention',
            deleted,
            chunk,
            maxChunks,
        });
    }

    const completedAt = new Date();
    return {
        result: {
            jobName: 'usage-event-retention',
            jobRunId,
            success: true,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            itemsScanned: deleted,
            itemsActioned: deleted,
            itemsSkipped: 0,
            details: { cutoff: cutoff.toISOString(), chunks, reachedCap },
        },
    };
}
