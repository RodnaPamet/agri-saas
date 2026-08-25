/**
 * Proof that an item left the queue ON PURPOSE.
 *
 * ## The ambiguity this removes
 *
 * The loss detector works by reconciling the queue against a manifest. An item
 * in the manifest but not in the queue is either *delivered* or *destroyed*,
 * and the queue itself cannot say which — a removal looks identical either way.
 *
 * Until now that was papered over by re-mirroring the manifest in the same pass
 * as the drain, which works only when the PAGE did the draining. The SERVICE
 * WORKER drains the same queue and cannot write localStorage, so a worker drain
 * left the manifest listing items that had in fact arrived — and the next
 * cross-session reconcile read that gap as an eviction and wrote a sticky
 * "unsent work was deleted" for work already on the server.
 *
 * A receipt is written in the same IndexedDB transaction as the deletion, so it
 * exists if and only if the removal was deliberate, by whichever side did it.
 * The page consumes and clears receipts at reconcile time, subtracting them
 * before deciding anything was lost.
 *
 * ## Why IndexedDB and not localStorage
 *
 * It has to be reachable by the service worker, and the worker has no
 * localStorage. It also has to share the queue's fate: if a class-wide eviction
 * takes the queue, the receipts must go too — otherwise a stale receipt would
 * silently excuse a genuine loss. Same store, same sweep, same truth.
 */
import type { OutboxStore } from './outbox';

/** Object store holding delivery receipts, alongside the queue. */
export const RECEIPT_STORE = 'delivered';

/** How long a receipt is useful. Beyond this it is noise the reconcile ignores. */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeliveryReceipt {
    /** The outbox item id this receipt discharges. */
    id: string;
    /** When the removal happened. Used only to age receipts out. */
    at: number;
}

/**
 * Record that `id` was removed deliberately.
 *
 * Never throws: a receipt that cannot be written costs a false loss report,
 * which is bad, but a receipt write that breaks the FLUSH costs the delivery
 * itself, which is worse.
 */
export async function noteDelivered(store: OutboxStore, id: string): Promise<void> {
    try {
        await store.noteDelivered?.(id);
    } catch {
        /* a missing receipt degrades to the old behaviour, never to a crash */
    }
}

/** Read and clear the receipts, oldest-first, dropping anything past its TTL. */
export async function takeDeliveryReceipts(
    store: OutboxStore,
    now: number = Date.now(),
): Promise<string[]> {
    try {
        const all = (await store.takeDelivered?.()) ?? [];
        return all.filter((r) => now - r.at <= RECEIPT_TTL_MS).map((r) => r.id);
    } catch {
        return [];
    }
}
