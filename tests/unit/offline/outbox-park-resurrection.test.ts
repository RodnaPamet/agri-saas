/**
 * #923 — parking a write must never RESURRECT one a concurrent drain already
 * delivered and removed.
 *
 * Every store write in `flushOutbox` is an UPSERT.
 * `IndexedDbOutboxStore.update` delegates to `add`, which is `put` on
 * `keyPath: 'id'`; the service worker's `idbWrite(db, 'put', …)` is the same.
 * The page sender and the SW's background sync replay the SAME queue — the
 * race `lockTaskStatusRow` exists for — so a park written after the other
 * drain finished re-creates a row for a write that IS on the server, and it
 * sits there permanently blocked, telling the operator their work failed.
 *
 * WHY THIS FILE HAS ITS OWN STORE DOUBLE, and why the default one is a trap:
 *
 *   InMemoryOutboxStore.update is `this.items.map(x => x.id === item.id ? item : x)`
 *
 * A map over a missing id is a NO-OP. So the standard double is structurally
 * incapable of resurrecting anything, and a test written against it passes
 * whether the guard is present or absent — it cannot produce the failing
 * input, which is the one thing a mutation proof requires. `UpsertingStore`
 * below has real `put` semantics (insert-if-absent), so the mutation can
 * actually redden.
 */
import { flushOutbox, type Sender } from '@/lib/offline/sync';
import type { OutboxItem, OutboxStore } from '@/lib/offline/outbox';

/** put semantics: replace by id, INSERT if absent — like IndexedDB. */
class UpsertingStore implements OutboxStore {
    items: OutboxItem[] = [];
    async all() {
        return [...this.items];
    }
    async add(item: OutboxItem) {
        const i = this.items.findIndex((x) => x.id === item.id);
        if (i >= 0) this.items[i] = item;
        else this.items.push(item);
    }
    async update(item: OutboxItem) {
        await this.add(item); // the upsert that makes resurrection possible
    }
    async remove(id: string) {
        this.items = this.items.filter((x) => x.id !== id);
    }
    async clear() {
        this.items = [];
    }
}

function mutation(id: string): OutboxItem {
    return { id, url: `/${id}`, method: 'PATCH', body: {}, label: 'L', createdAt: 1, attempts: 0 };
}

describe('a park never resurrects a row another drain already delivered', () => {
    // The failing input: the OTHER drain delivers and removes the item while
    // this drain is awaiting its own response. Modelled by removing the row
    // from inside the sender, which is exactly when the real race lands.
    it('a terminal 4xx does not re-add an item removed mid-flight', async () => {
        const store = new UpsertingStore();
        await store.add(mutation('a'));

        const send: Sender = async () => {
            await store.remove('a'); // the concurrent drain won
            return { ok: false, status: 400 };
        };

        const res = await flushOutbox(store, send);

        // Nothing left behind. Without the guard the park upserts 'a' back in,
        // permanently blocked, describing a write that IS on the server.
        expect(await store.all()).toHaveLength(0);
        expect(res.refused).toBe(0);
    });

    it('an auth block does not re-add an item removed mid-flight', async () => {
        const store = new UpsertingStore();
        await store.add(mutation('a'));
        const send: Sender = async () => {
            await store.remove('a');
            return { ok: false, status: 401 };
        };
        const res = await flushOutbox(store, send);
        expect(await store.all()).toHaveLength(0);
        expect(res.blocked).toBe(0);
        // The pass still stops — the session is refused regardless.
        expect(res.authBlocked).toBe(true);
    });

    it('an exhausted transient does not re-add an item removed mid-flight', async () => {
        const store = new UpsertingStore();
        await store.add({ ...mutation('a'), attempts: 7 }); // one below MAX_ATTEMPTS
        const send: Sender = async () => {
            await store.remove('a');
            return { ok: false, status: 500 };
        };
        const res = await flushOutbox(store, send);
        expect(await store.all()).toHaveLength(0);
        expect(res.blocked).toBe(0);
    });

    // CONTROL — the guard must not stop an ordinary park. Without this, a
    // build whose park never wrote anything would satisfy every case above.
    it('CONTROL: a refusal on a row that is STILL queued does park it', async () => {
        const store = new UpsertingStore();
        await store.add(mutation('a'));
        const send: Sender = async () => ({ ok: false, status: 422 });

        const res = await flushOutbox(store, send);

        const all = await store.all();
        expect(all).toHaveLength(1);
        expect(all[0].blocked).toBe('refused');
        expect(all[0].refusedStatus).toBe(422);
        expect(res.refused).toBe(1);
    });

    // CONTROL — the double itself must be able to resurrect, or none of the
    // assertions above could ever fail and this file would be theatre.
    it('CONTROL: the store double really does upsert (insert-if-absent)', async () => {
        const store = new UpsertingStore();
        await store.update(mutation('ghost'));
        expect(await store.all()).toHaveLength(1);
    });
});
