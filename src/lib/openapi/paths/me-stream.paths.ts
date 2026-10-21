/**
 * `GET /api/me/stream` — one multiplexed event stream per client (P7.2, #1991).
 *
 * Its own module for the reason `me-news-preferences.paths.ts` gives: the
 * shared reasoning for the `/api/me/` class is worth keeping together, but a
 * file named for farms is where a stream spec goes to be lost.
 *
 * ## What a client most needs from this spec, and OpenAPI cannot say
 *
 * Three of this route's four behaviours are STATUSES, not bodies, and they all
 * collapse to the same one:
 *
 *   - realtime disabled for this deployment  → 204
 *   - the session carries no session lineage → 204
 *   - the person already holds three streams → 204
 *
 * 204 rather than 403 or 429 in every case, and the reason is in the
 * `EventSource` specification rather than in a preference: a non-200 response
 * fails the connection WITHOUT scheduling a reconnect, so a refused client
 * stops asking. A 429 would be the honest status for the cap and would make
 * every refused tab retry into the same wall — which is the reconnect storm the
 * cap exists to prevent. So the spec documents one refusal status with three
 * causes, and says plainly that a client cannot tell them apart. A client that
 * needs to distinguish "turned off" from "too many tabs" has to ask elsewhere;
 * nothing today does.
 *
 * That is also why there is no 403 here even though the route authenticates
 * with `getUserCtx`: its three refusals (an API key on a person path, an
 * MFA-pending session, an operator-only persona) throw and are rendered by the
 * shared error envelope, which `op()` attaches to every operation.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

/**
 * The frame body — `{ id }` and nothing else.
 *
 * Deliberately narrower than `/api/notifications/stream`, which carries a whole
 * notification per `data:` line. The bus's own reason is that "the row is
 * authoritative and the event is a hint": a broadcast channel carrying content
 * is a channel whose contents are a leak if its routing is ever wrong, and an
 * id tells a client to refetch under its own authorisation.
 */
const StreamFrameSchema = z
    .object({
        kind: z.enum(['notification', 'listing']).openapi({
            description:
                'What this frame is about. A FIELD rather than a named SSE `event:` line, deliberately: a named event is silently dropped by a client that registered no listener for it, so a third kind added later would break older clients invisibly. Switch on this in the default `onmessage` handler and ignore an unrecognised value — visibly, so it can be logged. `listing` has no publisher yet; it arrives with P7.6.',
        }),
        id: z.string().openapi({
            description:
                'The row this is about — a notification id (or its dedupeKey) for `notification`, a listing id for `listing`. A handle to refetch with, never content.',
        }),
        tenantId: z.string().openapi({
            description:
                'Which farm the row belongs to. Present on EVERY kind and never optional — a field present on one kind only would make a client\u2019s handling conditional on the kind. **Its meaning differs by kind, and one reading is a trap:** for `notification` it is the farm whose row this is, and a client belonging to several farms may filter on it before refetching. For `listing` it is the farm that POSTED the listing \u2014 the exchange browses across all farms, so filtering those to your own memberships would hide every listing worth seeing. Use it for display, not as a relevance filter.',
        }),
    })
    .openapi('MeStreamEvent', {
        description:
            'The JSON on one `data:` line. IDS ONLY, by design — the row is authoritative and the event is a hint, so a client refetches under its own authorisation rather than rendering what arrived on a broadcast channel.',
    });

export function registerMeStreamPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/me/stream',
        operationId: 'streamMyEvents',
        summary: 'One multiplexed event stream for the calling person (Server-Sent Events)',
        description:
            'A long-lived `text/event-stream` keyed on the PERSON rather than on a farm, so one client holds one connection however many farms they belong to. ' +
            '\n\n**Every event carries an SSE `id:` line**, and that is what makes reconnect cheap: `EventSource` echoes the last one back as `Last-Event-ID`, and this route answers it by replaying up to 50 ids created after that cursor, oldest first. Send the header yourself if you are not using `EventSource`. A client that receives nothing on reconnect — an unknown cursor, or one older than it can resolve — should simply refetch its list, which is what it does on a cold open. ' +
            '\n\n**At most 3 concurrent streams per person**, counted in Redis across processes. The fourth is refused rather than evicting an older one, because eviction would close a live tab and that tab would reconnect. ' +
            '\n\n**A 204 means "do not reconnect"** and has three causes a client cannot distinguish: realtime is disabled for the deployment, the session has no trackable lineage, or the person is already at three streams. Per the `EventSource` specification a non-200 fails the connection without a reconnect, which is the intent in all three cases. ' +
            '\n\n**The session is re-checked every 5 minutes** and the stream is CLOSED on a revoked one, rather than going quiet — a silent stream is indistinguishable from an idle one, so closing is what lets the client discover it is signed out on its own reconnect. ' +
            '\n\n**Every farm on one connection.** The stream carries events from every farm the caller belongs to, and each frame names its own `tenantId` — so one connection serves somebody in three farms rather than needing three. Delivery was scoped to the active farm until the frame could name the tenant (#2085). The stream is ONE-WAY. ' +
            '\n\n**`id:` lines accompany `notification` frames only.** It is the replay cursor and replay reads the `Notification` table, so a `listing` frame carries its id in `data` without advancing the cursor — exchange events are live-only, and a reconnecting client refetches Борса over REST with ETag, which is what it does on a cold open. ' +
            '\n\nIt does NOT replace `GET /api/notifications/stream`, which is live and carries whole notifications; the two coexist until the web hook (P7.6) and the iOS client (P7.7) move across.',
        tags: ['Notifications'],
        success: {
            status: 200,
            description:
                'An open event stream. Each event has an `id:` line (the notification id, echoed back as `Last-Event-ID`) and a `data:` line carrying `{ id }`. Comment lines (`: …`) arrive periodically as a heartbeat and must be ignored.',
            content: { 'text/event-stream': StreamFrameSchema },
        },
    });
}
