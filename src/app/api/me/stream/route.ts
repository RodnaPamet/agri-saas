/**
 * One multiplexed event stream per client — P7.2 (#1991).
 *
 *   GET /api/me/stream
 *
 * ## Why "me" and not a tenant path, and the two axes that cross here
 *
 * A person holds one connection, not one per tenant. `/api/notifications/stream`
 * is tenant-scoped, so somebody who belongs to three farms and opens three tabs
 * is nine subscriptions. The cap this route imposes is therefore per PERSON —
 * `acquireStreamSlot` keys on the user with no tenant term, which is what makes
 * "3 streams per user" (#1991's words) true rather than three per membership.
 *
 * AUTHENTICATION and DELIVERY are different axes here, and the route needs both:
 *
 *   - **Who is asking** is a person. `getUserCtx` is what answers that, and it
 *     makes three refusals a tenant-scoped helper does not: an `iflk_` API key
 *     presented as a person credential, an MFA-pending session, and the
 *     operator-only MECHANISATOR persona — whose middleware lockdown keys on a
 *     tenant slug in the URL and so cannot fire on a path that has none.
 *   - **What may be sent** is per farm. The bus channel is
 *     `notif:<tenantId>:<userId>` and `Notification`'s RLS policy is the single
 *     arm `"tenantId" = app.tenant_id`, so a delivery context without a tenant
 *     reads zero rows — silently, which is the worse half. `getLegacyCtx`
 *     resolves the session's active tenant for that side.
 *
 * So the stream is multiplexed across EVENT KINDS for one person, and scoped to
 * their active tenant for delivery. Carrying every farm's events on one
 * connection needs two things this does not have: a tenant in the frame, since
 * a client receiving a bare id from another farm would refetch a list that
 * cannot contain it; and either a person arm on that RLS policy or a per-tenant
 * fan-out of the replay query. Filed rather than half-built.
 *
 * It does not replace the notifications stream yet. That one is live behind
 * `notifications.sse` and the bell reads it; this is the surface P7.6 (the web
 * `useRealtime` hook) and P7.7 (the iOS client) are specified against, and the
 * two coexist until those land.
 *
 * ## `id:` lines are what make replay possible at all
 *
 * The notifications stream emits `data:` only. `EventSource` populates
 * `Last-Event-ID` from the `id:` field, so without one a browser has nothing
 * to send on reconnect and replay can never trigger — the server could
 * implement it perfectly and never be asked. So every event here carries its
 * notification id as the SSE id.
 *
 * ## Three things #1991 asks for, and where each lives
 *
 *   - **Replay** — `replayNotificationIdsAfter`, which reads the
 *     `Notification` table rather than the bus. The bus is Redis pub/sub and
 *     has no retention; the rows are durable and ordered already. See that
 *     module for why this is not the dependency the issue expected.
 *   - **Three streams per person** — `acquireStreamSlot`, a Redis key with a
 *     TTL. Refused rather than evicting, because `EventSource` reconnects on
 *     close and eviction would produce a reconnect storm.
 *   - **Session re-check** — below. A stream authenticated once at open and
 *     then ran for as long as the tab stayed open, so a revoked session kept
 *     receiving until it disconnected.
 *
 * ## Why the re-check closes the stream rather than going quiet
 *
 * A revoked session that stops receiving events but holds its connection looks
 * identical to a quiet period. Closing it makes the client's own reconnect the
 * thing that discovers the revocation — it reconnects, the open is refused, and
 * the UI learns it is signed out. Going quiet would leave a tab believing it
 * was live for as long as nobody looked.
 */
import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

import { getLegacyCtx, getUserCtx } from '@/app-layer/context';
import { subscribeToNotifications } from '@/lib/notifications/notification-bus';
import { replayNotificationIdsAfter } from '@/app-layer/usecases/notification-replay';
import { createSseResponse } from '@/lib/realtime/sse';
import { serialiseFrame } from '@/lib/realtime/stream-frame';
import { acquireStreamSlot } from '@/lib/realtime/stream-slots';
import { verifyAndTouchSession } from '@/lib/security/session-tracker';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { logger } from '@/lib/observability/logger';
import { env } from '@/env';
import prisma from '@/lib/prisma';

export const runtime = 'nodejs';

/** Same flag as the notifications stream: one switch for realtime, not two. */
const REALTIME_FLAG = 'notifications.sse';

/**
 * Heartbeat cadence. Matches the notifications stream so proxies see one
 * behaviour, and comfortably inside `SLOT_TTL_SECONDS` so a live stream
 * refreshes its slot long before it could lapse.
 */
const HEARTBEAT_MS = 25_000;

/**
 * #1991: "session re-check every 5 min".
 *
 * The same period as `TOUCH_INTERVAL_MS` inside `verifyAndTouchSession`, which
 * is not a coincidence worth leaving unremarked: that function bumps
 * `lastActiveAt` at most once per five minutes, so re-checking on this cadence
 * also keeps a long-lived stream's session marked active. A shorter period
 * would add reads without adding freshness, since the touch would be skipped.
 */
const SESSION_RECHECK_MS = 5 * 60_000;

/**
 * One notification frame.
 *
 * The shape lives in `stream-frame.ts` because two clients consume it and the
 * OpenAPI description has to name the same thing — see that module for why
 * `kind` is a field rather than a named SSE event, and why `tenantId` is on
 * every kind.
 */
function notificationFrame(id: string, tenantId: string): string {
    return serialiseFrame({ kind: 'notification', id, tenantId });
}

export async function GET(req: NextRequest): Promise<Response> {
    // `getUserCtx` FIRST, and the order is load-bearing: it is the only one of
    // the two that is given `req`, so it is the only one that can see an
    // `Authorization` header — and `getLegacyCtx` resolves a session without
    // looking at one, which would answer the cookie's user to a request that
    // presented an API key. Doing the person refusals before any tenant work
    // means a refused caller never reaches the membership query.
    const person = await getUserCtx(req);

    // The delivery context. See the docblock's second axis for why a tenant is
    // required at all on a person-scoped path.
    const ctx = await getLegacyCtx(req);

    // 204 rather than 404 or 403, matching the notifications stream: per the
    // EventSource specification a non-200 fails the connection WITHOUT a
    // reconnect, so a client on a deployment with realtime off stops asking
    // instead of retrying for ever. Taken from the spec rather than measured —
    // jsdom implements no EventSource.
    if (!(await isFeatureEnabled(REALTIME_FLAG, person.userId))) {
        return new Response(null, { status: 204 });
    }

    const token = await getToken({ req, secret: env.AUTH_SECRET });
    const sessionId = typeof token?.userSessionId === 'string' ? token.userSessionId : null;

    // A stream with no session lineage cannot be re-checked, so it would be
    // the one connection that outlives a revocation. Refused rather than
    // admitted unverifiable.
    if (!sessionId) {
        logger.warn('sse.no_session_lineage', { component: 'realtime' });
        return new Response(null, { status: 204 });
    }

    const streamId = crypto.randomUUID();
    // The person, not the membership — see `slotKey`.
    const acquired = await acquireStreamSlot(person.userId, streamId);
    if (!acquired.ok) {
        // At capacity. 204 for the same no-reconnect reason as the flag gate —
        // a refused tab that retried would be the reconnect storm the cap
        // exists to avoid.
        return new Response(null, { status: 204 });
    }
    const slot = acquired.slot;

    const lastEventId = req.headers.get('last-event-id');

    // ── every farm this person belongs to — #2085 ──
    //
    // Delivery was scoped to the session's ACTIVE farm, because a frame
    // carrying a bare id gave a client no way to tell which farm a row came
    // from — so an id from another farm would make it refetch a list that
    // cannot contain it. The frame now carries `tenantId`, so that constraint
    // is gone and one connection can carry them all. That is what makes "one
    // connection per person" true for somebody in three farms rather than
    // only a cap of three.
    //
    // The ACTIVE farm leads the list, which matters for the replay: the cursor
    // is resolved per farm until found, and the farm a client was last looking
    // at is overwhelmingly where its last event came from. So the common case
    // costs one query rather than N.
    //
    // Read through the UNSCOPED client because `TenantMembership` is the table
    // that answers "which tenants may I see" — scoping that read to one tenant
    // would be circular. It is filtered to this person and to live tenants,
    // mirroring `accessGrantingTenantSlugs` exactly: an ACTIVE membership of a
    // tenant that is not soft-deleted.
    const memberships = await prisma.tenantMembership.findMany({
        where: { userId: person.userId, status: 'ACTIVE', tenant: { deletedAt: null } },
        select: { tenantId: true },
    });
    const tenantIds = [
        ctx.tenantId,
        ...memberships.map((m) => m.tenantId).filter((id) => id !== ctx.tenantId),
    ];

    const { start, release } = createSseResponse({
        heartbeatMs: HEARTBEAT_MS,
        subscribe: (send) => {
            // Replayed ids must reach the client BEFORE any live one, and
            // starting the replay first is not enough to achieve that.
            //
            // `subscribe` is synchronous, because `start` is — so the bus
            // subscription below is registered immediately while the replay
            // query is still in flight. A notification published in that
            // window would be sent at once and the older ids would follow it,
            // which costs more than untidiness: `EventSource` remembers the
            // LAST id it saw as `Last-Event-ID`, so a client whose newest
            // frame is an old replayed id carries a cursor that has gone
            // BACKWARDS, and its next reconnect replays everything again from
            // there. Bounded by `REPLAY_LIMIT` and therefore not a loop, but
            // it is work done twice for a reason no client can see.
            //
            // So live events are buffered until the replay has finished, and
            // the buffer is flushed on BOTH outcomes — a replay that failed
            // must not swallow the events that arrived while it was failing.
            let pending: string[] | null = lastEventId ? [] : null;
            const flush = (): void => {
                const buffered = pending ?? [];
                // Cleared before sending, so a `send` that somehow re-enters
                // cannot replay the buffer twice.
                pending = null;
                for (const f of buffered) send(f);
            };

            const emit = (id: string, tenantId: string): void => {
                const f = notificationFrame(id, tenantId);
                if (pending) pending.push(f);
                else send(f);
            };

            if (lastEventId) {
                // Not awaited: this frame must return a releaser
                // synchronously, and a replay that failed must not stop the
                // live subscription being registered. The ids are a hint
                // either way — a client that receives none refetches, which is
                // what it does on a cold open.
                void replayNotificationIdsAfter(ctx, lastEventId, tenantIds)
                    .then((replayed) => {
                        for (const r of replayed) send(notificationFrame(r.id, r.tenantId));
                    })
                    .catch((err) => {
                        logger.warn('sse.replay_failed', {
                            component: 'realtime',
                            error: err instanceof Error ? err.message : String(err),
                        });
                    })
                    .finally(flush);
            }

            // ── one subscription per farm — #2085 ──
            //
            // The bus channel is `notif:<tenantId>:<userId>`, so Redis does
            // the routing and a process receives only what its own subscribers
            // asked for. Covering three farms is three SUBSCRIBEs on the one
            // shared subscriber connection, which is cheap — and far cheaper
            // than the three CONNECTIONS a client would otherwise hold, which
            // is the whole point of this route.
            //
            // Each closure captures its own `tenantId` so the frame can name
            // the farm. A single subscription cannot do that: the bus hands
            // the subscriber only the event, and the tenant is which channel
            // it arrived on.
            const unsubscribes = tenantIds.map((tenantId) =>
                subscribeToNotifications({
                    tenantId,
                    userId: ctx.userId!,
                    send: (event) => emit(event.id, tenantId),
                }),
            );
            const unsubscribe = () => {
                for (const u of unsubscribes) u();
            };

            // Slot refresh rides the same cadence as the heartbeat, one tick
            // behind it, so a live stream always renews well inside the TTL.
            const refresh = setInterval(() => void slot.refresh(), HEARTBEAT_MS);

            const recheck = setInterval(() => {
                void verifyAndTouchSession(sessionId)
                    .then((result) => {
                        // `revoked` only. A `rowId` of null means no session
                        // row exists — a token minted before session tracking
                        // shipped — and that function deliberately reports it
                        // as NOT revoked "so we don't lock legacy users out".
                        // Treating a missing row as revoked here would close
                        // the streams of exactly those users, turning a
                        // documented leniency into a per-connection lockout.
                        if (!result.revoked) return;
                        logger.info('sse.session_revoked', {
                            component: 'realtime',
                            // Whether a row was found, because revoked-with-row
                            // and revoked-without are different stories and the
                            // second should not happen.
                            hadRow: result.rowId !== null,
                        });
                        release();
                    })
                    .catch((err) => {
                        // A failed re-check must not close a live stream: the
                        // database being briefly unreachable is not a
                        // revocation, and closing on it would turn a blip into
                        // every client reconnecting at once.
                        logger.warn('sse.session_recheck_failed', {
                            component: 'realtime',
                            error: err instanceof Error ? err.message : String(err),
                        });
                    });
            }, SESSION_RECHECK_MS);

            // Everything this subscription owns, released together. Returning
            // one function is what lets `createSseResponse` stay unaware of
            // how many things a caller attached.
            return () => {
                clearInterval(refresh);
                clearInterval(recheck);
                unsubscribe();
                void slot.release();
            };
        },
    });

    const stream = new ReadableStream<Uint8Array>({ start, cancel: release });
    // BOTH triggers — see `createSseResponse` for what happens with only one.
    req.signal.addEventListener('abort', release);

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            // `no-transform` and `X-Accel-Buffering` are what make SSE survive
            // the real deployment: Caddy's `encode` honours `no-transform` and
            // `reverse_proxy` flushes `text/event-stream`. Without them the
            // bytes sit in a proxy buffer until it fills.
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        },
    });
}
