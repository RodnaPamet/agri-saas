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
 * `listing` has no publisher yet — it arrives with P7.6 (#1995). It is in the
 * union now because the contract was agreed with both clients before either
 * shipped, and a consumer written today should switch on it rather than
 * discover it later.
 */
export type StreamEventKind = 'notification' | 'listing';

/** The JSON on one `data:` line. */
export interface StreamFrame {
    kind: StreamEventKind;
    /**
     * The row this is about — a notification id (or its `dedupeKey`) for
     * `notification`, a listing id for `listing`.
     *
     * In both cases it is a handle to refetch with, never content: the row is
     * authoritative and the event is a hint, so a client refetches under its
     * own authorisation rather than rendering what arrived on a broadcast
     * channel.
     */
    id: string;
    /**
     * Which farm the row belongs to. Never absent, on any kind.
     *
     * ## For `listing` it names the SELLER, and is NOT a filter
     *
     * Owner ruling, 2026-10-21. The semantics differ by kind and the
     * difference matters, because the obvious thing to do with this field is
     * wrong for one of them:
     *
     *   - `notification` — the farm whose row this is. A client belonging to
     *     several farms filters on it before refetching, which is why
     *     agrent-ios asked for it to be non-optional.
     *   - `listing` — the farm that POSTED it. `listActiveListings` browses
     *     "across ALL tenants", so the value of Борса is other farms'
     *     listings. A client that filtered these to its own memberships, by
     *     analogy with notifications, would hide **every listing worth
     *     seeing** and show nothing new — silently.
     *
     * So it is useful here for display, and for ignoring your own farm's
     * listings if a surface wants to. It is not an authorisation or relevance
     * filter. See #2123 for the broadcast this kind is waiting on.
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
