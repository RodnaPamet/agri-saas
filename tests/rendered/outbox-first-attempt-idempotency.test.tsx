/**
 * @jest-environment jsdom
 *
 * #924 — the first attempt and its replays must carry ONE Idempotency-Key.
 *
 * `fetchSender` has always sent the handle on every REPLAY, and its docblock
 * explains that the same item id riding every retry is what makes delivery
 * exactly-once. `submit`'s first attempt sent none, and `submitPhoto`'s sent no
 * headers at all — so the one request that actually reaches the server first
 * was the one the server could not dedupe.
 *
 * The failure needs no exotic state: operator online, POST lands, SERVER
 * COMMITS, response lost on flaky rural LTE. `fetch` rejects, the catch
 * enqueues, and the id was minted only THEN — a value the server has never
 * seen. Traced through all three CREATE routes, that is two rows, every time:
 * `createLogEntryImpl` has no natural-key fallback at all and its only
 * pre-check is gated on `if (idempotencyKey)`.
 *
 * The load-bearing assertion here is not "a header is present" — it is that
 * the key on the first attempt EQUALS the key on the replay. A build that
 * minted a fresh id for each would satisfy the first and still duplicate.
 */
import { renderHook, act } from '@testing-library/react';

jest.mock('@/lib/offline/outbox', () => {
    const actual = jest.requireActual('@/lib/offline/outbox');
    const store = new actual.InMemoryOutboxStore();
    return { ...actual, getOutboxStore: () => store, __store: store };
});

import * as outbox from '@/lib/offline/outbox';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = (outbox as any).__store;

function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

type Init = { headers?: Record<string, string>; method?: string };
const keyOf = (init: Init | undefined) => init?.headers?.['Idempotency-Key'];

const CREATE = { url: '/api/t/x/journal', method: 'POST' as const, body: { title: 'spray' }, label: 'create' };

describe('#924 — the online first attempt carries the idempotency handle', () => {
    beforeEach(() => {
        store.items = [];
        setOnline(true);
    });

    it('sends Idempotency-Key on the very first attempt', async () => {
        const fetchMock = jest.fn(async (_u: string, _i: RequestInit) => ({ ok: true, status: 200 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = fetchMock;

        const { result } = renderHook(() => useOfflineSync());
        await act(async () => {
            await result.current.submit(CREATE);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(keyOf(fetchMock.mock.calls[0][1] as Init)).toBeTruthy();
    });

    it('THE POINT: a lost response replays under the SAME key, so the server can dedupe', async () => {
        const seen: (string | undefined)[] = [];
        // First attempt: the server commits, then the response is lost.
        // Replay: succeeds.
        const fetchMock = jest.fn(async (_u: string, init: RequestInit) => {
            seen.push(keyOf(init as Init));
            if (seen.length === 1) throw new TypeError('Load failed');
            return { ok: true, status: 200 };
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = fetchMock;

        const { result } = renderHook(() => useOfflineSync());
        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.submit(CREATE);
        });
        expect(outcome).toBe('queued');

        await act(async () => {
            await result.current.flush();
        });

        expect(seen).toHaveLength(2);
        expect(seen[0]).toBeTruthy();
        // Two different keys = the server sees two unrelated writes = two rows.
        expect(seen[1]).toBe(seen[0]);
        expect(await store.all()).toHaveLength(0);
    });

    it('submitPhoto also carries it on the first attempt, and replays under the same key', async () => {
        const seen: (string | undefined)[] = [];
        const fetchMock = jest.fn(async (_u: string, init: RequestInit) => {
            seen.push(keyOf(init as Init));
            if (seen.length === 1) throw new TypeError('Load failed');
            return { ok: true, status: 200 };
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = fetchMock;
        // submitPhoto refuses without IndexedDB; the queue itself is the mocked
        // in-memory store, so only the availability probe needs satisfying.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).indexedDB = (global as any).indexedDB ?? {};

        const { result } = renderHook(() => useOfflineSync());
        await act(async () => {
            await result.current.submitPhoto({
                url: '/api/t/x/journal/e1/files',
                blob: new Blob(['bytes'], { type: 'image/webp' }),
                fileName: 'p.webp',
                fileType: 'image/webp',
                label: 'photo',
            });
        });
        await act(async () => {
            await result.current.flush();
        });

        expect(seen).toHaveLength(2);
        expect(seen[0]).toBeTruthy();
        expect(seen[1]).toBe(seen[0]);
    });

    // CONTROL. An offline submit makes no first attempt at all, so its replay
    // is the only request — this must keep working, or the fix would have
    // broken the ordinary field case.
    it('CONTROL: an offline submit still queues and replays with a handle', async () => {
        setOnline(false);
        const seen: (string | undefined)[] = [];
        const fetchMock = jest.fn(async (_u: string, init: RequestInit) => {
            seen.push(keyOf(init as Init));
            return { ok: true, status: 200 };
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = fetchMock;

        const { result } = renderHook(() => useOfflineSync());
        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.submit(CREATE);
        });
        expect(outcome).toBe('queued');
        // No network was touched while offline.
        expect(fetchMock).not.toHaveBeenCalled();

        setOnline(true);
        await act(async () => {
            await result.current.flush();
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeTruthy();
    });
});

describe('#924 — the shared id must not let a failed 409 park be overwritten', () => {
    beforeEach(() => {
        store.items = [];
        setOnline(true);
    });

    // The 409 arm's enqueue / store.update / refresh all sit inside the `try`,
    // and the catch rethrows only "Request failed (4…)". Before the `enqueued`
    // guard, a throw from `update` fell through to a second enqueue — and with
    // ONE shared id that second enqueue is an UPSERT over the parked conflict
    // (IndexedDbOutboxStore.add is `put` on keyPath 'id'), turning a parked
    // write back into a clean queued one and returning 'queued'. That is the
    // silent-loss shape #922 fixed, re-created by this PR's own change.
    it('a throw while parking does not enqueue a second, clean copy', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async () => ({
            ok: false,
            status: 409,
            json: async () => ({ error: { code: 'STALE_DATA', details: { currentVersion: 4 } } }),
        }));

        const realUpdate = store.update.bind(store);
        store.update = jest.fn(async () => {
            throw new Error('idb write failed');
        });

        const { result } = renderHook(() => useOfflineSync());
        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.submit({ ...CREATE, method: 'PATCH', ifMatch: 3 });
        });

        store.update = realUpdate;
        const items = await store.all();
        // EXACTLY ONE ROW. This is the anchor: InMemoryOutboxStore.add pushes,
        // so without the `enqueued` guard the fall-through enqueues a second
        // copy and this reads 2. (In IndexedDB it would instead be one row
        // silently overwritten, which is worse and unobservable — the
        // in-memory double can at least show the duplicate.)
        expect(items).toHaveLength(1);

        // 'queued' is honest here and deliberately not an error: the park
        // failed, so the row carries no conflict marker and the next drain
        // retries it — where sync.ts's own 409 arm parks it properly and the
        // journal conflict banner (#922) shows it. The write is recoverable,
        // which is the property that matters; reporting a hard failure would
        // tell the operator to re-enter work that is still queued.
        expect(outcome).toBe('queued');
        expect(items[0].conflict).toBeUndefined();
    });
});
