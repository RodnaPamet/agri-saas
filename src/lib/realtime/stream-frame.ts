/**
 * The wire contract for `/api/me/stream` — #2085, agreed for P7.6/P7.7.
 *
 * ## Why this exists as its own module
 *
 * Two clients consume these frames — the web `useRealtime` hook (P7.6, #1995)
 * and the iOS client (P7.7, #1996) — and neither had shipped when the shape
 * was decided, which is the only moment it is free to change. Putting the
 * contract in one module rather than inline in the route means the OpenAPI
 * description, the route and the tests all name the same thing.
 *
 * ## `kind` is a FIELD, not a named SSE event
 *
 * SSE offers `event: <name>` lines, and a client then registers a listener per
 * name. Deliberately not used, for a reason that is about the next kind rather
 * than these two: a named event is **silently dropped** by a client that
 * registered no listener for it, so adding a third kind later breaks older
 * clients invisibly. A `kind` field reaches the single `onmessage` handler,
 * which switches on it — and an unknown value is visibly ignored, which is a
 * failure you can log.
 *
 * It also keeps the contract `notifications.paths.ts` already documents for the
 * older stream: "there is no `event:` name, so a client uses the DEFAULT
 * message handler". The iOS client decodes `kind` into an enum with an
 * `unknown` case, which its other server enums already do.
 *
 * ## `tenantId` is on EVERY kind, and not optional
 *
 * The agrent-ios session asked for this and the reason is theirs: a phone
 * belonging to several farms filters on the tenant before refetching, and a
 * field present on one kind and absent on another makes that filter
 * conditional on the kind — so every consumer would have to know which kinds
 * carry it.
 *
 * It is also what closes #2085. Delivery was scoped to the session's active
 * farm because a bare id from another farm would make a client refetch a list
 * that cannot contain it. With the tenant in the frame, one connection can
 * carry every farm the person belongs to — which is what makes "one connection
 * per person" true for somebody in three farms, rather than only a cap of
 * three.
 *
 * ## What `id:` means, and what it does not
 *
 * The SSE `id:` line stays a NOTIFICATION id and stays the replay cursor,
 * because replay reads the `Notification` table. A `listing` frame carries its
 * listing id in `data` but does NOT advance the cursor: there is nothing
 * durable behind an exchange event to replay from, and adding a second event
 * log to store what the listing rows already say is exactly what P7.2's replay
 * design avoided.
 *
 * So listing events are **live-only**, by decision (owner, 2026-10-21). A
 * client that reconnects has its missed notifications replayed and refetches
 * Борса over REST with ETag — which is what it does on a cold open anyway, and
 * what keeps the exchange's 60s list cache coherent rather than bypassed.
 */

/**
 * What a frame is about.
 *
 * Both kinds are published. `listing` arrived with the coalesced market tick
 * (#2123); the note that once stood here saying it had no publisher yet is
 * gone with it. A consumer should still switch on this rather than assume a
 * closed set — the enum is the contract, and an unknown kind is a frame to
 * ignore, not a parse error.
 */
export type StreamEventKind = 'notification' | 'listing';

/** The JSON on one `data:` line. */
export interface StreamFrame {
    kind: StreamEventKind;
    /**
     * The row this is about, for `notification`: its id, or its `dedupeKey`.
     *
     * It is a handle to refetch with, never content: the row is authoritative
     * and the event is a hint, so a client refetches under its own
     * authorisation rather than rendering what arrived on a broadcast channel.
     *
     * ## For `listing` it is NOT a handle — it is always the sentinel
     *
     * Every listing tick carries `LISTING_TICK_ID` (`'listings'`), because the
     * tick is coalesced across farms: at most one per window however many
     * listings changed. There is no single row to point at, and naming one of
     * the several that moved would invite a client to refetch that one and
     * miss the rest. `listing-broadcast.ts` reasons this out in full.
     *
     * So a client must not treat this as a listing id on a `listing` frame.
     * Refetching it gets nothing.
     */
    id: string;
    /**
     * Which farm the frame belongs to. Never absent, on any kind — but it
     * names a farm on only ONE of them.
     *
     *   - `notification` — the farm whose row this is. A client belonging to
     *     several farms filters on it before refetching, which is why
     *     agrent-ios asked for it to be non-optional.
     *   - `listing` — **always the sentinel `'listings'`.** Not a farm, not
     *     displayable, not a filter.
     *
     * ## Why `listing` has no farm, when the ruling says it names the seller
     *
     * The owner ruling of 2026-10-21 was that on a listing frame this field
     * names the SELLER and is explicitly NOT a relevance filter:
     * `listActiveListings` browses "across ALL tenants", so the value of Борса
     * is other farms' listings, and a client that filtered these to its own
     * memberships — by analogy with notifications — would hide every listing
     * worth seeing and show nothing new, silently. That reasoning stands, and
     * it is why no client should ever filter on this field.
     *
     * But the publisher that shipped is coalesced, and a tick that spans
     * sellers has no seller to name, so it sends the sentinel for the same
     * reason it sends a sentinel `id`. **The ruling describes an intent the
     * wire does not carry**, and this docblock used to state only the intent —
     * which cost a real reader a wrong model: the agrent-ios session read it
     * and planned a display path for a value that is always the literal
     * `"listings"` (#2168). Hence the ordering above: what the wire sends
     * first, the intent second.
     *
     * If a per-seller value is ever wanted on this kind, it needs a frame per
     * listing, and `listing-broadcast.ts` argues against that at length.
     */
    tenantId: string;
}

/**
 * Serialise one frame.
 *
 * `id:` only for `notification`, and that asymmetry is the contract rather
 * than an oversight — see the module docblock. A `listing` frame omitting it
 * leaves `Last-Event-ID` pointing at the last notification, which is the only
 * cursor replay can honour.
 */
export function serialiseFrame(frame: StreamFrame): string {
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    return frame.kind === 'notification' ? `id: ${frame.id}\n${data}` : data;
}

/**
 * The prefix every synthetic probe id carries — P7.9 (#1998).
 *
 * Here rather than in the route that mints it, because a Next route module may
 * export only handlers and segment config: `tests/guards/...export only what
 * Next allows` fails anything else, and it is right to — a constant exported
 * from a route is a constant whose importers pull a server handler's module
 * graph in with it.
 *
 * Deliberately NOT cuid-shaped. `notification-replay` shape-checks
 * `Last-Event-ID` against a cuid before querying, so a probe id can never be
 * mistaken for a replay cursor — a client echoing one back gets an immediate,
 * silent "no cursor" rather than a confusing empty replay.
 */
export const PROBE_ID_PREFIX = 'probe-';
