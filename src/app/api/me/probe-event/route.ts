/**
 * Publish one event to the CALLER'S OWN realtime channel — P7.9 (#1998).
 *
 *   POST /api/me/probe-event  →  { id }
 *
 * ## Why this exists
 *
 * #1998's probe has to assert that a realtime event really arrives, end to
 * end: open a stream as an authenticated client, cause an event, see it. The
 * problem is causing one. Every existing producer notifies somebody ELSE — and
 * task assignment deliberately says nothing when the assignee is the actor, so
 * a probe cannot provoke a notification for itself through the product's own
 * surfaces without a second account and a real row it then has to clean up.
 *
 * So this publishes one id to the caller's own channel and writes NOTHING. It
 * is the smallest thing that exercises the path the failures were actually in:
 * bus → `/api/me/stream` → Caddy → client.
 *
 * ## Why it is safe to expose to any signed-in caller
 *
 * You can only ping YOURSELF. The channel is `notif:<tenantId>:<userId>` built
 * from the caller's own context, so there is no parameter naming a recipient
 * and nothing to confuse one for. The worst a caller can do is make their own
 * tabs refetch their own notification list, which they can already do by
 * reloading.
 *
 * It writes no `Notification` row, so it cannot be used to put text in front of
 * anybody — including the caller. A client that receives the id refetches and
 * finds nothing new, which is the correct outcome: the probe asserts the
 * TRANSPORT, not that a row appeared.
 *
 * ## Why the id is returned
 *
 * The probe must assert the exact event it caused arrived, not merely that
 * something did. Returning the id lets it match, which is what distinguishes
 * "the transport works" from "some unrelated notification happened to land
 * during the window".
 *
 * ## Why it is NOT flag-gated
 *
 * Deliberate, and it is the point of the endpoint. If this were behind
 * `notifications.sse`, then with the flag off the probe would get a refusal
 * here AND a 204 from the stream, and could not tell "off by decision" from
 * "the publisher is broken". Publishing is always allowed; whether anybody is
 * listening is the stream's business. That separation is what lets the probe
 * report OFF distinctly from BROKEN — #1998's second requirement.
 */
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import { getLegacyCtx, getUserCtx } from '@/app-layer/context';
import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { afterCommit } from '@/lib/db/after-commit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { logger } from '@/lib/observability/logger';
import { PROBE_ID_PREFIX } from '@/lib/realtime/stream-frame';

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    // `getUserCtx` first, for the three refusals it makes that a tenant helper
    // does not — an API key presented as a person credential, an MFA-pending
    // session, and the operator-only persona. Same order and reasoning as
    // `/api/me/stream`: it is the only one of the two given the request, so it
    // is the only one that can see an Authorization header.
    const person = await getUserCtx(req);
    // The delivery context. The bus channel is per (farm, person), so a probe
    // addresses the caller's ACTIVE farm — which is the one their open stream
    // lists first.
    const ctx = await getLegacyCtx(req);

    const id = `${PROBE_ID_PREFIX}${randomUUID()}`;
    // Wrapped even though there is no transaction here, and that uniformity is
    // the point rather than ceremony: `afterCommit` fires immediately when no
    // transaction frame is open, so it costs nothing at a site that does not
    // need it — and `notification-publish-after-commit` can then check the
    // property lexically instead of depending on each caller's context.
    //
    // The rule exists because a publish is unrecallable in a way a row is not:
    // a bell row written in a doomed transaction disappears with it, while a
    // published event is already on the wire.
    afterCommit('realtime.probe_event', () => {
        publishNotificationEvent(ctx.tenantId, person.userId, { id });
    });

    logger.info('realtime.probe_published', {
        component: 'realtime',
        // The id, because the probe's whole assertion is that THIS one arrived
        // — so a failed probe can be matched against this line.
        probeId: id,
    });

    return jsonResponse({ id }, { status: 202 });
});
