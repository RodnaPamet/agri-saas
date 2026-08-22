/**
 * The outbox under EVICTION — executing tests for the behaviour STEP 3 of the
 * durability prompt asks for: the queue must not silently drop work, and must
 * not resurrect a partial queue as if it were complete.
 *
 * ## What "gracefully" has to mean here
 *
 * An evicted IndexedDB does not error. `indexedDB.open` cheerfully recreates
 * the database, the object store comes back empty, and `all()` resolves `[]`.
 * That is byte-for-byte the same observation as a queue that drained
 * successfully — which is why the old code reported "0 pending" either way and
 * an operator had no signal at all that work had been deleted.
 *
 * So these tests assert on the DIFFERENCE being visible, in both directions:
 *  - work that vanished is reported, with the labels, and stays reported;
 *  - work that was DELIVERED is not reported as lost.
 *
 * The second half matters as much as the first. A durability warning that
 * fires on a normal successful sync is a warning operators learn to ignore.
 */
import {
    __resetOutboxStateForTests,
    acknowledgeLoss,
    getOutboxSnapshot,
    noteWorkQueued,
    refreshOutboxState,
    runExclusiveFlush,
    subscribeToOutbox,
    QUEUE_WARNING_THRESHOLD,
} from '@/lib/offline/outbox-state';
import { readLostWork, readManifest, writeManifest } from '@/lib/offline/durability';
import type { OutboxItem, OutboxStore, MutationOutboxItem } from '@/lib/offline/outbox';

function installLocalStorage(): Map<string, string> {
    const map = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
            return map.size;
        },
    } as Storage;
    return map;
}

function item(id: string, over: Partial<MutationOutboxItem> = {}): OutboxItem {
    return {
        id,
        url: `/api/t/acme/field-operations/t1/parcels/${id}`,
        method: 'PATCH',
        body: { status: 'DONE' },
        label: over.label ?? `Mark ${id} done`,
        createdAt: over.createdAt ?? 1,
        attempts: 0,
        ...over,
    } as OutboxItem;
}

/**
 * A store whose contents AND recreation signal the test drives directly —
 * standing in for an IndexedDB the phone is free to delete underneath us.
 */
class FakeStore implements OutboxStore {
    items: OutboxItem[] = [];
    recreated = false;
    throwOnRead = false;

    async add(i: OutboxItem) {
        this.items.push(i);
    }
    async all() {
        if (this.throwOnRead) throw new Error('IDB unavailable');
        return [...this.items].sort((a, b) => a.createdAt - b.createdAt);
    }
    async update(i: OutboxItem) {
        this.items = this.items.map((x) => (x.id === i.id ? i : x));
    }
    async remove(id: string) {
        this.items = this.items.filter((x) => x.id !== id);
    }
    wasRecreated() {
        const v = this.recreated;
        this.recreated = false;
        return v;
    }
    /** What an eviction actually looks like: gone, and rebuilt empty. */
    evict() {
        this.items = [];
        this.recreated = true;
    }
}

let store: FakeStore;
beforeEach(() => {
    installLocalStorage();
    __resetOutboxStateForTests();
    store = new FakeStore();
    // Background Sync absent — the iOS case, and the platform the whole
    // investigation is about. `ServiceWorkerRegistration` is undefined under
    // the node test env, which is exactly what the detector reads.
    delete (globalThis as { ServiceWorkerRegistration?: unknown }).ServiceWorkerRegistration;
});

describe('the queue, seen from the app', () => {
    it('reports what is saved on this phone, and mirrors it into the manifest', async () => {
        store.items = [item('a'), item('b')];
        const snap = await refreshOutboxState(store);
        expect(snap.pending).toBe(2);
        expect(snap.lost).toBeNull();
        expect(readManifest().map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('a DELIVERED item leaves the manifest in the same pass — never reported lost', async () => {
        store.items = [item('a'), item('b')];
        await refreshOutboxState(store);
        // A normal successful flush removes the item through the page.
        await store.remove('a');
        const snap = await refreshOutboxState(store);
        expect(snap.pending).toBe(1);
        expect(snap.lost).toBeNull();
        expect(readManifest().map((e) => e.id)).toEqual(['b']);
    });

    it('a fully drained queue says the server has it, with no loss claimed', async () => {
        store.items = [item('a')];
        await refreshOutboxState(store);
        await store.remove('a');
        const snap = await refreshOutboxState(store);
        expect(snap.pending).toBe(0);
        expect(snap.lost).toBeNull();
        expect(readManifest()).toEqual([]);
    });
});

describe('eviction while the app is open', () => {
    it('reports the vanished work, by label, instead of showing an empty queue', async () => {
        store.items = [item('a', { label: 'Mark North 40 done' }), item('b', { label: 'Spray log' })];
        await refreshOutboxState(store);

        store.evict();
        const snap = await refreshOutboxState(store);

        expect(snap.pending).toBe(0);
        expect(snap.lost?.entries.map((e) => e.label)).toEqual(['Mark North 40 done', 'Spray log']);
        expect(snap.lost?.cause).toBe('storage-evicted');
    });

    it('reports a PARTIAL loss exactly — survivors stay pending, not counted as complete', async () => {
        store.items = [item('a'), item('b'), item('c')];
        await refreshOutboxState(store);

        // Eviction that took two of three (a partial rebuild).
        store.items = [item('b')];
        store.recreated = true;
        const snap = await refreshOutboxState(store);

        expect(snap.lost?.entries.map((e) => e.id)).toEqual(['a', 'c']);
        expect(snap.pending).toBe(1);
        expect(readManifest().map((e) => e.id)).toEqual(['b']);
    });

    it('a later SUCCESSFUL sync does NOT clear the loss', async () => {
        // The resurrection failure in one test: work is lost, the rest of the
        // queue then syncs fine, and the app goes back to looking clean. The
        // items in the record are not in that sync and never will be.
        store.items = [item('a'), item('b')];
        await refreshOutboxState(store);
        store.evict();
        await refreshOutboxState(store);

        store.items = [item('later')];
        await refreshOutboxState(store);
        await store.remove('later');
        const snap = await refreshOutboxState(store);

        expect(snap.pending).toBe(0);
        expect(snap.lost?.entries).toHaveLength(2);
    });

    it('the record survives a page reload (module state reset, storage kept)', async () => {
        store.items = [item('a')];
        await refreshOutboxState(store);
        store.evict();
        await refreshOutboxState(store);

        __resetOutboxStateForTests(); // a fresh page load
        const fresh = new FakeStore();
        const snap = await refreshOutboxState(fresh);
        expect(snap.lost?.entries.map((e) => e.id)).toEqual(['a']);
    });

    it('clears only on an explicit acknowledgement, and notifies subscribers', async () => {
        store.items = [item('a')];
        await refreshOutboxState(store);
        store.evict();
        await refreshOutboxState(store);

        const seen: number[] = [];
        const unsubscribe = subscribeToOutbox(() => seen.push(1));
        acknowledgeLoss();
        expect(getOutboxSnapshot().lost).toBeNull();
        expect(readLostWork()).toBeNull();
        expect(seen).toHaveLength(1);
        unsubscribe();
    });
});

describe('eviction while the app was CLOSED', () => {
    it('is detected at startup from the manifest when Background Sync is impossible', async () => {
        writeManifest([
            { id: 'a', label: 'Mark North 40 done', createdAt: 1 },
            { id: 'b', label: 'Spray log', createdAt: 2 },
        ]);
        const snap = await refreshOutboxState(store); // queue comes back empty
        expect(snap.lost?.entries.map((e) => e.id)).toEqual(['a', 'b']);
        expect(snap.lost?.cause).toBe('queue-vanished-while-closed');
    });

    it('stays SILENT where the service worker could have delivered the work', async () => {
        // Chromium: Background Sync exists, the SW drains the queue while the
        // app is closed, and it cannot leave a receipt in localStorage. A
        // "your work was deleted" banner here would be a lie about a delivery
        // that succeeded — and would teach operators to dismiss the real one.
        const stub = function ServiceWorkerRegistration() {};
        stub.prototype.sync = {};
        (globalThis as unknown as { ServiceWorkerRegistration: unknown }).ServiceWorkerRegistration =
            stub;

        writeManifest([{ id: 'a', label: 'Mark North 40 done', createdAt: 1 }]);
        const snap = await refreshOutboxState(store);
        expect(snap.lost).toBeNull();
    });

    it('runs the cross-session check ONCE per page load, not on every refresh', async () => {
        // Otherwise every normal delivery after startup would re-trip it.
        writeManifest([{ id: 'a', label: 'A', createdAt: 1 }]);
        await refreshOutboxState(store);
        acknowledgeLoss();

        store.items = [item('b')];
        await refreshOutboxState(store);
        await store.remove('b');
        const snap = await refreshOutboxState(store);
        expect(snap.lost).toBeNull();
    });
});

describe('a store that cannot be read is not a store that is empty', () => {
    it('holds the last known snapshot instead of publishing a reassuring zero', async () => {
        store.items = [item('a'), item('b')];
        await refreshOutboxState(store);

        store.throwOnRead = true;
        const snap = await refreshOutboxState(store);

        expect(snap.pending).toBe(2);
        expect(snap.lost).toBeNull();
    });
});

describe('the shared flush lock', () => {
    it('lets exactly one drain run while a second surface is mounted', async () => {
        // Two mounted surfaces used to hold one lock EACH, so both could drain
        // the same items concurrently.
        let running = 0;
        let maxConcurrent = 0;
        const drain = () =>
            runExclusiveFlush(async () => {
                running += 1;
                maxConcurrent = Math.max(maxConcurrent, running);
                await new Promise((r) => setTimeout(r, 5));
                running -= 1;
                return 'done';
            });

        const [first, second] = await Promise.all([drain(), drain()]);
        expect(maxConcurrent).toBe(1);
        // The loser is told it did nothing, rather than silently duplicating.
        expect([first, second].filter((r) => r === null)).toHaveLength(1);
    });

    it('releases the lock when the drain throws', async () => {
        await expect(
            runExclusiveFlush(async () => {
                throw new Error('network down');
            }),
        ).rejects.toThrow('network down');
        await expect(runExclusiveFlush(async () => 'ok')).resolves.toBe('ok');
    });
});

describe('queue growth warning', () => {
    it('trips at the threshold, so the operator hears it before the queue is huge', async () => {
        store.items = Array.from({ length: QUEUE_WARNING_THRESHOLD - 1 }, (_, i) =>
            item(`i${i}`, { createdAt: i }),
        );
        expect((await refreshOutboxState(store)).queueGrowing).toBe(false);

        store.items.push(item('one-more', { createdAt: 99 }));
        expect((await refreshOutboxState(store)).queueGrowing).toBe(true);
    });

    it('does not count parked conflicts — those need the operator, not signal', async () => {
        store.items = Array.from({ length: QUEUE_WARNING_THRESHOLD }, (_, i) =>
            item(`i${i}`, { createdAt: i, conflict: { status: 409 } }),
        );
        const snap = await refreshOutboxState(store);
        expect(snap.pending).toBe(0);
        expect(snap.queueGrowing).toBe(false);
        expect(snap.conflicts).toHaveLength(QUEUE_WARNING_THRESHOLD);
    });
});

describe('the persistence request', () => {
    it('happens once, and publishes the verdict on THIS queue', async () => {
        // The caution is worth most at the moment an operator has just saved
        // something they cannot re-send. Publishing on the NEXT refresh would
        // put it one action too late.
        const persist = jest.fn(async () => false);
        (globalThis as unknown as { navigator: { storage: unknown } }).navigator = {
            storage: { persisted: async () => false, persist, estimate: async () => ({}) },
        };

        store.items = [item('a')];
        await refreshOutboxState(store);
        expect(getOutboxSnapshot().durability).toBeNull();

        await noteWorkQueued();
        expect(persist).toHaveBeenCalledTimes(1);
        expect(getOutboxSnapshot().durability).toMatchObject({ persisted: false, requested: true });

        // A second queued item does not re-ask (Firefox would re-prompt).
        await noteWorkQueued();
        expect(persist).toHaveBeenCalledTimes(1);
    });
});

describe('a recreation the page did not observe itself (#730)', () => {
    // The service worker opens the same database, and `indexedDB.open` cannot
    // open without creating — so on a browser where the worker cannot
    // pre-check existence, the worker consumes the one `upgradeneeded` event
    // and the page never learns. `markRecreated` is how that signal crosses
    // back. Executed here because the alternative — the page believing a
    // destroyed queue was a drained one — is silent by construction.
    it('reports the loss once the worker hands the signal over', async () => {
        store.items = [item('a')];
        await refreshOutboxState(store);

        // The phone evicts and the WORKER wins the race to reopen, so the
        // page's own store observed no `upgradeneeded` and would otherwise
        // read a destroyed queue as a drained one.
        store.items = [];
        store.recreated = false;
        // The worker reports what it consumed; `markRecreated` sets the flag.
        store.recreated = true;

        const snap = await refreshOutboxState(store);
        expect(snap.lost?.entries.map((e) => e.id)).toEqual(['a']);
        expect(snap.lost?.entries[0].label).toContain('a');
    });

    it('a blind refresh BEFORE the signal arrives cannot be recovered', async () => {
        // The residual race, stated honestly rather than left implicit. The
        // manifest is the only record of what was queued, and a refresh that
        // mirrors an empty queue over it erases that record for good — a later
        // signal has nothing left to reconcile against. This is why the worker
        // not opening an absent database is the PRIMARY fix and the message is
        // only a backstop: the message can lose the race, the skipped open
        // cannot.
        store.items = [item('a')];
        await refreshOutboxState(store);
        store.items = [];
        store.recreated = false;
        await refreshOutboxState(store);      // blind
        store.recreated = true;               // signal arrives too late
        const snap = await refreshOutboxState(store);
        expect(snap.lost).toBeNull();
        expect(readManifest()).toEqual([]);
    });

    it('the real store accepts the signal', async () => {
        // The method exists on IndexedDbOutboxStore, not just the fake, and
        // sets the flag `wasRecreated` consumes.
        const { IndexedDbOutboxStore } = await import('@/lib/offline/idb-outbox');
        const real = new IndexedDbOutboxStore();
        expect(real.wasRecreated()).toBe(false);
        real.markRecreated();
        expect(real.wasRecreated()).toBe(true);
        // Consumed on read — one eviction, reported once.
        expect(real.wasRecreated()).toBe(false);
    });
});
