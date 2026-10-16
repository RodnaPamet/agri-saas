/**
 * 2026-05-27 — Server-Sent Events endpoint for the notification
 * bell (PR-C of the notification streaming + alerts roadmap).
 *
 * Replaces the 60s REST poll in `notifications-bell.tsx`. The
 * client opens this route via `new EventSource('/api/notifications/stream')`
 * and receives one `data:` line per new notification — emitted by
 * the in-process bus at `src/lib/notifications/notification-bus.ts`.
 *
 * Server-Sent Events vs WebSocket:
 *   - SSE is one-way (server → client). The notification bell
 *     never sends events back; the existing REST endpoints
 *     (`PATCH /api/notifications/:id`) handle mark-read.
 *   - SSE works over plain HTTPS, no upgrade handshake. Survives
 *     corporate proxies, CDNs, and HTTP/2 multiplexing without
 *     the WebSocket-specific upgrade dance.
 *   - SSE has automatic reconnect built into the browser
 *     EventSource API. The client picks back up after a network
 *     blip without bespoke retry logic.
 *
 * Heartbeat:
 *   The browser, proxies, and load balancers all close idle
 *   connections. A 25-second comment line (`: hb\n\n`) keeps the
 *   connection warm without producing a user-visible event.
 *
 * Single-process:
 *   The bus is module-level — events published on one Node
 *   process don't fan out to subscribers on another. The 60s
 *   polling fallback in the bell covers cross-pod gaps. When
 *   multi-pod fanout becomes load-bearing, swap the bus to
 *   Redis pub/sub.
 */

import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
    subscribeToNotifications,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

// Use Node runtime (not Edge) so the long-lived ReadableStream
// + setInterval heartbeat stay on the same process as the
// notification-bus publishers. Edge Functions terminate after
// ~15s of idle connection time on most providers.
export const runtime = 'nodejs';

// Disable Next.js's default response caching for SSE.
export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * The runtime gate for this channel — #1982.
 *
 * ## Why the gate moved to the server
 *
 * The client used to decide, on `NEXT_PUBLIC_NOTIFICATIONS_SSE === '1'`, and
 * this route had no gate at all. Two things were wrong with that. The flag is
 * inlined at BUILD time and appears in no Dockerfile `ARG` and no
 * `ghcr-publish.yml` build-arg, so every image ever shipped baked it
 * `undefined` and the channel could not be switched on at all — measured
 * 2026-10-16: zero requests to this route in production with a live tab. And a
 * client-side opt-in is not a feature flag; it is a client preference. The
 * endpoint itself was authenticated but ungated, so the "off" state never
 * applied to anything but the UI's willingness to connect.
 *
 * A `FeatureFlag` row is the mechanism P7's standing rules require (#1198:
 * "every social route/page behind a RUNTIME feature flag, default OFF; never
 * `NEXT_PUBLIC_*`, which is baked in at build time"), and it is what makes the
 * switch usable: a row, not a rebuild and redeploy.
 *
 * Default OFF comes for free and is not a separate decision — a missing row
 * resolves false, so the channel stays dark until somebody turns it on.
 */
const NOTIFICATIONS_SSE_FLAG = 'notifications.sse';

const encoder = new TextEncoder();

function sseFormat(event: NotificationEvent): string {
    // SSE wire format: `data: <json>\n\n`. No `event:` field —
    // the bell handles a single message kind so the default
    // `message` event type works fine.
    return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(req: NextRequest): Promise<Response> {
    // Auth: same `getLegacyCtx` guard the REST list route uses.
    // Throws on unauthenticated; middleware-level guards already
    // handle the 401 surface for the route prefix.
    const ctx = await getLegacyCtx(req);

    /**
     * 204, deliberately, and it has to be a non-200 of some kind.
     *
     * `EventSource` reconnects on its own after a network-level drop, so
     * answering "off" in a way the browser reads as a blip would produce a
     * reconnect loop against a disabled channel. Per the HTML spec's
     * EventSource processing model, a response that is not 200 with
     * `text/event-stream` makes the user agent FAIL the connection — fire
     * `error`, set `readyState` to CLOSED and NOT reattempt — which is the
     * behaviour wanted here: ask once, be told no, fall back to polling.
     *
     * 204 rather than 403 because the flag being off is not an authorization
     * failure, and a 403 per page load would log a stream of denials for a
     * switch that is simply not on.
     *
     * NOTE this is a property of the browser's EventSource, taken from the
     * spec rather than measured here: jsdom does not implement EventSource, so
     * the suite below asserts what the ROUTE does and cannot assert what a
     * real browser does with it. A browser-level assertion wants an E2E spec,
     * and there is no notification E2E spec yet.
     *
     * The subscription is deliberately after this check: a disabled channel
     * must not register a bus subscriber, or "off" would still hold a
     * listener per connection.
     */
    if (!(await isFeatureEnabled(NOTIFICATIONS_SSE_FLAG, ctx.userId))) {
        return new Response(null, { status: 204 });
    }

    /**
     * Hoisted so `cancel()` below can reach it — see the note there.
     */
    let releaseResources: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false;

            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    // Stream already torn down (client disconnected
                    // mid-flush). Drop the chunk silently.
                    closed = true;
                }
            };

            // Initial comment so the client knows the channel is
            // open. EventSource doesn't fire `onopen` for some
            // browsers until at least one byte has been received.
            safeEnqueue(': connected\n\n');

            const unsubscribe = subscribeToNotifications({
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                send: (event) => safeEnqueue(sseFormat(event)),
            });

            const heartbeat = setInterval(() => {
                safeEnqueue(': hb\n\n');
            }, HEARTBEAT_INTERVAL_MS);

            const cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                unsubscribe();
                try {
                    controller.close();
                } catch {
                    // Already closed by upstream — fine.
                }
            };

            // Client closed the tab, navigated away, or lost the
            // network. The browser sends a TCP FIN which Next
            // surfaces as an `abort` on the request signal.
            req.signal.addEventListener('abort', cleanup);
            releaseResources = cleanup;
        },

        /**
         * The SECOND way out, and it was missing.
         *
         * `cleanup` had exactly one trigger: an `abort` on the request
         * signal. That is the production path and it works — but a consumer
         * that cancels the response stream without aborting the request
         * released neither the 25s heartbeat interval nor the bus
         * subscription, so the process kept a live timer per such stream.
         *
         * Found the loud way rather than by reading: the first test to call
         * this route with the flag ON leaked the interval, the jest worker
         * never exited, and shard 4 of #1984 failed by exceeding its
         * 25-minute budget. A timeout, not an assertion — so the symptom
         * named the shard and not the cause.
         *
         * `cleanup` is idempotent (it returns early once `closed`), so
         * arriving here after an abort is harmless.
         */
        cancel() {
            releaseResources?.();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            // Disable proxy buffering — without this, nginx / Cloud
            // Run buffer SSE bytes and the client doesn't see them
            // until the buffer fills.
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        },
    });
}
