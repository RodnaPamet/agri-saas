import { NextRequest, NextResponse } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { codedBadRequest } from '@/lib/errors/types';
import { USAGE_EVENTS_LIMIT } from '@/lib/security/rate-limit';
import { RecordUsageEventsSchema, recordUsageEvents } from '@/app-layer/usecases/usage-events';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * Product-usage telemetry ingest — #493.
 *
 * Owner, 2026-11-01: *"our server, per account"*. Screen opens and key actions
 * come here, a superuser page shows them per farm and per screen, and no
 * third-party analytics is involved.
 *
 * `POST` a batch of at most 50 events; answers **204** with no body. The
 * response is deliberately empty: a client must not branch on what telemetry
 * replied, and parsing a body invites exactly that.
 *
 * Four properties this route is built around, each with a reason:
 *
 *   · **Unknown names are DROPPED, not refused.** A shipped phone build cannot
 *     be recalled, so retiring a name here must not start failing requests —
 *     and telemetry must never break the product it measures. The drop count
 *     is logged server-side so client drift stays visible.
 *   · **`tenantId` / `userId` come from the session.** The schema strips both
 *     from the body, so a client cannot attribute its usage to another farm or
 *     another person. Nothing below reads them from the request.
 *   · **The client's `at` is advisory.** `receivedAt` is the server's own and
 *     is what any count groups by; `at` is clamped when it is impossible.
 *   · **Its own rate-limit bucket** (`scope: 'usage-events'`). On the shared
 *     `api-mutation` budget a looping telemetry client would consume the
 *     allowance a farmer's journal write needs, putting the failure on the
 *     field record instead of on the measurement.
 *
 * Gated on the `usage.events` flag, default OFF — a runtime kill switch, since
 * the alternative for turning telemetry off is shipping an image. The key is a
 * string literal in the usecase so an operator can find it by reading the code.
 *
 * No audit row is written. This is ordinary product analytics with a 90-day
 * life; putting it in the hash-chained trail would lend it a permanence and an
 * evidentiary weight it must not have.
 */
export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: Ctx) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            throw codedBadRequest('USAGE_EVENTS_INVALID_BODY', 'Invalid request body.');
        }

        const parsed = RecordUsageEventsSchema.safeParse(body);
        if (!parsed.success) {
            // A malformed BATCH is a client bug worth naming — unlike an
            // unknown event NAME inside a well-formed batch, which is drift and
            // is dropped. The two are different failures and get different
            // answers.
            throw codedBadRequest('USAGE_EVENTS_INVALID_BATCH', 'Invalid usage-event batch.');
        }

        await recordUsageEvents(ctx, parsed.data);

        return new NextResponse(null, { status: 204 });
    },
    { rateLimit: { config: USAGE_EVENTS_LIMIT, scope: 'usage-events' } },
);
