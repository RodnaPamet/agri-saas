/**
 * @jest-environment jsdom
 *
 * #921 — a REFUSED write and a QUEUED write must not share an observable.
 *
 * `submit` used to return `'queued'` for both, and the two have opposite
 * futures: a queued item is retried by every drain, while a 409-parked item is
 * skipped forever (`sync.ts` — `if (item.conflict) continue;`) until an
 * operator resolves it. `pending` is computed over `live`, which filters
 * conflicts out, so a parked write also leaves the count at zero.
 *
 * The journal edit modal read that single value as "fine, close" and showed
 * nothing — so an operator's correction to a БАБХ compliance record was
 * refused by the server, closed like a success, and left in a queue no journal
 * screen rendered and no drain would ever send. This file pins the distinction
 * at its source, plus the `If-Match` the resolution path re-sends.
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

/** The real envelope: withApiErrorHandling nests details under `error`. */
function staleBody(currentVersion: number) {
    return { error: { code: 'STALE_DATA', message: 'changed', details: { currentVersion, expectedVersion: 3 } } };
}

const EDIT = { url: '/api/t/x/journal/e1', method: 'PATCH' as const, body: { title: 'corrected rate' }, label: 'edit', ifMatch: 3 };

describe('#921 — a 409 is reported as a conflict, never as queued', () => {
    beforeEach(() => {
        store.items = [];
        setOnline(true);
    });

    it('an online 409 resolves "conflict" — NOT "queued"', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async () => ({
            ok: false,
            status: 409,
            json: async () => staleBody(4),
        }));

        const { result } = renderHook(() => useOfflineSync());
        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.submit(EDIT);
        });

        expect(outcome).toBe('conflict');
        expect(outcome).not.toBe('queued');
    });

    // CONTROL. Without this, a build where submit always answered 'conflict'
    // would satisfy the assertion above — the suite must be able to tell the
    // refusal apart from the ordinary success, not just recognise one string.
    it('CONTROL: an online 2xx still resolves "sent"', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200 }));

        const { result } = renderHook(() => useOfflineSync());
        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.submit(EDIT);
        });

        expect(outcome).toBe('sent');
    });

    // CONTROL. The genuine offline queue must keep saying 'queued', or the fix
    // would have broken the case #919 existed to enable.
    it('CONTROL: an offline submit still resolves "queued" and is retryable', async () => {
        setOnline(false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async () => {
            throw new TypeError('Load failed');
        });

        const { result } = renderHook(() => useOfflineSync());
        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.submit(EDIT);
        });

        expect(outcome).toBe('queued');
        const items = await store.all();
        expect(items).toHaveLength(1);
        // Retryable precisely because it is NOT parked.
        expect(items[0].conflict).toBeUndefined();
    });

    it('the parked conflict is invisible to `pending` — which is why the return value has to say so', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = jest.fn(async () => ({
            ok: false,
            status: 409,
            json: async () => staleBody(4),
        }));

        const { result } = renderHook(() => useOfflineSync());
        await act(async () => {
            await result.current.submit(EDIT);
        });

        // The write is on the device...
        expect(await store.all()).toHaveLength(1);
        // ...and every count an operator can see reads zero.
        expect(result.current.pending).toBe(0);
        // Only `conflicts` carries it, which is what the banner renders.
        expect(result.current.conflicts).toHaveLength(1);
    });
});

describe('#921 — keep-mine re-sends the server version from the REAL 409 envelope', () => {
    beforeEach(() => {
        store.items = [];
        setOnline(true);
    });

    it('reads currentVersion from error.details, so the retry carries If-Match', async () => {
        const item = await outbox.enqueue(store, EDIT);
        await store.update({ ...item, conflict: { status: 409, server: staleBody(9) } });

        // Declare the parameters: a zero-arg jest.fn types `mock.calls` as
        // `[]`, so reading calls[0][1] is a type error — and the assertion
        // that matters here is about the second argument.
        const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = fetchMock;

        const { result } = renderHook(() => useOfflineSync());
        await act(async () => {
            await result.current.resolveConflict(item.id, 'keep-mine');
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        // Reading `server.currentVersion` (one level too shallow) yields
        // undefined, and the header is then omitted entirely — a blind
        // overwrite that also clobbers any edit landing in between.
        expect(init.headers['If-Match']).toBe('9');
    });

    // CONTROL: the flat shape a future unwrapped endpoint might answer.
    it('CONTROL: a flat { currentVersion } body still resolves', async () => {
        const item = await outbox.enqueue(store, EDIT);
        await store.update({ ...item, conflict: { status: 409, server: { currentVersion: 12 } } });

        // Declare the parameters: a zero-arg jest.fn types `mock.calls` as
        // `[]`, so reading calls[0][1] is a type error — and the assertion
        // that matters here is about the second argument.
        const fetchMock = jest.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = fetchMock;

        const { result } = renderHook(() => useOfflineSync());
        await act(async () => {
            await result.current.resolveConflict(item.id, 'keep-mine');
        });

        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers['If-Match']).toBe('12');
    });
});
