/**
 * Epic 69 — `useTenantSWR` foundation tests.
 *
 * Pins the contract that lets consumer pages stop hand-rolling
 * `/api/t/${slug}/...` URLs:
 *
 *   1. The hook prefixes the path with `/api/t/{slug}` from the
 *      active TenantContext before passing the key to SWR.
 *   2. The returned shape is exactly the standard SWR surface
 *      (`data`, `error`, `isLoading`, `mutate`) — so adoption is a
 *      drop-in for any component that already knows SWR.
 *   3. Loading → success and loading → error state transitions match
 *      the `apiGet` error-mapping contract (non-2xx surfaces as
 *      `ApiClientError`).
 *   4. The null-key idiom skips fetching entirely.
 *   5. The configured deduping interval collapses simultaneous
 *      hooks pointing at the same endpoint to one HTTP call.
 *
 * Mocks: `useTenantApiUrl` is replaced with a slug-fixed builder so
 * the test doesn't need a full TenantProvider tree. `fetch` is mocked
 * per-test so we can assert URL shape and arrange responses.
 *
 * Each test wraps the hook in an `SWRConfig` provider with a fresh
 * `Map` cache so cross-test bleed (and SWR's process-wide cache) is
 * isolated.
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
import { ApiClientError } from '@/lib/api-client';

// ── fetch mock ─────────────────────────────────────────────────────────

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

// ── Wrapper that gives every test its own SWR cache ────────────────────

function makeWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => new Map() }}>
                {children}
            </SWRConfig>
        );
    };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('useTenantSWR — tenant-prefixed key construction', () => {
    it('rewrites a tenant-relative path to /api/t/{slug}/{path}', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => [{ id: 'c1' }],
        });

        const { result } = renderHook(
            () => useTenantSWR<Array<{ id: string }>>('/practices'),
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.data).toBeDefined());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/t/acme/practices',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('accepts a path without a leading slash and still prefixes correctly', async () => {
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });

        renderHook(() => useTenantSWR<unknown[]>('practices'), {
            wrapper: makeWrapper(),
        });

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/t/acme/practices',
            expect.anything(),
        );
    });

    it('skips fetching when path is null (SWR null-key idiom)', () => {
        renderHook(() => useTenantSWR<unknown>(null), {
            wrapper: makeWrapper(),
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips fetching when path is undefined', () => {
        renderHook(() => useTenantSWR<unknown>(undefined), {
            wrapper: makeWrapper(),
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('useTenantSWR — returned shape', () => {
    it('exposes the standard SWR fields (data / error / isLoading / mutate)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ok: true }),
        });

        const { result } = renderHook(
            () => useTenantSWR<{ ok: boolean }>('/ping'),
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.data).toBeDefined());

        expect(typeof result.current.isLoading).toBe('boolean');
        expect(typeof result.current.mutate).toBe('function');
        expect(result.current.error).toBeUndefined();
    });
});

describe('useTenantSWR — lifecycle states', () => {
    it('transitions from loading → data on success', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ count: 7 }),
        });

        const { result } = renderHook(
            () => useTenantSWR<{ count: number }>('/stats'),
            { wrapper: makeWrapper() },
        );

        // First synchronous render: loading, no data, no error.
        expect(result.current.isLoading).toBe(true);
        expect(result.current.data).toBeUndefined();
        expect(result.current.error).toBeUndefined();

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.data).toEqual({ count: 7 });
        expect(result.current.error).toBeUndefined();
    });

    it('transitions from loading → ApiClientError on a non-2xx response', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 404,
            json: async () => ({
                error: {
                    code: 'NOT_FOUND',
                    message: 'practice not found',
                    requestId: 'req-x',
                },
            }),
        });

        const { result } = renderHook(
            () => useTenantSWR<unknown>('/practices/missing', {
                // Disable retries so the test resolves quickly without
                // racing the default backoff.
                shouldRetryOnError: false,
            }),
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.error).toBeDefined());

        expect(result.current.error).toBeInstanceOf(ApiClientError);
        const err = result.current.error as ApiClientError;
        expect(err.status).toBe(404);
        expect(err.code).toBe('NOT_FOUND');
        expect(err.requestId).toBe('req-x');
        expect(result.current.data).toBeUndefined();
        expect(result.current.isLoading).toBe(false);
    });

    it('mutate(undefined) re-fetches the same tenant-prefixed URL', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ v: 1 }),
        });

        const { result } = renderHook(
            () => useTenantSWR<{ v: number }>('/widget'),
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(result.current.data).toBeDefined());

        const callsAfterMount = fetchMock.mock.calls.length;
        await act(async () => {
            await result.current.mutate();
        });

        // Subsequent fetch hits the SAME URL — the prefix logic
        // doesn't re-derive a different key on revalidation.
        const lastCall = fetchMock.mock.calls.at(-1);
        expect(lastCall?.[0]).toBe('/api/t/acme/widget');
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });
});

describe('useTenantSWR — composes with CACHE_KEYS registry', () => {
    // Late-import to keep the registry test surface optional —
    // adding it here also confirms there is no module-load cycle
    // between `useTenantSWR` and `swr-keys` (registry is data-only).

    const { CACHE_KEYS } = require('@/lib/swr-keys') as typeof import('@/lib/swr-keys');

    it('CACHE_KEYS.practices.list() resolves to /api/t/{slug}/practices', async () => {
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });

        renderHook(() => useTenantSWR<unknown[]>(CACHE_KEYS.practices.list()), {
            wrapper: makeWrapper(),
        });

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/t/acme/practices',
            expect.anything(),
        );
    });

    it('CACHE_KEYS.risks.detail(id) interpolates correctly into the absolute URL', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'r9' }),
        });

        renderHook(
            () => useTenantSWR<{ id: string }>(CACHE_KEYS.risks.detail('r9')),
            { wrapper: makeWrapper() },
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/t/acme/risks/r9',
            expect.anything(),
        );
    });
});

describe('useTenantSWR — deduping', () => {
    // Each `renderHook` call mounts its own React root with its own
    // wrapper invocation. To share a cache across hooks (which is
    // what the deduping test needs to verify), we render both hooks
    // inside the SAME component under one SWRConfig provider.
    it('two simultaneous hooks pointing at the same path share one fetch', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => [{ id: 'r1' }],
        });

        const { result } = renderHook(
            () => {
                const a = useTenantSWR<unknown[]>('/risks');
                const b = useTenantSWR<unknown[]>('/risks');
                return { a, b };
            },
            { wrapper: makeWrapper() },
        );

        // Both hooks resolve from the single in-flight fetch.
        await waitFor(() => expect(result.current.a.data).toBeDefined());
        await waitFor(() => expect(result.current.b.data).toBeDefined());
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('different tenant-relative paths produce different cache entries', async () => {
        fetchMock.mockImplementation(async (url: string) => ({
            ok: true,
            json: async () => ({ url }),
        }));

        const { result } = renderHook(
            () => {
                const practices = useTenantSWR<{ url: string }>('/practices');
                const risks = useTenantSWR<{ url: string }>('/risks');
                return { practices, risks };
            },
            { wrapper: makeWrapper() },
        );

        await waitFor(() =>
            expect(result.current.practices.data).toBeDefined(),
        );
        await waitFor(() => expect(result.current.risks.data).toBeDefined());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
        expect(urls).toEqual(['/api/t/acme/practices', '/api/t/acme/risks']);
    });
});
