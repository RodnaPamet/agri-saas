/**
 * @jest-environment jsdom
 *
 * Signing out clears what this device cached — and keeps what it owes.
 *
 * Executing, not structural: `tests/guards/sign-out-purges.test.ts`
 * proves every call site goes through the wrapper, which is a claim about
 * source text. This proves the wrapper actually does the two things that
 * matter, in the order that matters.
 */
import { sweepClientStores } from '@/lib/offline/client-data-retention';

const signOutMock = jest.fn(async (opts?: { callbackUrl?: string }) => {
    void opts;
    return undefined;
});
jest.mock('next-auth/react', () => ({
    signOut: (opts?: { callbackUrl?: string }) => signOutMock(opts),
}));

const sweepMock = jest.fn(async (opts?: { maxAgeMs?: number }) => {
    void opts;
    return { snapshotsRemoved: 0, snapshotsKept: 0, swrBucketsRemoved: 0, cachesRemoved: 0 };
});
jest.mock('@/lib/offline/client-data-retention', () => ({
    ...jest.requireActual('@/lib/offline/client-data-retention'),
    sweepClientStores: (opts?: { maxAgeMs?: number }) => sweepMock(opts),
}));

import { signOutAndPurge, PURGE_BUDGET_MS } from '@/lib/auth/sign-out';

beforeEach(() => {
    signOutMock.mockClear();
    sweepMock.mockClear();
});

describe('signOutAndPurge', () => {
    it('purges at FULL strength — a 24h window would clear nothing', async () => {
        await signOutAndPurge();
        expect(sweepMock).toHaveBeenCalledWith({ maxAgeMs: 0 });
    });

    it('purges BEFORE signing out', async () => {
        // This app is used offline by design, so the sign-out request can
        // fail to complete. Purging first leaves the device clean anyway,
        // which is the entire point.
        const order: string[] = [];
        sweepMock.mockImplementationOnce(async () => {
            order.push('purge');
            return { snapshotsRemoved: 0, snapshotsKept: 0, swrBucketsRemoved: 0, cachesRemoved: 0 };
        });
        signOutMock.mockImplementationOnce(async () => {
            order.push('signOut');
            return undefined;
        });
        await signOutAndPurge();
        expect(order).toEqual(['purge', 'signOut']);
    });

    it('signs out anyway when the purge throws', async () => {
        sweepMock.mockRejectedValueOnce(new Error('storage wedged'));
        await expect(signOutAndPurge()).resolves.toBeUndefined();
        expect(signOutMock).toHaveBeenCalled();
    });

    it('does not let a HUNG purge become a hung sign-out', async () => {
        jest.useFakeTimers();
        sweepMock.mockImplementationOnce(() => new Promise(() => {}) as never);
        const done = signOutAndPurge();
        await jest.advanceTimersByTimeAsync(PURGE_BUDGET_MS + 10);
        await done;
        expect(signOutMock).toHaveBeenCalled();
        jest.useRealTimers();
    });

    it('passes the callback url through', async () => {
        await signOutAndPurge({ callbackUrl: '/goodbye' });
        expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/goodbye' });
    });

    it('defaults to /login', async () => {
        await signOutAndPurge();
        expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/login' });
    });
});

describe('what sign-out must NOT delete', () => {
    it('the real sweep leaves the outbox and its bookkeeping alone at maxAgeMs 0', async () => {
        // Drives the REAL sweep, not the mock. Unsynced field work exists
        // nowhere else, and clearing the manifest alongside the queue is
        // exactly the shape the loss detector reads as "this phone deleted
        // your work". Sign-out is the strongest purge in the app, so this
        // is where that boundary most needs proving.
        const real = jest.requireActual('@/lib/offline/client-data-retention') as {
            sweepClientStores: typeof sweepClientStores;
        };
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
        map.set('agri.offline.outbox.manifest.v1', JSON.stringify([{ id: 'a', label: 'x' }]));
        map.set('agri.offline.lostwork.v1', JSON.stringify({ entries: [{ id: 'b' }] }));

        await real.sweepClientStores({ maxAgeMs: 0 });

        expect(map.has('agri.offline.outbox.manifest.v1')).toBe(true);
        expect(map.has('agri.offline.lostwork.v1')).toBe(true);
    });
});
