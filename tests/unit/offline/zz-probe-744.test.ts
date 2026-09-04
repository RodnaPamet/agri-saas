/** PROBE (temporary): does a CLASS-WIDE sweep (queue + manifest both gone) get reported? */
import {
    __resetOutboxStateForTests,
    refreshOutboxState,
} from '@/lib/offline/outbox-state';
import { writeManifest, readManifest, readLostWork } from '@/lib/offline/durability';
import type { OutboxItem, OutboxStore } from '@/lib/offline/outbox';

function installLocalStorage(): Map<string, string> {
    const map = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() { return map.size; },
    } as Storage;
    return map;
}

class FakeStore implements OutboxStore {
    items: OutboxItem[] = [];
    receipts: Array<{ id: string; at: number }> = [];
    recreated = false;
    async add(i: OutboxItem) { this.items.push(i); }
    async all() { return [...this.items]; }
    async update(i: OutboxItem) { this.items = this.items.map((x) => (x.id === i.id ? i : x)); }
    async remove(id: string) { this.items = this.items.filter((x) => x.id !== id); }
    async noteDelivered(id: string) { this.receipts.push({ id, at: Date.now() }); }
    async takeDelivered() { return this.receipts.splice(0); }
    wasRecreated() { const v = this.recreated; this.recreated = false; return v; }
}

let store: FakeStore;
let ls: Map<string, string>;
beforeEach(() => {
    ls = installLocalStorage();
    __resetOutboxStateForTests();
    store = new FakeStore();
    delete (globalThis as { ServiceWorkerRegistration?: unknown }).ServiceWorkerRegistration;
});

describe('#744 probe — class-wide sweep', () => {
    it('SELECTIVE (manifest survives): loss IS reported', async () => {
        writeManifest([{ id: 'a', label: 'Mark North 40 done', createdAt: 1 }]);
        const snap = await refreshOutboxState(store);
        // eslint-disable-next-line no-console
        console.log('SELECTIVE ->', JSON.stringify({ lost: snap.lost, pending: snap.pending }));
        expect(snap.lost?.cause).toBe('queue-vanished-while-closed');
    });

    it('CLASS-WIDE (manifest also gone): what happens?', async () => {
        // identical prior queued work — but the sweep took localStorage too,
        // so nothing was ever written back / it is all gone.
        expect(readManifest()).toEqual([]);
        expect(ls.size).toBe(0);
        const snap = await refreshOutboxState(store);
        // eslint-disable-next-line no-console
        console.log('CLASSWIDE ->', JSON.stringify({ lost: snap.lost, pending: snap.pending, lostRecord: readLostWork() }));
        expect(snap.lost).toBeNull();
        expect(snap.pending).toBe(0);
    });
});
