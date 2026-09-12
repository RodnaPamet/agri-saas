'use client';

/**
 * useOfflineSync — the operator PWA's offline mutation primitive.
 *
 * `submit` tries the network first when online; on a network failure or
 * when offline it appends the mutation to the outbox and returns
 * 'queued'. A terminal 4xx is thrown so the caller can surface it — the
 * operation will never succeed, so queueing it would be a lie.
 *
 * The queue COUNTS are not owned here: they live in `outbox-state.ts` at
 * module scope, so they survive navigation and every mounted surface reads
 * the same numbers. This hook re-reads the queue on mount and drains it on
 * three signals — the `online` event, a foreground return
 * (`visibilitychange` / `pageshow`), and an explicit `flush()`.
 */
import { useCallback, useEffect, useState, useRef, useSyncExternalStore } from 'react';
import {
    getOutboxStore,
    enqueue,
    enqueuePhoto,
    newOutboxId,
    outboxHeaders,
    type EnqueueInput,
    type EnqueuePhotoInput,
    type OutboxItem,
} from './outbox';
import { indexedDbAvailable } from './idb-outbox';
import { getCurrentUserId } from './current-user';
import { flushOutbox, fetchSender, type FlushSummary } from './sync';
import {
    acknowledgeLoss,
    getOutboxSnapshot,
    getServerOutboxSnapshot,
    noteWorkQueued,
    refreshOutboxState,
    runExclusiveFlush,
    subscribeToOutbox,
} from './outbox-state';
import type { DurabilityVerdict, LostWorkRecord } from './durability';
import { haptic } from '@/lib/haptics';

function isTerminalClientError(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Pull the server's current version out of a parked 409 body.
 *
 * The API envelope nests it — `withApiErrorHandling` serialises a DomainError
 * as `{ error: { code, message, details } }`, which is the shape
 * `api-client.ts:137` reads (`body.error.details`) — and `staleData(msg, {
 * currentVersion, expectedVersion })` puts the number in `details`. This used
 * to read `server.currentVersion`, one level too shallow, so it was ALWAYS
 * undefined and keep-mine re-sent with no `If-Match` at all: the retry became
 * a blind overwrite that could also clobber a THIRD edit landing between the
 * conflict and the operator's decision. Nothing caught it because keep-mine's
 * intent is to overwrite, so the wrong path produced the expected outcome in
 * every case but that one.
 *
 * The flat shape is still accepted: `sync.ts` stores whatever the body parsed
 * to, and a future endpoint may answer unwrapped.
 */
function readCurrentVersion(server: unknown): number | undefined {
    if (typeof server !== 'object' || server === null) return undefined;
    const flat = (server as { currentVersion?: unknown }).currentVersion;
    if (typeof flat === 'number') return flat;
    const details = (server as { error?: { details?: unknown } }).error?.details;
    if (typeof details !== 'object' || details === null) return undefined;
    const nested = (details as { currentVersion?: unknown }).currentVersion;
    return typeof nested === 'number' ? nested : undefined;
}

/** Shared with public/sw.js — the Background Sync tag that triggers a replay. */
export const FLUSH_OUTBOX_SYNC_TAG = 'flush-outbox';

/**
 * Ask the service worker to flush the outbox when connectivity returns —
 * even if the app has been closed. Progressive enhancement:
 *   - Background Sync API present (Android/Chrome) → register the
 *     'flush-outbox' tag; the SW's `sync` handler replays from IndexedDB.
 *   - Not present (iOS Safari, Firefox) → no-op here; the page-side
 *     `online`-event flush already covers reconnect-while-open.
 * Always best-effort — a failure here is swallowed so queueing never breaks.
 */
async function registerOutboxSync(): Promise<void> {
    try {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
        const reg = await navigator.serviceWorker.ready;
        const sync = (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
        if (sync) await sync.register(FLUSH_OUTBOX_SYNC_TAG);
    } catch {
        /* Background Sync unavailable / denied — fall back to online-event flush. */
    }
}

export type ConflictResolution = 'keep-mine' | 'take-server';

export interface OfflineSync {
    online: boolean;
    /** Queued items (mutations + photos) still waiting to send — excludes parked conflicts. */
    pending: number;
    /** Queued PHOTO uploads only — surfaced distinctly in the sync bar. */
    pendingPhotos: number;
    /**
     * `'sent'` — the server has it. `'queued'` — durably queued and the drain
     * WILL retry it. `'conflict'` — the server REFUSED it (409) and it is
     * parked awaiting keep-mine / take-server; `flushOutbox` skips a parked
     * item forever, so a caller that renders 'conflict' as an ordinary close
     * is telling the operator their write is on its way when nothing will
     * ever send it. That third state exists because until #921 the 409 arm
     * returned 'queued', and `pending` excludes conflicts — so a refused
     * journal edit closed the modal like a success and vanished.
     */
    submit: (input: EnqueueInput) => Promise<'sent' | 'queued' | 'conflict'>;
    /**
     * Queue (or send-then-queue) a photo upload. The blob is the ALREADY
     * downscaled bytes; oversized blobs reject at enqueue. Requires
     * IndexedDB (the only store that can hold a Blob) — throws otherwise so
     * the caller can fall back to a direct online-only upload.
     */
    submitPhoto: (input: EnqueuePhotoInput) => Promise<'sent' | 'queued'>;
    flush: () => Promise<FlushSummary>;
    /** Writes parked as 409 conflicts, awaiting keep-mine / take-server. */
    conflicts: OutboxItem[];
    /**
     * Writes the server REFUSED with a terminal 4xx, parked instead of
     * destroyed (#923). Items rather than a count: the operator has to read
     * WHAT was refused before deciding, and a bare number names nothing.
     */
    refused: OutboxItem[];
    /**
     * Discard one refused write, on an explicit operator action only.
     *
     * Nothing else clears a `refused` park — deliberately. A refusal means the
     * work is NOT on the server, so removing it without a person deciding is
     * the destruction #923 exists to stop.
     */
    discardRefused: (id: string) => Promise<void>;
    /**
     * Resolve a parked conflict: `take-server` discards the queued edit;
     * `keep-mine` re-sends it at the server's current version so it wins.
     */
    resolveConflict: (id: string, resolution: ConflictResolution) => Promise<void>;
    /**
     * Work that was queued on this phone and then disappeared without being
     * delivered — the phone evicted it, or website data was cleared. Sticky
     * until `acknowledgeLostWork()`; NEVER cleared by a successful sync.
     */
    lost: LostWorkRecord | null;
    /** Dismiss the lost-work record. Only an operator action may call this. */
    acknowledgeLostWork: () => void;
    /** What `navigator.storage` said about this origin's durability. */
    durability: DurabilityVerdict | null;
    /** True when the queue has grown past the point of routine. */
    queueGrowing: boolean;
    /**
     * Work queued on this device by another operator. Held, never sent under
     * this session and never dropped — surfaced so it is not invisible.
     */
    foreign: number;
}

export function useOfflineSync(): OfflineSync {
    // ONE queue truth for the whole app (see outbox-state.ts). Five surfaces
    // mount this hook; before it was hoisted, each held its own count, so the
    // pending badge disappeared the moment an operator navigated away from
    // the page that happened to own it.
    const snapshot = useSyncExternalStore(
        subscribeToOutbox,
        getOutboxSnapshot,
        getServerOutboxSnapshot,
    );
    const { pending, pendingPhotos, conflicts, refused, lost, durability, queueGrowing, foreign } = snapshot;
    const [online, setOnline] = useState(true);
    // Honors a 429 Retry-After: schedule the next drain instead of hammering.
    const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flushRef = useRef<(() => Promise<FlushSummary>) | null>(null);

    const refresh = useCallback(async () => {
        await refreshOutboxState();
    }, []);

    const flush = useCallback(async (): Promise<FlushSummary> => {
        // The lock is MODULE-scoped, not per-instance: two mounted surfaces
        // draining at once would read the same items and send each twice.
        const res = await runExclusiveFlush(async () => {
            const summary = await flushOutbox(getOutboxStore(), fetchSender(), getCurrentUserId());
            // Refresh pending + the photo sub-count + conflicts — a flush can
            // drain photos/mutations AND park a 409 the resolution UI must show.
            await refresh();
            return summary;
        });
        if (res === null) {
            const remaining = (await getOutboxStore().all()).length;
            return { sent: 0, failed: 0, dropped: 0, refused: 0, foreign: 0, blocked: 0, authBlocked: false, conflicts: 0, remaining, rateLimited: false };
        }
        // Rate-limited mid-burst with work still queued → back off for the
        // server's Retry-After (default one mutation window) and re-drain,
        // rather than waiting for the next reconnect that may never come.
        if (res.rateLimited && res.remaining > 0) {
            const backoffMs = Math.max(1, res.retryAfterSeconds ?? 60) * 1000;
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => {
                void flushRef.current?.();
            }, backoffMs);
        }
        return res;
    }, [refresh]);
    flushRef.current = flush;

    useEffect(() => {
        // Hydration-safe: `online` initialises to true (matching SSR) and
        // is synced to the real navigator.onLine here, post-mount — a lazy
        // useState initializer would read navigator on the client's first
        // render and mismatch the server's markup when offline.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional post-mount sync (see above)
        setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
        void refresh();
        const onOnline = () => {
            setOnline(true);
            void flush();
        };
        const onOffline = () => setOnline(false);
        // FOREGROUND FLUSH. The `online` event is not enough on a phone.
        // iOS SUSPENDS a backgrounded PWA rather than unloading it: an
        // operator who queues work in a dead-signal field, pockets the phone,
        // and drives back into coverage gets no `online` event (the
        // transition happened while the page was frozen) and no remount. The
        // queue would then sit untouched until they happened to open one of
        // the surfaces that mounts this hook — and every extra hour queued is
        // another chance for the phone to evict it. iOS also has no
        // Background Sync, so nothing else covers this.
        //
        // `pageshow` catches the bfcache restore that fires no
        // `visibilitychange`. Both are cheap: `flush` no-ops on an empty
        // queue and the module-scoped lock collapses a double-fire.
        const onForeground = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
            void refresh();
            void flush();
        };
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        document.addEventListener('visibilitychange', onForeground);
        window.addEventListener('pageshow', onForeground);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            document.removeEventListener('visibilitychange', onForeground);
            window.removeEventListener('pageshow', onForeground);
            if (retryTimer.current) clearTimeout(retryTimer.current);
        };
    }, [flush, refresh]);

    const submit = useCallback(
        async (input: EnqueueInput): Promise<'sent' | 'queued' | 'conflict'> => {
            const offline = typeof navigator !== 'undefined' && !navigator.onLine;
            const store = getOutboxStore();
            // #924 — minted HERE, before the first attempt, and reused by every
            // enqueue below so the attempt that may already have reached the
            // server and its replays carry ONE Idempotency-Key.
            //
            // Minting inside `enqueue` (where it used to happen) made the fix
            // impossible: the id came into existence only after the decision to
            // queue, so the first attempt had nothing to send. A response lost
            // after the server committed then re-queued under an id the server
            // had never seen, and the write landed twice — two rows, every
            // time, on all three CREATE routes.
            const id = newOutboxId();
            let enqueued = false;
            if (!offline) {
                try {
                    const res = await fetch(input.url, {
                        method: input.method,
                        headers: outboxHeaders({ id, ifMatch: input.ifMatch }),
                        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
                    });
                    if (res.ok) return 'sent';
                    if (res.status === 409) {
                        // Optimistic-lock conflict even while online (a concurrent
                        // edit landed first). Park it for the resolution UI rather
                        // than throwing — keep-mine / take-server, same as a replay.
                        //
                        // Returns 'conflict', NOT 'queued'. A parked item is skipped
                        // by every drain until an operator resolves it, so the two
                        // outcomes have opposite futures and must not share an
                        // observable — the caller has to be able to say so on screen.
                        const server = await res.json().catch(() => undefined);
                        const item = await enqueue(store, input, id);
                        enqueued = true;
                        await store.update({ ...item, conflict: { status: 409, server } });
                        await refresh();
                        return 'conflict';
                    }
                    if (isTerminalClientError(res.status)) {
                        throw new Error(`Request failed (${res.status})`);
                    }
                    // transient (5xx/408/429) → fall through to queue
                } catch (err) {
                    // A thrown terminal error propagates; a network throw queues.
                    if (err instanceof Error && err.message.startsWith('Request failed (4')) throw err;
                }
            }
            // `enqueued` guards a path that only exists because the id is now
            // shared. The 409 arm's enqueue / store.update / refresh all sit
            // inside the `try`, and the catch rethrows only "Request failed
            // (4…)" — so a throw from `update` or `refresh` used to fall
            // through to here and enqueue AGAIN. With a fresh id that produced
            // a duplicate row; with the shared id it is worse, because
            // `store.add` is an UPSERT: the clean item would overwrite the
            // parked conflict in place and return 'queued', re-creating the
            // exact silent-loss shape #922 fixed.
            if (!enqueued) await enqueue(store, input, id);
            await refresh();
            // First queued item is the moment to ask the browser to keep this
            // origin's storage — meaningful engagement, and self-explanatory
            // if the browser prompts. See durability.ts.
            void noteWorkQueued();
            // Tactile confirmation that the action was saved offline (gloves +
            // no signal) — capability-gated, no-op on desktop/reduced-motion.
            haptic('tap');
            // First failure → ask the SW to replay when the network returns,
            // even if the operator closes the app (Background Sync).
            void registerOutboxSync();
            return 'queued';
        },
        [refresh],
    );

    const submitPhoto = useCallback(
        async (input: EnqueuePhotoInput): Promise<'sent' | 'queued'> => {
            // A Blob can only be queued in IndexedDB — the localStorage/
            // in-memory fallbacks would JSON-serialise it to `{}`. If IDB is
            // unavailable, throw so the caller can attempt a direct upload
            // instead of silently dropping the photo.
            if (!indexedDbAvailable()) {
                throw new Error('offline photo queue unavailable (no IndexedDB)');
            }
            const offline = typeof navigator !== 'undefined' && !navigator.onLine;
            // Same mint-before-attempt as `submit`. A photo is the artefact
            // most likely to be re-sent on flaky signal, and the replay sender
            // has always carried the handle — this attempt sent NO headers at
            // all, so a lost response attached the same photo twice.
            const id = newOutboxId();
            if (!offline) {
                try {
                    const fd = new FormData();
                    fd.append('file', new File([input.blob], input.fileName, { type: input.fileType }));
                    const res = await fetch(input.url, {
                        method: 'POST',
                        headers: outboxHeaders({ id, photo: true }),
                        body: fd,
                    });
                    if (res.ok) return 'sent';
                    if (isTerminalClientError(res.status)) {
                        throw new Error(`Request failed (${res.status})`);
                    }
                    // transient (5xx/408/429) → fall through to queue
                } catch (err) {
                    if (err instanceof Error && err.message.startsWith('Request failed (4')) throw err;
                }
            }
            // Enforces MAX_QUEUED_PHOTO_BYTES — an oversized blob throws here.
            await enqueuePhoto(getOutboxStore(), input, id);
            await refresh();
            void noteWorkQueued();
            haptic('tap');
            void registerOutboxSync();
            return 'queued';
        },
        [refresh],
    );

    const resolveConflict = useCallback(
        async (id: string, resolution: ConflictResolution) => {
            const store = getOutboxStore();
            const item = (await store.all()).find((i) => i.id === id);
            if (!item) {
                await refresh();
                return;
            }
            if (resolution === 'take-server') {
                // Discard the queued edit — the server's version wins.
                await store.remove(id);
            } else {
                // keep-mine — re-send at the server's CURRENT version so the
                // write is accepted (version matches) and the operator's edit
                // overwrites, deliberately this time.
                const server = item.conflict?.server;
                const retry: OutboxItem = {
                    ...item,
                    ifMatch: readCurrentVersion(server),
                    conflict: undefined,
                };
                const res = await fetchSender()(retry);
                if (res.ok) {
                    await store.remove(id);
                } else {
                    // Still conflicting (raced again) — re-park with fresh state.
                    await store.update({ ...retry, conflict: { status: res.status, server: res.conflict ?? server } });
                }
            }
            await refresh();
        },
        [refresh],
    );

    /**
     * Remove one refused write, on an explicit operator action.
     *
     * Removes and `refresh()`es in the SAME call, so it re-mirrors the manifest
     * itself and writes no delivery receipt — the documented exception
     * `resolveConflict` already relies on. A receipt means "deliberately
     * removed" and is what stops the loss detector crying eviction; a removal
     * this function performs is followed immediately by the refresh that
     * rewrites the manifest, so there is nothing left over to explain.
     *
     * Guarded on `blocked === 'refused'`: this must never become a way to
     * delete a still-deliverable item.
     */
    const discardRefused = useCallback(
        async (id: string) => {
            const store = getOutboxStore();
            const item = (await store.all()).find((i) => i.id === id);
            if (!item || item.blocked !== 'refused') {
                await refresh();
                return;
            }
            await store.remove(id);
            await refresh();
        },
        [refresh],
    );

    return {
        online,
        pending,
        pendingPhotos,
        submit,
        submitPhoto,
        flush,
        conflicts,
        resolveConflict,
        refused,
        discardRefused,
        lost,
        acknowledgeLostWork: acknowledgeLoss,
        durability,
        queueGrowing,
        foreign,
    };
}
