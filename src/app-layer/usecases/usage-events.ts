import { z } from 'zod';

import prisma from '@/lib/prisma';
import { log } from '@/lib/observability';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import {
    MAX_CLIENT_CLOCK_SKEW_MS,
    MAX_USAGE_EVENTS_PER_BATCH,
    isUsageEventName,
    isUsageSurface,
} from '@/app-layer/telemetry/usage-events';
import type { RequestContext } from '@/app-layer/types';

/** The flag key, as a STRING LITERAL so an operator can find it by reading this file. */
export const USAGE_EVENTS_FLAG = 'usage.events';

/**
 * One batch from a client.
 *
 * `.strip()` rather than `.strict()`, which is the P5.2a rule: a caller that
 * sends `tenantId` or `userId` has those fields DROPPED rather than rejected,
 * so an error message never teaches anyone that the field exists. Those two
 * values come from the session and from nowhere else — see `recordUsageEvents`,
 * where they are read off `ctx` and the body is never consulted for them.
 */
export const RecordUsageEventsSchema = z
    .object({
        events: z
            .array(
                z
                    .object({
                        // Deliberately `z.string()` and not an enum. An unknown
                        // name must be DROPPED, not refused — see below — and a
                        // zod enum here would turn a client one version ahead
                        // into a 400 for the whole batch.
                        name: z.string().min(1).max(64),
                        surface: z.string().min(1).max(64).optional(),
                        at: z.string().datetime(),
                    })
                    .strip(),
            )
            .min(1)
            .max(MAX_USAGE_EVENTS_PER_BATCH),
    })
    .strip();

export type RecordUsageEventsInput = z.infer<typeof RecordUsageEventsSchema>;

export interface RecordUsageEventsOutcome {
    accepted: number;
    dropped: number;
}

/**
 * The client's clock is ADVISORY. Anything impossible becomes `now`.
 *
 * A future `at` is always wrong — an event cannot happen after the server
 * received it — and a phone that has been off in a vehicle, or whose date was
 * set by hand, reports a past that never happened. Clamping rather than
 * rejecting keeps that person's usage in the data: discarding it would bias
 * every count toward people with correct clocks, which is a worse error than a
 * slightly wrong timestamp on a field nothing aggregates by.
 */
function clampAt(raw: string, now: Date): Date {
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return now;
    if (at.getTime() > now.getTime()) return now;
    if (now.getTime() - at.getTime() > MAX_CLIENT_CLOCK_SKEW_MS) return now;
    return at;
}

/**
 * Record a batch of product-usage events. #493.
 *
 * **Unknown names are DROPPED, never refused.** A shipped phone build cannot be
 * recalled, so a name retired here must not start failing a request — and more
 * importantly, telemetry must never be able to break the product it measures.
 * The drop COUNT is logged so client drift is visible rather than silent; the
 * dropped NAMES are not, because a name a client invented is exactly the
 * unvalidated string this table exists to keep out.
 *
 * `tenantId` and `userId` come from `ctx`. The body cannot influence them: the
 * schema strips both, and they are not read from `input` anywhere below.
 */
export async function recordUsageEvents(
    ctx: RequestContext,
    input: RecordUsageEventsInput,
): Promise<RecordUsageEventsOutcome> {
    await assertFeatureEnabled(USAGE_EVENTS_FLAG, ctx.userId);

    const now = new Date();
    const rows: {
        tenantId: string;
        userId: string;
        name: string;
        surface: string | null;
        at: Date;
        receivedAt: Date;
    }[] = [];
    let dropped = 0;

    for (const e of input.events) {
        if (!isUsageEventName(e.name)) {
            dropped++;
            continue;
        }

        // `surface` belongs to `screen_opened` and to nothing else. An action
        // carrying one has it DISCARDED rather than stored, so the column
        // cannot become a second, unvalidated dimension on 23 action names.
        if (e.name === 'screen_opened') {
            if (!isUsageSurface(e.surface)) {
                // A screen open whose screen we cannot name measures nothing,
                // and storing it would inflate the total while leaving the
                // per-screen breakdown short — a row that makes two numbers
                // disagree is worse than no row.
                dropped++;
                continue;
            }
            rows.push({
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                name: e.name,
                surface: e.surface,
                at: clampAt(e.at, now),
                receivedAt: now,
            });
            continue;
        }

        rows.push({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            name: e.name,
            surface: null,
            at: clampAt(e.at, now),
            receivedAt: now,
        });
    }

    if (dropped > 0) {
        log('warn', 'usage_events.dropped', { dropped, accepted: rows.length });
    }

    if (rows.length > 0) {
        await prisma.usageEvent.createMany({ data: rows });
    }

    return { accepted: rows.length, dropped };
}
