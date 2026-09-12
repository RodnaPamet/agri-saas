/**
 * #936 — a queue we could not OPEN is not a queue that is empty.
 *
 * `refreshOutboxState` catches a store read failure and holds the last known
 * snapshot, "rather than publishing a reassuring zero" — its own words, and the
 * right instinct. But on the FIRST refresh of a page load the last known
 * snapshot IS `EMPTY`, so it published exactly the zero it was written to
 * prevent, and `OfflineSyncBar` rendered `allOnServer` — the strongest of the
 * three states — about a queue it could not open at all.
 *
 * It also suppresses the loss alert: `reconcileManifest` has nothing to
 * reconcile against when the queue cannot be read.
 *
 * Reachable whenever IndexedDB will not open: a private window, a browser
 * blocking site data, a corrupted store, an upgrade that threw.
 *
 * The three-state contract this restores is in CLAUDE.md: `pending > 0` "saved
 * on this phone", `pending === 0` "everything is on the server", `lost !== null`
 * "work was queued and is gone". A fourth state that renders as the second is
 * the defect this codebase keeps producing.
 */
import type { OutboxItem, OutboxStore } from '@/lib/offline/outbox';

/**
 * A FRESH module per test — `everRead` is per-page-load module state, which is
 * precisely what is under test here.
 *
 * Without this the cases pass only because of declaration order: once any test
 * has read the store successfully, `everRead` is true for the rest of the file
 * and the unreadable case can never arise again. That would be a suite whose
 * green depends on nobody reordering it, which is not a property worth having.
 */
async function freshModule() {
    let mod!: typeof import('@/lib/offline/outbox-state');
    await jest.isolateModulesAsync(async () => {
        mod = await import('@/lib/offline/outbox-state');
    });
    return mod;
}

class ThrowingStore implements OutboxStore {
    constructor(private failures = Number.POSITIVE_INFINITY) {}
    items: OutboxItem[] = [];
    async all() {
        if (this.failures > 0) {
            this.failures -= 1;
            throw new DOMException('The database connection is closing.', 'InvalidStateError');
        }
        return [...this.items];
    }
    async add(item: OutboxItem) {
        this.items.push(item);
    }
    async update(item: OutboxItem) {
        this.items = this.items.map((i) => (i.id === item.id ? item : i));
    }
    async remove(id: string) {
        this.items = this.items.filter((i) => i.id !== id);
    }
    async clear() {
        this.items = [];
    }
}

function mutation(id: string): OutboxItem {
    return { id, url: `/${id}`, method: 'PATCH', body: {}, label: 'L', createdAt: 1, attempts: 0 };
}

describe('#936 — an unreadable queue on a cold load', () => {
    it('publishes readable:false rather than a reassuring zero', async () => {
        const { refreshOutboxState, getOutboxSnapshot } = await freshModule();
        await refreshOutboxState(new ThrowingStore());

        const snap = getOutboxSnapshot();
        expect(snap.readable).toBe(false);
        // `pending` is still 0 — there is nothing else it could be. The point
        // is that a surface can now tell WHY, instead of reading the zero as
        // "everything is on the server".
        expect(snap.pending).toBe(0);
    });

    // CONTROL — a readable, genuinely empty queue must still say so, or the
    // fix would replace one wrong answer with another.
    it('CONTROL: a readable EMPTY queue reports readable:true', async () => {
        const { refreshOutboxState, getOutboxSnapshot } = await freshModule();
        await refreshOutboxState(new ThrowingStore(0));
        const snap = getOutboxSnapshot();
        expect(snap.readable).toBe(true);
        expect(snap.pending).toBe(0);
    });

    // CONTROL — a readable queue WITH work is unaffected.
    it('CONTROL: a readable queue with work reports it', async () => {
        const { refreshOutboxState, getOutboxSnapshot } = await freshModule();
        const store = new ThrowingStore(0);
        await store.add(mutation('a'));
        await refreshOutboxState(store);
        const snap = getOutboxSnapshot();
        expect(snap.readable).toBe(true);
        expect(snap.pending).toBe(1);
    });

    it('once a read has succeeded, a LATER failure holds the real snapshot instead', async () => {
        // The original behaviour, and it is correct once there is something to
        // hold: one transient failure must not wipe a known-good count.
        const { refreshOutboxState, getOutboxSnapshot } = await freshModule();
        const store = new ThrowingStore(0);
        await store.add(mutation('a'));
        await refreshOutboxState(store);
        expect(getOutboxSnapshot().pending).toBe(1);

        // Now make the next read throw.
        const flaky = new ThrowingStore(1);
        flaky.items = [mutation('a')];
        await refreshOutboxState(flaky);

        const snap = getOutboxSnapshot();
        expect(snap.pending).toBe(1);
        // Not downgraded to unreadable — we have a real prior reading.
        expect(snap.readable).toBe(true);
    });
});
