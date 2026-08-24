/**
 * Offline sync — the "replay" half of queue-and-sync.
 *
 * `flushOutbox` drains the outbox in FIFO order, handing each item to a
 * `Sender` (the real one POSTs/PATCHes via fetch). The retry policy is
 * the crux:
 *   - 2xx success            → remove (delivered).
 *   - 4xx (except 408/429)   → DROP. A client error won't succeed on
 *                              retry; keeping it would wedge the queue
 *                              behind a permanently-failing item.
 *   - network throw / 5xx /
 *     408                    → KEEP + bump attempts (transient; retry on
 *                              the next flush / reconnect).
 *   - 429 rate limited       → KEEP, do NOT bump attempts, STOP draining.
 *                              See below.
 *
 * ## 429 is special (mobile-first offline replay)
 *
 * A PWA that queued edits offline replays them in a BURST on reconnect. If
 * the burst exceeds the mutation rate limit the server returns 429 — which is
 * NOT the item's fault and WILL succeed once the window rolls off. So a 429
 * must never (a) count toward `MAX_ATTEMPTS` (or a long-enough burst would
 * silently DROP a farmer's queued work) nor (b) keep hammering the rest of the
 * queue into the same closed window. On the first 429 we RETAIN every
 * remaining item untouched, stop the pass, surface the server's `Retry-After`,
 * and let the caller reschedule after that delay. A reconnect burst is a
 * legitimate single-user pattern; the queue drains across a few windows
 * instead of losing data.
 *
 * Items past `MAX_ATTEMPTS` (genuine transient failures only) are dropped so a
 * poison item can't block the queue forever. The same item id rides every
 * retry, so a server that dedupes on it sees at-least-once delivery as
 * exactly-once.
 */
import { isPhotoItem, type OutboxItem, type OutboxStore } from './outbox';
import { noteDelivered } from './delivery-receipts';

export interface SendResult {
    ok: boolean;
    status: number;
    /** Parsed `Retry-After` (seconds) when the server sent one on a 429. */
    retryAfter?: number;
    /** Parsed 409 body (the server's current state) for a STALE_DATA conflict. */
    conflict?: unknown;
}

export type Sender = (item: OutboxItem) => Promise<SendResult>;

export interface FlushSummary {
    sent: number;
    failed: number;
    dropped: number;
    /**
     * Items left untouched because a DIFFERENT operator queued them. Never
     * sent (they would land attributed to the wrong person, or 403 and be
     * destroyed) and never dropped — they wait for their owner to sign in.
     */
    foreign: number;
    /**
     * Retained but undeliverable until something outside the queue changes —
     * a refused session (401/403) or exhausted server-side retries. Never
     * sent, NEVER dropped. Counted separately from `failed` because only
     * these need an operator to do something.
     */
    blocked: number;
    /** The pass stopped because the session was refused. */
    authBlocked: boolean;
    remaining: number;
    /** True when the pass stopped early because the server rate-limited us. */
    rateLimited: boolean;
    /** Seconds to back off before the next flush, from the 429 `Retry-After`. */
    retryAfterSeconds?: number;
    /** Items newly parked as 409 conflicts awaiting operator resolution. */
    conflicts: number;
}

export const MAX_ATTEMPTS = 8;

/** Non-429 retryable: network throw (0), 408 timeout, any 5xx. */
/**
 * A SERVER-produced transient. Deliberately excludes `status === 0`.
 *
 * Status 0 means the request never reached anyone — dead radio, aeroplane
 * mode, a captive portal. Counting that as a failed attempt marched queued
 * work toward MAX_ATTEMPTS and then deleted it, so a phone retrying in a
 * field with no signal destroyed the very work it was holding. A request
 * that was never sent has not failed; there is nothing to give up on.
 */
function isTransient(status: number): boolean {
    return status === 408 || status >= 500;
}

/** The request never left the device. Retain untouched — no attempt spent. */
function neverSent(status: number): boolean {
    return status === 0;
}

/** Drain the outbox once. Safe to call repeatedly (idempotent per item). */
export async function flushOutbox(
    store: OutboxStore,
    send: Sender,
    /**
     * The user this drain is running as. Items queued by someone ELSE are
     * skipped — see the `foreign` branch below. `null` (no known user, e.g.
     * the service worker replaying with no session context) drains
     * everything, which is the pre-existing behaviour.
     */
    ownerUserId: string | null = null,
): Promise<FlushSummary> {
    const items = await store.all(); // FIFO (createdAt asc)
    let sent = 0;
    let blocked = 0;
    let authBlocked = false;
    let failed = 0;
    let dropped = 0;
    let foreign = 0;
    let conflicts = 0;
    let rateLimited = false;
    let retryAfterSeconds: number | undefined;

    for (const item of items) {
        // A parked 409 conflict awaits operator resolution — never re-send it
        // (a blind retry would 409 again, or clobber once versions align).
        if (item.conflict) continue;

        // Already parked as undeliverable. Re-sending an auth-blocked item
        // before the operator signs in again just reproduces the 401.
        if (item.blocked) {
            blocked++;
            continue;
        }

        // Queued by a DIFFERENT operator on this device. A replay uses the
        // CURRENT session cookie, so sending it would either attribute the
        // write to the wrong person in a hash-chained audit trail, or — if
        // the tenants differ — earn a 403, which the terminal-4xx branch
        // below would treat as undeliverable and REMOVE. That removal is
        // invisible to the loss detector, because it looks deliberate and
        // the manifest is re-mirrored from the queue straight after. So:
        // skip, never send, never drop. It waits for its owner.
        if (ownerUserId && item.queuedByUserId && item.queuedByUserId !== ownerUserId) {
            foreign++;
            continue;
        }

        let res: SendResult;
        try {
            res = await send(item);
        } catch {
            res = { ok: false, status: 0 }; // network unreachable
        }

        if (res.ok) {
            // Receipt FIRST, then removal. A receipt exists if and only if the
            // removal was deliberate, which is what lets the page tell a drain
            // apart from an eviction — including a drain the SERVICE WORKER
            // performed, which leaves no other trace the page can read.
            await noteDelivered(store, item.id);
            await store.remove(item.id);
            sent++;
        } else if (res.status === 409) {
            // Optimistic-lock conflict — the row moved on while this edit sat
            // queued. Retain it (NON-transient: never dropped, never clobbered)
            // and surface a resolution moment. Keep the server state for the UI.
            // Guard against resurrection: a concurrent flush's late 409 must not
            // re-add an item the operator already resolved (take-server removed
            // it) — only park it if it's still queued.
            const stillQueued = (await store.all()).some((i) => i.id === item.id);
            if (stillQueued) {
                await store.update({ ...item, conflict: { status: 409, server: res.conflict } });
                conflicts++;
            }
        } else if (res.status === 429) {
            // Rate limited — retain untouched (no attempts bump, never
            // dropped) and stop draining into a closed window.
            rateLimited = true;
            retryAfterSeconds = res.retryAfter;
            break;
        } else if (neverSent(res.status)) {
            // Never reached the server. Retain EXACTLY as-is: no attempt
            // spent, nothing dropped. Eight passes with dead radio used to
            // exhaust MAX_ATTEMPTS and delete the item.
            failed++;
        } else if (res.status === 401 || res.status === 403) {
            // The server refused the SESSION, not the work. Retain and block:
            // a revoked or expired session is a property of the session, and
            // deleting an operator's marks because their password changed on
            // a laptop destroys field work nothing can recover. Stop the pass
            // — every remaining item carries the same credential and would
            // meet the same answer.
            await store.update({ ...item, blocked: 'auth' });
            blocked++;
            authBlocked = true;
            break;
        } else if (isTransient(res.status)) {
            const next = { ...item, attempts: item.attempts + 1 };
            if (next.attempts >= MAX_ATTEMPTS) {
                // Park, never delete. The poison-item escape is that it stops
                // being retried, not that the work is destroyed.
                await store.update({ ...next, blocked: 'exhausted' });
                blocked++;
            } else {
                await store.update(next);
                failed++;
            }
        } else {
            // Genuinely terminal for THIS item (a 4xx about the payload).
            // Dropping keeps the queue moving, and the receipt below is what
            // stops the loss detector reading it as an eviction.
            await noteDelivered(store, item.id);
            await store.remove(item.id);
            dropped++;
        }
    }

    const remaining = (await store.all()).length;
    return { sent, failed, dropped, foreign, blocked, authBlocked, conflicts, remaining, rateLimited, retryAfterSeconds };
}

/** A fetch-backed Sender for the browser. */
export function fetchSender(): Sender {
    return async (item) => {
        // Photo items replay as multipart (reconstructed FormData from the
        // stored Blob); mutations replay as JSON. Both carry the item id as
        // `Idempotency-Key` so the server dedupes a replay (the SAME item id
        // rides every retry) into exactly-once — a photo can't attach twice.
        // A mutation additionally sends `If-Match` (the optimistic-lock version
        // the client saw) so the server 409s a stale write instead of clobbering.
        let res: Response;
        if (isPhotoItem(item)) {
            const fd = new FormData();
            fd.append('file', new File([item.blob], item.fileName, { type: item.fileType }));
            res = await fetch(item.url, {
                method: item.method,
                // No explicit Content-Type — the browser sets the multipart
                // boundary. The idempotency handle rides a header only.
                headers: { 'Idempotency-Key': item.id },
                body: fd,
            });
        } else {
            res = await fetch(item.url, {
                method: item.method,
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': item.id,
                    ...(item.ifMatch !== undefined ? { 'If-Match': String(item.ifMatch) } : {}),
                },
                body: item.body !== undefined ? JSON.stringify(item.body) : undefined,
            });
        }
        let retryAfter: number | undefined;
        if (res.status === 429) {
            const raw = res.headers.get('Retry-After');
            const parsed = raw ? Number.parseInt(raw, 10) : NaN;
            if (Number.isFinite(parsed) && parsed >= 0) retryAfter = parsed;
        }
        // A 409 STALE_DATA carries the server's current state — keep it for the
        // conflict-resolution UI (take-server needs it).
        let conflict: unknown;
        if (res.status === 409) {
            conflict = await res.json().catch(() => undefined);
        }
        return { ok: res.ok, status: res.status, retryAfter, conflict };
    };
}
