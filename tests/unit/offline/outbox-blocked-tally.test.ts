/**
 * `blocked` is a SUBSET of `pending`, and the snapshot has to say so.
 *
 * WHY THIS FILE EXISTS:
 *
 * #761 stopped the outbox deleting work it could not deliver. A 401/403 or an
 * exhausted retry budget now RETAINS the item and marks it
 * `blocked: 'auth' | 'exhausted'` instead of dropping it. That is strictly
 * better — but it created a new way for a number to reassure falsely.
 *
 * `refreshOutboxState` computes `pending` from `live`, which filters out
 * conflicts and foreign items and NOTHING ELSE. So a blocked item is counted in
 * `pending`, and "3 pending" on a phone whose three items are all blocked reads
 * to an operator as "will go when I get signal". It will not go, however long
 * they stand in the yard, until they sign in again.
 *
 * Two populations behind one number is the same shape as the evicted-queue
 * problem the three-state UI was built for — which is why the fix is a second
 * number rather than a footnote, and why these tests pin the SUBSET
 * relationship rather than just the count.
 */
import { __resetOutboxStateForTests, refreshOutboxState } from '@/lib/offline/outbox-state';
import type { MutationOutboxItem, OutboxItem, OutboxStore } from '@/lib/offline/outbox';
import { setCurrentUserId } from '@/lib/offline/current-user';

function installLocalStorage() {
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
}

function item(id: string, over: Partial<MutationOutboxItem> = {}): OutboxItem {
    return {
        id,
        url: `/api/t/acme/field-operations/t1/parcels/${id}`,
        method: 'PATCH',
        body: { status: 'DONE' },
        label: `Mark ${id} done`,
        createdAt: 1,
        attempts: 0,
        ...over,
    } as OutboxItem;
}

class FakeStore implements OutboxStore {
    items: OutboxItem[] = [];
    async add(i: OutboxItem) {
        this.items.push(i);
    }
    async all() {
        return [...this.items];
    }
    async update(i: OutboxItem) {
        this.items = this.items.map((x) => (x.id === i.id ? i : x));
    }
    async remove(id: string) {
        this.items = this.items.filter((x) => x.id !== id);
    }
}

let store: FakeStore;
beforeEach(() => {
    installLocalStorage();
    __resetOutboxStateForTests();
    setCurrentUserId(null);
    store = new FakeStore();
});

describe('outbox snapshot — blocked work is visible, and visibly a subset', () => {
    it('counts a blocked item in BOTH pending and blocked', async () => {
        store.items = [item('a', { blocked: 'auth' } as Partial<MutationOutboxItem>)];

        const snap = await refreshOutboxState(store);

        // The subset relationship is the claim. If `pending` ever stops
        // including blocked items, the page's "N waiting, of which M cannot
        // move" reading becomes wrong in the other direction.
        expect(snap.pending).toBe(1);
        expect(snap.blocked).toBe(1);
    });

    it('separates the auth subset, because only that one has an operator action', async () => {
        store.items = [
            item('a', { blocked: 'auth' } as Partial<MutationOutboxItem>),
            item('b', { blocked: 'exhausted' } as Partial<MutationOutboxItem>),
            item('c'),
        ];

        const snap = await refreshOutboxState(store);

        expect(snap.pending).toBe(3);
        expect(snap.blocked).toBe(2);
        // 'exhausted' resolves itself when the server recovers; 'auth' does not
        // resolve until a human signs in. Only the second is worth prompting on.
        expect(snap.blockedAuth).toBe(1);
    });

    it('reports zero blocked when everything is merely waiting for signal', async () => {
        store.items = [item('a'), item('b')];

        const snap = await refreshOutboxState(store);

        expect(snap.pending).toBe(2);
        expect(snap.blocked).toBe(0);
        expect(snap.blockedAuth).toBe(0);
    });

    it('does not count a FOREIGN blocked item — it is already reported separately', async () => {
        // A foreign item is excluded from `live`, so it must not appear in
        // `blocked` either; otherwise one item is reported twice under two
        // different explanations and the numbers stop adding up.
        //
        // setCurrentUserId is REQUIRED for this test to mean anything:
        // `isForeign` short-circuits on a null owner, so without it nothing is
        // foreign and the assertion cannot fail. The first version of this test
        // omitted it and passed against a deliberately broken tally.
        setCurrentUserId('usr_me');
        store.items = [
            item('mine', { queuedByUserId: 'usr_me', blocked: 'auth' } as Partial<MutationOutboxItem>),
            item('theirs', {
                blocked: 'auth',
                queuedByUserId: 'usr_someone_else',
            } as Partial<MutationOutboxItem>),
        ];

        const snap = await refreshOutboxState(store);

        expect(snap.foreign).toBe(1);
        expect(snap.pending).toBe(1);
        // Exactly one — the foreign one is reported under `foreign`, not here.
        expect(snap.blocked).toBe(1);
        expect(snap.blockedAuth).toBe(1);
    });
});
