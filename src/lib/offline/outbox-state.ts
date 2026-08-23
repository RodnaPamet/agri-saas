/**
 * Outbox state — ONE truth about queued work, shared by every surface.
 *
 * ## Why this module exists
 *
 * `useOfflineSync` is mounted independently by five surfaces. Each instance
 * used to hold its own `pending` count and its own flush lock, which meant
 * two things went wrong at once: the count was only visible on the page that
 * happened to mount the hook (queue a journal entry, navigate to the map, and
 * the pending work vanishes from the screen while staying very much queued),
 * and two mounted instances could drain the queue concurrently because the
 * "already flushing" guard was per-instance.
 *
 * Module scope survives client-side navigation, so hoisting the counts, the
 * flush lock and the durability bookkeeping here fixes both. Hook instances
 * become subscribers to a single snapshot.
 *
 * ## The three states an operator must be able to tell apart
 *
 * Before this, there were two: "N queued" and everything else. Absence of a
 * count meant BOTH "delivered" and "the phone deleted it", which is precisely
 * the ambiguity that makes a lost-work bug invisible.
 *
 *   - `pending > 0`      → saved on this phone, NOT on the server.
 *   - `pending === 0`    → the server has it.
 *   - `lost !== null`    → work was queued and is gone. Sticky, survives
 *                          reload, and clears ONLY on an explicit
 *                          acknowledgement (see `durability.ts`).
 */
import { getCurrentUserId } from './current-user';
import {
    getOutboxStore,
    isPhotoItem,
    type OutboxItem,
    type OutboxStore,
} from './outbox';
import {
    backgroundSyncPossible,
    readDurabilityVerdict,
    readLostWork,
    recordLostWork,
    reconcileManifest,
    requestPersistence,
    writeManifest,
    acknowledgeLostWork,
    type DurabilityVerdict,
    type LostWorkRecord,
    type ManifestEntry,
} from './durability';

/**
 * Queue size at which the app starts telling the operator to get to signal.
 *
 * Not a hard cap — refusing to queue work in a field with no signal would
 * lose the very thing the outbox exists to protect. It is the point at which
 * "you have unsent work" stops being routine: past this many items the queue
 * has been accumulating across sessions, and every extra hour is another
 * chance for the phone to evict it.
 */
export const QUEUE_WARNING_THRESHOLD = 15;

export interface OutboxSnapshot {
    /** Queued items still waiting to send — excludes parked conflicts. */
    pending: number;
    /** Subset of `pending` that are photo uploads. */
    pendingPhotos: number;
    /** Writes parked as 409 conflicts, awaiting operator resolution. */
    conflicts: OutboxItem[];
    /** Non-null when work was queued and then disappeared undelivered. */
    lost: LostWorkRecord | null;
    /** What `navigator.storage` last said about this origin. */
    durability: DurabilityVerdict | null;
    /** True when `pending` has passed {@link QUEUE_WARNING_THRESHOLD}. */
    queueGrowing: boolean;
    /**
     * Items queued on this device by a DIFFERENT operator. They are never
     * sent under the current session (wrong attribution, or a 403 that would
     * destroy them) and never dropped — so they must be VISIBLE, or they are
     * work that sits on a phone with nobody knowing it is there.
     */
    foreign: number;
}

const EMPTY: OutboxSnapshot = {
    pending: 0,
    pendingPhotos: 0,
    conflicts: [],
    lost: null,
    durability: null,
    queueGrowing: false,
    foreign: 0,
};

let snapshot: OutboxSnapshot = EMPTY;
const listeners = new Set<() => void>();

/** Startup reconciliation runs once per page load, before anything drains. */
let reconciled = false;
/** `persist()` is asked for once per page load, at first enqueue. */
let persistenceRequested = false;
/** Shared across every hook instance — two surfaces must not double-drain. */
let flushing = false;

function emit(next: OutboxSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

/** Subscribe to snapshot changes; returns the unsubscribe function. */
export function subscribeToOutbox(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Current snapshot. Stable identity between changes, so it is safe as a
 * `useSyncExternalStore` getSnapshot.
 */
export function getOutboxSnapshot(): OutboxSnapshot {
    return snapshot;
}

/** SSR snapshot — the server has no queue and must render the empty state. */
export function getServerOutboxSnapshot(): OutboxSnapshot {
    return EMPTY;
}

function toManifestEntry(item: OutboxItem): ManifestEntry {
    return { id: item.id, label: item.label, createdAt: item.createdAt };
}

/**
 * Re-read the queue and republish the snapshot.
 *
 * Also the place both loss detectors run, because both need the queue as it
 * actually is right now:
 *
 *  - **In-session** (`store.wasRecreated()`): the database was destroyed
 *    while the app was open. Everything the manifest still lists is gone.
 *  - **Cross-session** (`reconcileManifest`): on the FIRST refresh of a page
 *    load, entries the manifest lists but the queue no longer holds went
 *    missing while the app was closed.
 */
export async function refreshOutboxState(
    store: OutboxStore = getOutboxStore(),
): Promise<OutboxSnapshot> {
    let all: OutboxItem[];
    try {
        all = await store.all();
    } catch {
        // A store that cannot be read is not a store that is empty. Hold the
        // last known snapshot rather than publishing a reassuring zero.
        return snapshot;
    }

    const queuedIds = all.map((i) => i.id);
    let lost = readLostWork();

    // In-session eviction: exact, and reported on every platform.
    if (store.wasRecreated?.()) {
        const missing = reconcileManifest(queuedIds, /* backgroundSyncPossible */ false);
        if (missing.length > 0) lost = recordLostWork(missing, 'storage-evicted');
    } else if (!reconciled) {
        // Cross-session: only meaningful where the service worker could not
        // have drained the queue behind our back. See `reconcileManifest`.
        const missing = reconcileManifest(queuedIds, backgroundSyncPossible());
        if (missing.length > 0) lost = recordLostWork(missing, 'queue-vanished-while-closed');
    }
    reconciled = true;

    // The manifest mirrors the queue, so anything removed on purpose leaves
    // it in the same pass and only an unexplained disappearance is left over.
    writeManifest(all.map(toManifestEntry));

    const owner = getCurrentUserId();
    const isForeign = (i: OutboxItem) =>
        Boolean(owner && i.queuedByUserId && i.queuedByUserId !== owner);
    const live = all.filter((i) => !i.conflict && !isForeign(i));
    emit({
        foreign: all.filter(isForeign).length,
        pending: live.length,
        pendingPhotos: live.filter(isPhotoItem).length,
        conflicts: all.filter((i) => i.conflict),
        lost,
        durability: readDurabilityVerdict(),
        queueGrowing: live.length >= QUEUE_WARNING_THRESHOLD,
    });
    return snapshot;
}

/**
 * Called right after an item is queued. Asks for persistent storage the first
 * time — this is the "meaningful engagement" moment `requestPersistence`
 * documents, and the only moment at which the request is self-explanatory.
 */
export async function noteWorkQueued(): Promise<void> {
    if (persistenceRequested) return;
    persistenceRequested = true;
    try {
        await requestPersistence();
    } catch {
        /* recorded as a refusal inside; never let it break queueing */
    }
    // Republish so the verdict reaches the UI on THIS queue, not the next
    // one — "the phone did not agree to keep this" is worth most at the
    // moment the operator has just saved something they cannot resend.
    emit({ ...snapshot, durability: readDurabilityVerdict() });
}

/**
 * Run a flush under the SHARED lock. Returns `null` when another surface is
 * already draining, so the caller can report "nothing to do" rather than
 * sending every queued item a second time.
 */
export async function runExclusiveFlush<T>(run: () => Promise<T>): Promise<T | null> {
    if (flushing) return null;
    flushing = true;
    try {
        return await run();
    } finally {
        flushing = false;
    }
}

/**
 * The service worker drained the queue behind our back.
 *
 * `public/sw.js` posts `outbox-flushed` after every pass so an open page can
 * re-read the queue — its comment has said so since the worker was written,
 * while nothing on this side listened. Without it the count stays at whatever
 * the last page-side refresh saw, so the UI goes on reporting work as "saved
 * on this phone" after it has reached the server.
 *
 * Refresh only. This deliberately does NOT flush: the worker just did, and a
 * flush here would race the drain it is reporting.
 */
export async function noteOutboxDrainedElsewhere(
    store: OutboxStore = getOutboxStore(),
): Promise<OutboxSnapshot> {
    // Never let THIS be the first refresh of a page load.
    //
    // `refreshOutboxState` runs the cross-session detector on its first pass,
    // and where Background Sync is absent (iOS Safari, Firefox — where the
    // worker still drains, via the page's own `flush-outbox` nudge)
    // `reconcileManifest` reads every manifest gap as loss. A worker drain
    // produces exactly that gap: it removed items it DELIVERED, and being a
    // worker it cannot write localStorage, so it left no receipt. Running the
    // detector here would record a STICKY "unsent work was deleted" for work
    // that had just landed — additive, and clearing only on an explicit
    // operator acknowledgement, so a later success cannot undo it.
    //
    // Skipping costs nothing. This message exists to refresh a VISIBLE pending
    // count, and that count is only rendered where `useOfflineSync` is mounted
    // — which is also what sets `reconciled`. The registrar sits in the ROOT
    // layout, so on a non-tenant route there is no counter to update and no
    // baseline to reconcile against.
    if (!reconciled) return snapshot;
    return refreshOutboxState(store);
}

/**
 * The service worker found the outbox database rebuilt underneath us.
 *
 * `indexedDB.open` cannot open without creating, so whichever of the two
 * openers reaches a destroyed database first consumes its one `upgradeneeded`
 * event. When that is the worker, this is how the signal crosses back to the
 * only side that can tell the operator. Kept here so the raw store stays
 * behind the single seam this module owns.
 */
export async function noteOutboxRecreatedElsewhere(
    store: OutboxStore = getOutboxStore(),
): Promise<OutboxSnapshot> {
    store.markRecreated?.();
    return refreshOutboxState(store);
}

/** Clear the lost-work record after the operator has actually seen it. */
export function acknowledgeLoss(): void {
    acknowledgeLostWork();
    emit({ ...snapshot, lost: null });
}

/** Test seam — resets module state between cases. */
export function __resetOutboxStateForTests(): void {
    snapshot = EMPTY;
    listeners.clear();
    reconciled = false;
    persistenceRequested = false;
    flushing = false;
}
