/**
 * Offline sync — the "replay" half of queue-and-sync.
 *
 * `flushOutbox` drains the outbox in FIFO order, handing each item to a
 * `Sender` (the real one POSTs/PATCHes via fetch). The retry policy is
 * the crux:
 *   - 2xx success            → remove (delivered).
 *   - 4xx (except 401/403/
 *     408/409/429)           → PARK as `refused`. A client error won't
 *                              succeed on retry, but destroying the write to
 *                              keep the queue moving made a refused write and
 *                              a delivered one indistinguishable — the same
 *                              two calls, receipt included. A parked item is
 *                              skipped by the loop, so the queue keeps moving
 *                              without the work being destroyed to achieve it
 *                              (#923). This line said DROP until then.
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
 * Items past `MAX_ATTEMPTS` (genuine transient failures only) are PARKED, not
 * dropped: they take `blocked: 'exhausted'` and stop being retried, so a
 * poison item can't block the queue forever without the work being destroyed
 * to achieve it. The same item id rides every retry, so a server that dedupes
 * on it sees at-least-once delivery as exactly-once.
 */
import { isPhotoItem, outboxHeaders, type OutboxItem, type OutboxStore } from './outbox';
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
    /**
     * DEAD since #923 and kept at 0 so the shape does not churn. It used to
     * count writes this drain DESTROYED on a terminal 4xx — and it was the
     * only thing distinguishing a destroyed write from a delivered one, while
     * nothing in `src/` ever read it and every `flush()` call site is
     * `void flush()`. Those writes are parked as `refused` now.
     */
    dropped: number;
    /** Writes the server refused with a terminal 4xx, parked for the operator. */
    refused: number;
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
    /**
     * The server answered 426: this BUILD is below the client-version floor.
     * Retained, not parked — it clears when the app updates, with no operator
     * action, so it must never reach the terminal `refused` state.
     */
    clientTooOld: boolean;
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
/**
 * Write a park back to the queue ONLY if the row is still there.
 *
 * Every store write in this file is an UPSERT — `IndexedDbOutboxStore.update`
 * delegates to `add`, which is `put` on `keyPath: 'id'`, and the service
 * worker's `idbWrite(db, 'put', …)` is the same. So an unguarded park RESURRECTS
 * a row that a concurrent drain already delivered and removed: the page sender
 * and the service worker's background sync replay the SAME queue, which is the
 * race `lockTaskStatusRow` exists for. The resurrected copy would then sit
 * permanently blocked, describing a write that is on the server.
 *
 * The 409 arm has had this guard since it was written; the auth, exhausted and
 * (as of #923) refused arms did not, which mattered much more once a park
 * became the terminal outcome for a 4xx rather than a deletion.
 *
 * Returns whether the park was actually written, so counters only count rows
 * that exist.
 */
async function parkIfStillQueued(
    store: OutboxStore,
    item: OutboxItem,
    patch: Partial<OutboxItem>,
): Promise<boolean> {
    const stillQueued = (await store.all()).some((i) => i.id === item.id);
    if (!stillQueued) return false;
    await store.update({ ...item, ...patch } as OutboxItem);
    return true;
}

/**
 * Clear the `auth` park for items belonging to a VERIFIED operator (#930).
 *
 * A 401/403 parks an item `blocked: 'auth'` and stops the pass, because the
 * server refused the SESSION rather than the work. Nothing in the codebase then
 * cleared that flag — so signing back in did not resume the queue, and the only
 * exit was the operator noticing on a diagnostics page they have no reason to
 * open. A one-way door for work that exists nowhere else.
 *
 * ## Why the identity is a parameter, and must be SERVER-verified
 *
 * Not read here, deliberately. The page's own `getCurrentUserId()` is fed from
 * the server-rendered layout, so it belongs to the DOCUMENT — and `public/sw.js`
 * replays cached documents, so on a shared phone the shell fallback can hand
 * operator B a page rendered for A. Unblocking on that value would hand A's
 * queue to B. The caller passes the result of the whoami probe (#946) or
 * nothing happens.
 *
 * ## Why only the operator's OWN items
 *
 * An item with a DIFFERENT `queuedByUserId` stays parked: it is not this
 * operator's to send, and `flushOutbox` would skip it anyway.
 *
 * An item with NO `queuedByUserId` also stays parked, and that is a product
 * decision rather than an oversight. Those predate attribution
 * (`outbox.ts` documents them), so unblocking them would let an unattributed
 * БАБХ record replay under whoever signed in next — permanently, into a
 * hash-chained audit trail AND `OperationParcel.completedByUserId`, a domain
 * column. The owner chose to leave them parked and make them VISIBLE instead:
 * `OutboxSnapshot.blockedAuthUnclaimable` counts them so they stop being
 * invisible, which is the half that makes leaving them parked honest.
 *
 * ## Why the still-queued re-read
 *
 * `store.update` is an UPSERT (`put` on `keyPath: 'id'`), and the page and the
 * service worker drain the same queue. Writing an item back without checking it
 * is still there RESURRECTS a row the other drain already delivered — the same
 * reason `parkIfStillQueued` exists.
 *
 * Returns how many parks were cleared, so a caller can skip a pointless flush.
 */
export async function unblockAuthParks(
    store: OutboxStore,
    verifiedUserId: string,
): Promise<number> {
    if (!verifiedUserId) return 0;
    let cleared = 0;
    for (const item of await store.all()) {
        if (item.blocked !== 'auth') continue; // never touch exhausted or refused
        if (item.queuedByUserId !== verifiedUserId) continue;
        const stillQueued = (await store.all()).some((i) => i.id === item.id);
        if (!stillQueued) continue;
        const next = { ...item };
        delete next.blocked;
        await store.update(next);
        cleared++;
    }
    return cleared;
}

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
    let refused = 0;
    let foreign = 0;
    let conflicts = 0;
    let rateLimited = false;
    let clientTooOld = false;
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
        // CURRENT session cookie, so sending it attributes the write to the
        // wrong person — in a hash-chained audit trail AND, for the field
        // operations this queue carries, in `OperationParcel.completedByUserId`,
        // a permanent domain column on a БАБХ compliance record.
        //
        // If the tenants differ it earns a 403 instead, which is parked
        // `blocked: 'auth'` a few arms below and stops the pass.
        //
        // This comment used to justify the skip by saying that 403 would reach
        // the terminal-4xx branch and be REMOVED. Both halves stopped being
        // true at #923: a 403 never reaches that branch, and the branch no
        // longer removes anything — it parks. The skip is still right, and the
        // reason is the mis-attribution above, not a deletion that cannot
        // happen. Corrected rather than deleted because the removal story is
        // exactly the kind of thing a reader would act on.
        //
        // So: skip, never send, never drop. It waits for its owner.
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
        } else if (res.status === 426) {
            // The BUILD is too old, not the work. `src/middleware.ts` answers
            // any API route below the client-version floor with 426 before the
            // handler runs, so it says nothing about this payload — and every
            // remaining item would meet the same answer.
            //
            // Environmental like a 429, so treated like one: retain untouched,
            // no attempt spent, and stop the pass. It clears when the app
            // updates, with no operator action.
            //
            // Deliberately NOT a park. `blocked: 'refused'` is terminal and
            // nothing in the codebase clears a blocked flag on its own, so
            // parking here would put the WHOLE queue behind a per-item discard
            // the operator would have to tap for work that was never refused —
            // the one-way door #930 exists to close, opened for a condition
            // that resolves itself.
            clientTooOld = true;
            break;
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
            if (await parkIfStillQueued(store, item, { blocked: 'auth' })) blocked++;
            authBlocked = true;
            break;
        } else if (isTransient(res.status)) {
            const next = { ...item, attempts: item.attempts + 1 };
            if (next.attempts >= MAX_ATTEMPTS) {
                // Park, never delete. The poison-item escape is that it stops
                // being retried, not that the work is destroyed.
                if (await parkIfStillQueued(store, next, { blocked: 'exhausted' })) blocked++;
            } else {
                if (await parkIfStillQueued(store, next, {})) failed++;
            }
        } else {
            // REFUSED — genuinely terminal for THIS item (a 4xx about the
            // payload). Parked, not destroyed (#923).
            //
            // This arm used to call `noteDelivered()` then `store.remove()` —
            // byte for byte the two calls the SUCCESS arm makes twenty lines
            // up. A destroyed compliance write and a delivered one therefore
            // left an identical trace on the device: queue row gone, receipt
            // written, `pending` back to zero. The receipt is specifically
            // what stops the loss detector reporting the removal, so the
            // destruction was not merely unreported, it was suppressed. The
            // only thing that differed was a `dropped` counter, and nothing in
            // `src/` reads it — every `flush()` call site is `void flush()`.
            //
            // A terminal 4xx now means what it says: the work is NOT on the
            // server. That became true only with the already-applied arm in
            // `setTaskStatus` (this PR) — before it, the commonest 400 here
            // was a replay whose write had ALREADY landed, and parking that
            // one would tell an operator to re-enter a record that exists.
            if (await parkIfStillQueued(store, item, { blocked: 'refused', refusedStatus: res.status })) {
                refused++;
            }
        }
    }

    const remaining = (await store.all()).length;
    return { sent, failed, dropped, refused, foreign, blocked, authBlocked, conflicts, remaining, rateLimited, clientTooOld, retryAfterSeconds };
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
                headers: outboxHeaders({ id: item.id, photo: true }),
                body: fd,
            });
        } else {
            res = await fetch(item.url, {
                method: item.method,
                headers: outboxHeaders({ id: item.id, ifMatch: item.ifMatch }),
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
