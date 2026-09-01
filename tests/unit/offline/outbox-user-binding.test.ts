/**
 * Queued work belongs to the operator who queued it.
 *
 * ## The defect
 *
 * An outbox item carried no user identity, and `fetchSender` uses plain
 * `fetch` — which sends whatever session cookie is CURRENT, not the one
 * that queued the item. On a shared farm device that has two outcomes,
 * and the second is the reason this exists:
 *
 *  - **Same tenant, different operator.** A's queued journal entry is
 *    created and hash-chain-audited as B.
 *  - **Different tenant.** The URL carries A's slug, the Edge answers
 *    403, and `flushOutbox` treats a terminal 4xx as undeliverable and
 *    REMOVES the item. Silently — and invisibly to the loss detector
 *    added in the outbox-durability work, because the removal looks
 *    deliberate and `writeManifest` re-mirrors the queue immediately
 *    after. The one mechanism built to notice vanished work cannot see
 *    this one.
 *
 * So: never send another operator's item, and never drop it either.
 *
 * ## The half that was missed for the whole life of the photo kind (#786)
 *
 * `enqueue` and `enqueuePhoto` build TWO item literals over the same
 * `OutboxItemBase`, and only the first ever stamped `queuedByUserId`. Both
 * read sites gate on the field being PRESENT, so an unstamped photo was
 * neither skipped by `flushOutbox` nor counted in `snapshot.foreign` — it
 * simply replayed under whoever was signed in at flush time.
 *
 * The carve-out "legacy items with no attribution still flush" read as a
 * shrinking set of pre-#611 rows. It was in fact EVERY photo, permanently.
 *
 * That is why the enqueue cases below are driven from ONE table: the defect
 * was two paths drifting, so a test that exercises one path cannot catch it.
 */
import { flushOutbox } from '@/lib/offline/sync';
import { InMemoryOutboxStore, enqueue, enqueuePhoto, type OutboxItem } from '@/lib/offline/outbox';
import { setCurrentUserId, getCurrentUserId } from '@/lib/offline/current-user';

const OK = { ok: true, status: 200 };

function seed(store: InMemoryOutboxStore, over: Partial<OutboxItem> = {}) {
    const item = {
        id: over.id ?? 'ob1',
        url: over.url ?? '/api/t/acme/journal',
        method: 'POST' as const,
        body: {},
        label: 'Log entry',
        createdAt: over.createdAt ?? 1,
        attempts: 0,
        ...over,
    } as OutboxItem;
    void store.add(item);
    return item;
}

function photoBlob(): Blob {
    return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
}

function photoInput() {
    return {
        url: '/api/t/acme/journal/e1/files',
        blob: photoBlob(),
        fileName: 'north.jpg',
        fileType: 'image/jpeg',
        label: 'Photo of north 40',
    };
}

/**
 * BOTH enqueue paths, driven from ONE table.
 *
 * A third enqueue path adds a row here. Asserting on a single path is what
 * let #786 sit undetected for the whole life of the photo kind.
 */
const ENQUEUE_PATHS: Array<[string, (s: InMemoryOutboxStore) => Promise<OutboxItem>]> = [
    [
        'enqueue (mutation)',
        (s) =>
            enqueue(s, {
                url: '/api/t/acme/journal',
                method: 'POST',
                body: { title: 'Aphids' },
                label: 'Log entry',
            }),
    ],
    ['enqueuePhoto (photo)', (s) => enqueuePhoto(s, photoInput())],
];

afterEach(() => setCurrentUserId(null));

describe.each(ENQUEUE_PATHS)('attribution at enqueue — %s', (_label, run) => {
    it('stamps the signed-in operator, and persists it', async () => {
        setCurrentUserId('usr_a');
        const store = new InMemoryOutboxStore();

        const item = await run(store);

        expect(item.queuedByUserId).toBe('usr_a');
        // Read back from the STORE, not just off the return value — the stamp
        // has to be on the record the flush and the snapshot actually see.
        expect((await store.all())[0].queuedByUserId).toBe('usr_a');
    });

    it('omits the field entirely when nobody is signed in', async () => {
        setCurrentUserId(null);
        const store = new InMemoryOutboxStore();

        const item = await run(store);

        // Absent, not `undefined` — the record shape stays clean for the
        // service worker, which reads these raw from IndexedDB.
        expect('queuedByUserId' in item).toBe(false);
    });
});

describe('the current-user helper itself', () => {
    it('reads back what was set', () => {
        setCurrentUserId('usr_b');
        expect(getCurrentUserId()).toBe('usr_b');
        setCurrentUserId(undefined);
        expect(getCurrentUserId()).toBeNull();
    });
});

describe("another operator's work on this device", () => {
    it('is NOT sent under the current session', async () => {
        const store = new InMemoryOutboxStore();
        seed(store, { id: 'a-item', queuedByUserId: 'usr_a' });
        const send = jest.fn(async () => OK);

        const res = await flushOutbox(store, send, 'usr_b');

        expect(send).not.toHaveBeenCalled();
        expect(res.foreign).toBe(1);
        expect(res.sent).toBe(0);
    });

    it('is NOT dropped — it waits for its owner', async () => {
        // The failure being prevented: a 403 would classify as a terminal
        // 4xx and remove the item, and the loss detector cannot see that
        // removal because it looks deliberate.
        const store = new InMemoryOutboxStore();
        seed(store, { id: 'a-item', queuedByUserId: 'usr_a' });

        await flushOutbox(store, async () => OK, 'usr_b');

        expect((await store.all()).map((i) => i.id)).toEqual(['a-item']);
    });

    it('flushes normally once its owner signs back in', async () => {
        const store = new InMemoryOutboxStore();
        seed(store, { id: 'a-item', queuedByUserId: 'usr_a' });

        const res = await flushOutbox(store, async () => OK, 'usr_a');

        expect(res.sent).toBe(1);
        expect(res.foreign).toBe(0);
        expect(await store.all()).toEqual([]);
    });

    it("sends the current operator's items while holding the other's", async () => {
        // A mixed queue is the realistic case, and the one where a coarse
        // "refuse to flush at all" would strand B's own work too.
        const store = new InMemoryOutboxStore();
        seed(store, { id: 'a-item', queuedByUserId: 'usr_a', createdAt: 1 });
        seed(store, { id: 'b-item', queuedByUserId: 'usr_b', createdAt: 2 });
        const sent: string[] = [];

        const res = await flushOutbox(
            store,
            async (i) => {
                sent.push(i.id);
                return OK;
            },
            'usr_b',
        );

        expect(sent).toEqual(['b-item']);
        expect(res.foreign).toBe(1);
        expect((await store.all()).map((i) => i.id)).toEqual(['a-item']);
    });
});

describe('back-compat and the no-owner case', () => {
    it('flushes LEGACY items that carry no attribution', async () => {
        // Queued before this shipped. There is nothing to attribute them
        // to, so holding them forever would be a silent regression that
        // strands real work.
        const store = new InMemoryOutboxStore();
        seed(store, { id: 'legacy' });
        const res = await flushOutbox(store, async () => OK, 'usr_b');
        expect(res.sent).toBe(1);
        expect(res.foreign).toBe(0);
    });

    it('drains everything when the drain has no known user', async () => {
        // The service worker replays from IndexedDB with no session
        // context. Passing null preserves exactly the previous behaviour.
        const store = new InMemoryOutboxStore();
        seed(store, { id: 'a-item', queuedByUserId: 'usr_a' });
        const res = await flushOutbox(store, async () => OK, null);
        expect(res.sent).toBe(1);
    });
});

describe("another operator's PHOTO on this device", () => {
    it('is neither sent nor dropped, and is reported as foreign', async () => {
        setCurrentUserId('usr_a');
        const store = new InMemoryOutboxStore();
        const photo = await enqueuePhoto(store, photoInput());

        setCurrentUserId('usr_b');
        const send = jest.fn(async () => OK);
        const res = await flushOutbox(store, send, 'usr_b');

        // Sending would file A's photo as B in a hash-chained audit trail.
        expect(send).not.toHaveBeenCalled();
        expect(res.foreign).toBe(1);
        // And it must still be on the device when A signs back in.
        expect((await store.all()).map((i) => i.id)).toEqual([photo.id]);
    });

    it('flushes normally once its owner signs back in', async () => {
        setCurrentUserId('usr_a');
        const store = new InMemoryOutboxStore();
        await enqueuePhoto(store, photoInput());

        const send = jest.fn(async () => OK);
        const res = await flushOutbox(store, send, 'usr_a');

        expect(send).toHaveBeenCalledTimes(1);
        expect(res.foreign).toBe(0);
        expect(await store.all()).toEqual([]);
    });
});
