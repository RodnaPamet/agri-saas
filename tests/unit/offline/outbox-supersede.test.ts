/**
 * #934 — a later write REPLACES an earlier unsent one for the same row.
 *
 * The optimistic update never advances `version` locally (the only writer that
 * could is a refetch, which offline never resolves), so a second offline write
 * to the same entity carried the FIRST one's `If-Match`. It 409d, and was
 * parked as a conflict against the operator's own superseded write — with the
 * banner blaming a colleague who does not exist. Then both resolution branches
 * were wrong: "use server" discarded the newer correction, "keep mine"
 * re-sent a body re-seeded from the pre-edit snapshot.
 *
 * WHY THE KEY IS CALLER-SUPPLIED AND CLOSED, not `url + method`:
 * `ParcelDetailSheet` POSTs creates to a COLLECTION url
 * (`/locations/:id/operations`), so two different spray jobs share url+method
 * exactly. Superseding those would destroy a БАБХ compliance record with no
 * receipt and no manifest gap — invisible to both loss detectors.
 *
 * WHY TWO STORE DOUBLES. `InMemoryOutboxStore.add` PUSHES; the real
 * `IndexedDbOutboxStore.add` is `put` on `keyPath: 'id'` — an UPSERT. An
 * implementation that reused the victim's id and leaned on the upsert would
 * show TWO rows on the stock double (red) and ONE row on a phone (green). The
 * test that passes on the stock double alone is the one that lies about the
 * device, so every "one row survives" assertion runs against both.
 */
import {
    InMemoryOutboxStore,
    enqueue,
    supersedeQueuedWrites,
    type OutboxItem,
    type OutboxStore,
    type SupersedeTarget,
} from '@/lib/offline/outbox';
import { setCurrentUserId } from '@/lib/offline/current-user';

/** put semantics: replace by id, insert if absent — like IndexedDB. */
class UpsertOutboxStore implements OutboxStore {
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
        await this.add(item);
    }
    async remove(id: string) {
        this.items = this.items.filter((x) => x.id !== id);
    }
    async clear() {
        this.items = [];
    }
}

const KEY = 'journal-entry:e1' as SupersedeTarget;

function editInput(body: unknown) {
    return { url: '/api/t/x/journal/e1', method: 'PATCH' as const, body, label: 'edit', supersedes: KEY };
}

/** The production sequence: ADD the replacement, THEN remove the victims. */
async function submitSuperseding(store: OutboxStore, body: unknown) {
    const item = await enqueue(store, editInput(body));
    const removed = await supersedeQueuedWrites(store, KEY, item.id);
    return { item, removed };
}

describe.each([
    ['InMemoryOutboxStore (push)', () => new InMemoryOutboxStore()],
    ['UpsertOutboxStore (put, like IndexedDB)', () => new UpsertOutboxStore()],
])('#934 supersede — %s', (_name, make) => {
    let store: OutboxStore;
    beforeEach(() => {
        store = make();
    });

    it('a second write for the same row leaves exactly one item, carrying the LATER body', async () => {
        const first = await enqueue(store, editInput({ rate: 'wrong' }));
        const { item: second } = await submitSuperseding(store, { rate: 'corrected' });

        const all = await store.all();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(second.id);
        // A fresh id, never the victim's — reusing it would rely on the upsert
        // and behave differently on a phone than on the stock double.
        expect(second.id).not.toBe(first.id);
        expect((all[0] as { body: unknown }).body).toEqual({ rate: 'corrected' });
    });

    it('leaves a DIFFERENT row alone', async () => {
        await enqueue(store, { ...editInput({ a: 1 }), supersedes: 'journal-entry:other' as SupersedeTarget });
        await submitSuperseding(store, { a: 2 });
        expect(await store.all()).toHaveLength(2);
    });

    // CONTROL — without a key nothing is superseded. This is the default, and
    // it is what keeps a CREATE (two queued entries = two records) safe.
    it('CONTROL: writes with NO key are never superseded', async () => {
        await enqueue(store, { url: '/api/t/x/journal', method: 'POST', body: { t: 'one' }, label: 'create' });
        await enqueue(store, { url: '/api/t/x/journal', method: 'POST', body: { t: 'two' }, label: 'create' });
        expect(await store.all()).toHaveLength(2);
    });

    it('never deletes a PARKED CONFLICT — that is an operator decision, not a stale write', async () => {
        const parked = await enqueue(store, editInput({ rate: 'contested' }));
        await store.update({ ...parked, conflict: { status: 409, server: {} } });

        await submitSuperseding(store, { rate: 'newer' });

        const all = await store.all();
        expect(all).toHaveLength(2);
        expect(all.some((i) => i.id === parked.id)).toBe(true);
    });

    it('never deletes a BLOCKED item — #923 exists to stop those disappearing', async () => {
        const blocked = await enqueue(store, editInput({ rate: 'refused' }));
        await store.update({ ...blocked, blocked: 'refused', refusedStatus: 400 });

        await submitSuperseding(store, { rate: 'newer' });

        const all = await store.all();
        expect(all).toHaveLength(2);
        expect(all.some((i) => i.id === blocked.id)).toBe(true);
    });

    it('returns the ids it removed, so a caller can say what it replaced', async () => {
        const first = await enqueue(store, editInput({ a: 1 }));
        const { removed } = await submitSuperseding(store, { a: 2 });
        expect(removed).toEqual([first.id]);
    });

    // ── #1005: the foreign guard must fail CLOSED ──
    //
    // `getCurrentUserId()` is fed from the server-rendered layout, and
    // `public/sw.js` replays that document from cache — so on a shared phone
    // it can be ABSENT, or be operator A's while B is signed in. The guard
    // used to read `!(owner && i.queuedByUserId && i.queuedByUserId !== owner)`,
    // where a null owner short-circuits to falsy and `!(falsy)` is TRUE for
    // every item. Every foreign write became deletable at exactly the moment
    // the code could not tell whose it was.
    //
    // None of the 12 tests above covered a null owner, which is why it shipped.
    describe('the foreign guard with identity UNKNOWN (#1005)', () => {
        afterEach(() => setCurrentUserId(null));

        it('supersedes NOTHING when the owner is unknown and the victim is attributed', async () => {
            setCurrentUserId('operator-a');
            const theirs = await enqueue(store, editInput({ rate: 'theirs' }));

            // The document no longer says who is signed in.
            setCurrentUserId(null);
            const { removed } = await submitSuperseding(store, { rate: 'mine' });

            expect(removed).toEqual([]);
            const ids = (await store.all()).map((i) => i.id);
            expect(ids).toContain(theirs.id);
        });

        it('still supersedes the operator\'s OWN queued write — control on the above', async () => {
            // Without this, "supersede nothing, ever" passes the test above and
            // breaks the feature. The guard has to DISCRIMINATE, not refuse.
            setCurrentUserId('operator-a');
            const mine = await enqueue(store, editInput({ rate: 'first' }));
            const { removed } = await submitSuperseding(store, { rate: 'second' });

            expect(removed).toEqual([mine.id]);
            expect(await store.all()).toHaveLength(1);
        });

        it('never supersedes a KNOWN other operator\'s write', async () => {
            setCurrentUserId('operator-a');
            const theirs = await enqueue(store, editInput({ rate: 'theirs' }));

            setCurrentUserId('operator-b');
            const { removed } = await submitSuperseding(store, { rate: 'mine' });

            expect(removed).toEqual([]);
            expect((await store.all()).map((i) => i.id)).toContain(theirs.id);
        });

        it('still supersedes a LEGACY row carrying no attribution', async () => {
            // Pre-#786 rows have no `queuedByUserId`. Both drains treat those as
            // sendable, so refusing to supersede them would strand duplicates.
            setCurrentUserId(null);
            const legacy = await enqueue(store, editInput({ rate: 'legacy' }));
            expect(legacy.queuedByUserId).toBeUndefined();

            setCurrentUserId('operator-a');
            const { removed } = await submitSuperseding(store, { rate: 'new' });
            expect(removed).toEqual([legacy.id]);
        });
    });
});
