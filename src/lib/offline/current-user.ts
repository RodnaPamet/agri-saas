/**
 * Who is signed in on this device, for the offline layer.
 *
 * Module-scoped rather than React context because the outbox is not a
 * React thing: `enqueue` runs from a hook, `flushOutbox` is a pure
 * function in `sync.ts`, and `public/sw.js` replays from IndexedDB with
 * no React at all. A single value set once at launch is readable from
 * every one of those.
 *
 * Set from the server-resolved session id that already reaches
 * `Providers` (see `SWRPersistenceProvider`, which namespaces its cache
 * by the same value). It is an opaque identifier used for ATTRIBUTION
 * and nothing else — it is never a credential, is never sent anywhere,
 * and grants nothing.
 */
let currentUserId: string | null = null;

/** Called once at launch with the server-resolved session user id. */
export function setCurrentUserId(userId: string | null | undefined): void {
    currentUserId = userId || null;
}

/** The signed-in user, or null on a public route / before hydration. */
export function getCurrentUserId(): string | null {
    return currentUserId;
}
