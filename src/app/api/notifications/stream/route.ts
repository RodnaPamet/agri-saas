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
