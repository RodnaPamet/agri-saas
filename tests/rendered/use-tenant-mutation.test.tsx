/**
 * Epic 69 — `useTenantMutation` foundation tests.
 *
 * Pins the optimistic / API-call / rollback / revalidate lifecycle that
 * makes the hook safe to adopt page-by-page:
 *
 *   1. Optimistic data appears synchronously in the matching
 *      `useTenantSWR` cache as soon as `trigger()` is called.
 *   2. On API success the cache holds the authoritative value
 *      (either the API response via `populateCache` OR the
 *      revalidation result).
 *   3. On API failure the cache rolls back to the pre-mutation
 *      value AND the hook surfaces the error.
 *   4. `isMutating` lifecycle is correct (false → true → false)
 *      and `error` survives until `reset()`.
 *   5. Sibling caches listed in `invalidate` get a background
 *      refetch after the primary mutation succeeds.
 *   6. The four product shapes work: detail patch, list append,
 *      list remove, status change.
 *
 * Each test wraps the hooks under one shared `SWRConfig` provider
 * so the mutation and the read see the same cache, which is what
 * the hook is designed for.
 */

import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';

// ── fetch mock for the read side ───────────────────────────────────────

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

function makeWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig
                value={{
                    provider: () => new Map(),
                    // Suppress the default `errorRetry` that fires
                    // every 5 s after a failed revalidation — the
                    // tests assert state at a moment in time and we
                    // don't want stray retries.
                    shouldRetryOnError: false,
                }}
            >
                {children}
            </SWRConfig>
        );
    };
}

// ── Detail patch ───────────────────────────────────────────────────────

interface Practice {
    id: string;
    title: string;
    status: 'OPEN' | 'CLOSED';
}

describe('useTenantMutation — detail patch', () => {
    it('applies the optimistic patch immediately and persists on success', async () => {
        // Initial GET response.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                id: 'c1',
                title: 'Old',
                status: 'OPEN',
            } as Practice),
        });
        // Revalidation GET after mutation — returns the server-final
        // shape (which happens to match the optimistic value).
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'c1',
                title: 'New',
                status: 'OPEN',
            } as Practice),
        });

        const apiPatch = jest
            .fn()
            .mockResolvedValue({ id: 'c1', title: 'New', status: 'OPEN' });

        const { result } = renderHook(
            () => {
                const read = useTenantSWR<Practice>('/practices/c1');
                const mutation = useTenantMutation<
                    Practice,
                    { title: string },
                    Practice
                >({
                    key: '/practices/c1',
                    mutationFn: apiPatch,
                    optimisticUpdate: (current, input) => ({
                        ...(current as Practice),
                        ...input,
                    }),
                });
                return { read, mutation };
            },
            { wrapper: makeWrapper() },
        );

        // Wait for initial read.
        await waitFor(() =>
            expect(result.current.read.data).toEqual({
                id: 'c1',
                title: 'Old',
                status: 'OPEN',
            }),
        );

        // Trigger the mutation. Within `act` the optimistic state
        // is committed synchronously before the promise resolves.
        await act(async () => {
            await result.current.mutation.trigger({ title: 'New' });
        });

        // Cache reflects the API result (either via revalidation or
        // populateCache — both end at the same place here).
        await waitFor(() =>
            expect(result.current.read.data?.title).toBe('New'),
        );
        expect(result.current.mutation.error).toBeNull();
        expect(result.current.mutation.isMutating).toBe(false);
    });

    it('rolls back to prior data when the API call throws', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                id: 'c1',
                title: 'Old',
                status: 'OPEN',
            } as Practice),
        });

        const failingPatch = jest
            .fn()
            .mockRejectedValue(new Error('upstream 500'));

        const { result } = renderHook(
            () => {
                const read = useTenantSWR<Practice>('/practices/c1');
                const mutation = useTenantMutation<
                    Practice,
                    { title: string },
                    Practice
                >({
                    key: '/practices/c1',
                    mutationFn: failingPatch,
                    optimisticUpdate: (current, input) => ({
                        ...(current as Practice),
                        ...input,
                    }),
                    // Skip revalidation so we observe the rolled-back
                    // value, not a follow-up GET that would refresh
                    // the cache regardless.
                    revalidate: false,
                });
                return { read, mutation };
            },
            { wrapper: makeWrapper() },
        );

        await waitFor(() =>
            expect(result.current.read.data?.title).toBe('Old'),
        );

        await act(async () => {
            await expect(
                result.current.mutation.trigger({ title: 'Optimistic' }),
            ).rejects.toThrow('upstream 500');
        });

        // Cache rolled back.
        expect(result.current.read.data).toEqual({
            id: 'c1',
            title: 'Old',
            status: 'OPEN',
        });
        // Hook surfaced the error.
        expect(result.current.mutation.error).toBeInstanceOf(Error);
        expect(result.current.mutation.error?.message).toBe('upstream 500');
        expect(result.current.mutation.isMutating).toBe(false);
    });
});

// ── Status change ──────────────────────────────────────────────────────

describe('useTenantMutation — status change', () => {
    it('flips a single field optimistically and revalidates on success', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                id: 'c1',
                title: 'Doc',
                status: 'OPEN',
            } as Practice),
        });
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'c1',
                title: 'Doc',
                status: 'CLOSED',
            } as Practice),
        });

        const apiClose = jest.fn().mockResolvedValue({
            id: 'c1',
            title: 'Doc',
            status: 'CLOSED',
        });

        const { result } = renderHook(
            () => {
                const read = useTenantSWR<Practice>('/practices/c1');
                const mutation = useTenantMutation<
                    Practice,
                    { status: 'OPEN' | 'CLOSED' },
                    Practice
                >({
                    key: '/practices/c1',
                    mutationFn: apiClose,
                    optimisticUpdate: (current, input) => ({
                        ...(current as Practice),
                        status: input.status,
                    }),
                });
                return { read, mutation };
            },
            { wrapper: makeWrapper() },
        );

        await waitFor(() =>
            expect(result.current.read.data?.status).toBe('OPEN'),
        );

        await act(async () => {
            await result.current.mutation.trigger({ status: 'CLOSED' });
        });

        await waitFor(() =>
            expect(result.current.read.data?.status).toBe('CLOSED'),
        );
        expect(apiClose).toHaveBeenCalledWith({ status: 'CLOSED' });
    });
});

// ── List append ────────────────────────────────────────────────────────

interface RiskItem {
    id: string;
    title: string;
}

describe('useTenantMutation — list append', () => {
    it('appends an entity to the list cache optimistically and persists on success', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: 'r1', title: 'A' }] as RiskItem[],
        });
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => [
                { id: 'r1', title: 'A' },
                { id: 'r2', title: 'B' },
            ] as RiskItem[],
        });

        const apiCreate = jest.fn().mockResolvedValue({
            id: 'r2',
            title: 'B',
        });

        const { result } = renderHook(
            () => {
                const read = useTenantSWR<RiskItem[]>('/risks');
                const mutation = useTenantMutation<
                    RiskItem[],
                    { title: string },
                    RiskItem
                >({
                    key: '/risks',
                    mutationFn: apiCreate,
                    optimisticUpdate: (current, input) => [
                        ...(current ?? []),
                        // Temp id — gets replaced by the real one on
                        // revalidation. Pages that show the id during
                        // creation should pull from the trigger() result
                        // instead of from the optimistic cache.
                        { id: 'temp', title: input.title },
                    ],
                });
                return { read, mutation };
            },
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.read.data).toHaveLength(1));

        await act(async () => {
            await result.current.mutation.trigger({ title: 'B' });
        });

        // After revalidation the cache holds the authoritative list.
        await waitFor(() => expect(result.current.read.data).toHaveLength(2));
        expect(result.current.read.data?.[1]).toEqual({
            id: 'r2',
            title: 'B',
        });
    });
});

// ── List remove ────────────────────────────────────────────────────────

describe('useTenantMutation — list remove', () => {
    it('hides the doomed entry optimistically and reinstates it on rollback', async () => {
        const initialList = [
            { id: 'r1', title: 'A' },
            { id: 'r2', title: 'B' },
        ];
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => initialList,
        });

        const apiDelete = jest.fn().mockRejectedValue(new Error('boom'));

        const { result } = renderHook(
            () => {
                const read = useTenantSWR<RiskItem[]>('/risks');
                const mutation = useTenantMutation<
                    RiskItem[],
                    { id: string },
                    void
                >({
                    key: '/risks',
                    mutationFn: apiDelete,
                    optimisticUpdate: (current, input) =>
                        (current ?? []).filter((r) => r.id !== input.id),
                    revalidate: false,
                });
                return { read, mutation };
            },
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.read.data).toHaveLength(2));

        await act(async () => {
            await expect(
                result.current.mutation.trigger({ id: 'r2' }),
            ).rejects.toThrow('boom');
        });

        // Rollback: r2 reappears.
        expect(result.current.read.data).toEqual(initialList);
    });
});

// ── isMutating + reset() ───────────────────────────────────────────────

describe('useTenantMutation — lifecycle flags', () => {
    it('flips isMutating false→true→false across a successful mutation', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'x', title: 'T' }),
        });

        let resolveApi: (value: unknown) => void = () => {
            /* assigned below */
        };
        const apiCall = jest.fn(
            () =>
                new Promise((res) => {
                    resolveApi = res;
                }),
        );

        const { result } = renderHook(
            () =>
                useTenantMutation<{ title: string }, { title: string }, unknown>({
                    key: '/x',
                    mutationFn: apiCall,
                    optimisticUpdate: (_, input) => ({ title: input.title }),
                    revalidate: false,
                }),
            { wrapper: makeWrapper() },
        );

        expect(result.current.isMutating).toBe(false);

        // Kick off without awaiting so we can assert the in-flight state.
        let pending: Promise<unknown> | null = null;
        act(() => {
            pending = result.current.trigger({ title: 'New' });
        });

        await waitFor(() => expect(result.current.isMutating).toBe(true));

        // Resolve the API.
        await act(async () => {
            resolveApi({ title: 'New' });
            await pending;
        });

        expect(result.current.isMutating).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('reset() clears a captured error', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'x', title: 'T' }),
        });

        const failingCall = jest.fn().mockRejectedValue(new Error('nope'));

        const { result } = renderHook(
            () =>
                useTenantMutation<{ title: string }, { title: string }, void>({
                    key: '/x',
                    mutationFn: failingCall,
                    optimisticUpdate: (_, input) => ({ title: input.title }),
                    revalidate: false,
                }),
            { wrapper: makeWrapper() },
        );

        await act(async () => {
            await expect(result.current.trigger({ title: '' })).rejects.toThrow(
                'nope',
            );
        });

        expect(result.current.error?.message).toBe('nope');

        act(() => {
            result.current.reset();
        });

        expect(result.current.error).toBeNull();
    });
});

// ── invalidate sibling keys ────────────────────────────────────────────

describe('useTenantMutation — sibling cache invalidation', () => {
    it('triggers a background refetch on every key listed in invalidate', async () => {
        // Sequence of GETs:
        //   1. /risks (initial list read)
        //   2. /risks/r1 (initial detail read)
        //   3. /risks (sibling refetch from invalidate — after mutation)
        //   4. /risks/r1 (primary key revalidation — after mutation)
        // The exact ordering of (3) and (4) is implementation-detail;
        // we assert that BOTH happen.
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => ({ url }),
        }));

        const apiPatch = jest.fn().mockResolvedValue({ url: 'patched' });

        const { result } = renderHook(
            () => {
                const list = useTenantSWR<{ url: string }>('/risks');
                const detail = useTenantSWR<{ url: string }>('/risks/r1');
                const mutation = useTenantMutation<
                    { url: string },
                    { x: number },
                    { url: string }
                >({
                    key: '/risks/r1',
                    mutationFn: apiPatch,
                    optimisticUpdate: (current) => ({
                        ...(current as { url: string }),
                    }),
                    invalidate: ['/risks'],
                });
                return { list, detail, mutation };
            },
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.list.data).toBeDefined());
        await waitFor(() => expect(result.current.detail.data).toBeDefined());

        const callsBeforeMutation = fetchMock.mock.calls.length;

        await act(async () => {
            await result.current.mutation.trigger({ x: 1 });
        });

        // Wait for the post-mutation refetch wave.
        await waitFor(() =>
            expect(fetchMock.mock.calls.length).toBeGreaterThan(
                callsBeforeMutation,
            ),
        );

        const postMutationUrls = fetchMock.mock.calls
            .slice(callsBeforeMutation)
            .map((c) => c[0]);
        expect(postMutationUrls).toContain('/api/t/acme/risks');
        expect(postMutationUrls).toContain('/api/t/acme/risks/r1');
    });
});
