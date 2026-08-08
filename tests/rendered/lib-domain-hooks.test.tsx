/**
 * Zero-coverage in-scope hooks, wave 5: `src/lib/hooks/*`.
 *
 * This is the group the #398 worklist actually meant by "hooks" — the gate
 * scores `src/app-layer/**` and `src/lib/**` only, so these count and the
 * `src/components/ui/hooks/` set covered in #416 does not.
 *
 * The shape is a small engine plus a lot of surface:
 *
 *   - `use-api.ts` holds all the behaviour — the fetch lifecycle, the
 *     skip-when-no-url rule, error normalisation, and the ref-as-mailbox
 *     that lets `refetch` stay stable while the URL moves underneath it.
 *   - the six domain modules are near-identical five-function wrappers.
 *     Individually trivial; collectively ~30 exported functions that were
 *     each counted as uncovered, which is one of the two metrics under
 *     the floor.
 *
 * So `useApi` / `useMutation` get real behavioural tests, and the domain
 * wrappers get a table-driven pass that asserts the one thing that can
 * actually be wrong in a copy-pasted file: the URL and the verb. A
 * transposed path (`/risks` in `use-tasks.ts`) is invisible to TypeScript
 * and is exactly the bug this shape invites.
 */
import { renderHook, act, waitFor } from '@testing-library/react';

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiPatch = jest.fn();
const mockApiDelete = jest.fn();

class FakeApiClientError extends Error {
    status: number;
    constructor(message: string, status = 500) {
        super(message);
        this.name = 'ApiClientError';
        this.status = status;
    }
}

jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => mockApiGet(...a),
    apiPost: (...a: unknown[]) => mockApiPost(...a),
    apiPatch: (...a: unknown[]) => mockApiPatch(...a),
    apiDelete: (...a: unknown[]) => mockApiDelete(...a),
    ApiClientError: FakeApiClientError,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) =>
        `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { useApi, useMutation } from '@/lib/hooks/use-api';
import * as controls from '@/lib/hooks/use-controls';
import * as policies from '@/lib/hooks/use-policies';
import * as tasks from '@/lib/hooks/use-tasks';
import * as assets from '@/lib/hooks/use-assets';
import * as evidence from '@/lib/hooks/use-evidence';
import * as barrel from '@/lib/hooks';

beforeEach(() => {
    jest.clearAllMocks();
    mockApiGet.mockResolvedValue([]);
    mockApiPost.mockResolvedValue({ id: 'new-1' });
    mockApiPatch.mockResolvedValue({ id: 'upd-1' });
    mockApiDelete.mockResolvedValue(undefined);
});

// ─── useApi ──────────────────────────────────────────────────────────

describe('useApi', () => {
    it('fetches on mount and reports the loading lifecycle', async () => {
        mockApiGet.mockResolvedValue([{ id: 'c1' }]);

        const { result } = renderHook(() => useApi<unknown[]>('/api/t/acme/controls'));

        // Starts loading immediately — `useState(!!url)`, so there is no
        // first frame that claims "loaded and empty".
        expect(result.current.loading).toBe(true);
        expect(result.current.data).toBeNull();

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual([{ id: 'c1' }]);
        expect(result.current.error).toBeNull();
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
    ])('skips fetching entirely for a %s url', async (_label, url) => {
        // The conditional-fetch idiom: callers pass null to mean "not ready
        // yet" (no id in the route yet). Loading must start false, or every
        // dependent list renders a spinner that never resolves.
        const { result } = renderHook(() => useApi<unknown>(url));

        expect(result.current.loading).toBe(false);
        expect(result.current.data).toBeNull();
        expect(mockApiGet).not.toHaveBeenCalled();
    });

    it('captures an ApiClientError without clobbering it', async () => {
        const err = new FakeApiClientError('Forbidden', 403);
        mockApiGet.mockRejectedValue(err);

        const { result } = renderHook(() => useApi<unknown>('/api/t/acme/controls'));

        await waitFor(() => expect(result.current.loading).toBe(false));
        // The typed error must survive — callers branch on `.status`.
        expect(result.current.error).toBe(err);
        expect(result.current.data).toBeNull();
    });

    it('normalises a non-Error rejection into an Error', async () => {
        // fetch/JSON layers can reject with a string; storing it raw would
        // make `error.message` undefined at every call site.
        mockApiGet.mockRejectedValue('gateway timeout');

        const { result } = renderHook(() => useApi<unknown>('/api/t/acme/controls'));

        await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
        expect(result.current.error?.message).toBe('gateway timeout');
    });

    it('clears a previous error on a successful refetch', async () => {
        mockApiGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(['ok']);

        const { result } = renderHook(() => useApi<unknown[]>('/api/t/acme/controls'));
        await waitFor(() => expect(result.current.error).not.toBeNull());

        await act(async () => {
            await result.current.refetch();
        });

        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual(['ok']);
    });

    it('refetches against the CURRENT url after it changes', async () => {
        // The ref-as-mailbox: `refetch` is memoised on `[schema]` only, so
        // without the ref it would keep fetching the URL it closed over.
        const { result, rerender } = renderHook(({ url }) => useApi<unknown>(url), {
            initialProps: { url: '/api/t/acme/controls/c1' },
        });
        await waitFor(() => expect(result.current.loading).toBe(false));

        rerender({ url: '/api/t/acme/controls/c2' });
        await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2));
        expect(mockApiGet).toHaveBeenLastCalledWith('/api/t/acme/controls/c2', undefined);

        mockApiGet.mockClear();
        await act(async () => {
            await result.current.refetch();
        });
        expect(mockApiGet).toHaveBeenCalledWith('/api/t/acme/controls/c2', undefined);
    });

    it('refetch is a no-op once the url has gone away', async () => {
        const { result, rerender } = renderHook(
            ({ url }: { url: string | null }) => useApi<unknown>(url),
            { initialProps: { url: '/api/t/acme/controls' as string | null } },
        );
        await waitFor(() => expect(result.current.loading).toBe(false));

        rerender({ url: null });
        mockApiGet.mockClear();

        await act(async () => {
            await result.current.refetch();
        });

        expect(mockApiGet).not.toHaveBeenCalled();
    });

    it('forwards the zod schema to the client for dev-mode validation', async () => {
        const schema = { parse: jest.fn() } as never;

        renderHook(() => useApi<unknown>('/api/t/acme/controls', schema));

        await waitFor(() =>
            expect(mockApiGet).toHaveBeenCalledWith('/api/t/acme/controls', schema),
        );
    });
});

// ─── useMutation ─────────────────────────────────────────────────────

describe('useMutation', () => {
    it('runs the mutation and returns its result', async () => {
        const fn = jest.fn().mockResolvedValue({ id: 'r1' });
        const { result } = renderHook(() => useMutation(fn));

        expect(result.current.loading).toBe(false);

        let returned: unknown;
        await act(async () => {
            returned = await result.current.mutate({ title: 'x' });
        });

        expect(returned).toEqual({ id: 'r1' });
        expect(fn).toHaveBeenCalledWith({ title: 'x' });
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('records the error AND rethrows it', async () => {
        // Both halves matter: the form needs the thrown rejection to keep
        // the dialog open, and the hook state drives the inline message.
        const err = new Error('422 validation');
        const { result } = renderHook(() => useMutation(jest.fn().mockRejectedValue(err)));

        await act(async () => {
            await expect(result.current.mutate({})).rejects.toThrow('422 validation');
        });

        expect(result.current.error).toBe(err);
        expect(result.current.loading).toBe(false);
    });

    it('normalises a non-Error rejection before rethrowing', async () => {
        const { result } = renderHook(() => useMutation(jest.fn().mockRejectedValue('nope')));

        await act(async () => {
            await expect(result.current.mutate({})).rejects.toBeInstanceOf(Error);
        });

        expect(result.current.error?.message).toBe('nope');
    });

    it('clears a previous error when a retry succeeds', async () => {
        const fn = jest.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce('ok');
        const { result } = renderHook(() => useMutation(fn));

        await act(async () => {
            await expect(result.current.mutate({})).rejects.toThrow();
        });
        expect(result.current.error).not.toBeNull();

        await act(async () => {
            await result.current.mutate({});
        });
        expect(result.current.error).toBeNull();
    });
});

// ─── domain wrappers ─────────────────────────────────────────────────

/**
 * Each module is the same five-function shape over a different path. The
 * only thing a copy-paste can get wrong is the path or the verb, and
 * TypeScript cannot see either — so that is what is asserted.
 */
const DOMAINS = [
    { name: 'controls', mod: controls, path: 'controls', list: 'useControls', detail: 'useControl', create: 'useCreateControl', update: 'useUpdateControl', remove: 'useDeleteControl' },
    { name: 'policies', mod: policies, path: 'policies', list: 'usePolicies', detail: 'usePolicy', create: 'useCreatePolicy', update: 'useUpdatePolicy', remove: 'useDeletePolicy' },
    { name: 'tasks', mod: tasks, path: 'tasks', list: 'useTasks', detail: 'useTask', create: 'useCreateTask', update: 'useUpdateTask', remove: 'useDeleteTask' },
    { name: 'assets', mod: assets, path: 'assets', list: 'useAssets', detail: 'useAsset', create: 'useCreateAsset', update: 'useUpdateAsset', remove: 'useDeleteAsset' },
    // Evidence has no PATCH surface — an evidence item is replaced, not edited.
    { name: 'evidence', mod: evidence, path: 'evidence', list: 'useEvidence', detail: 'useEvidenceItem', create: 'useCreateEvidence', update: null, remove: 'useDeleteEvidence' },
] as const;

type HookModule = Record<string, (...args: never[]) => unknown>;

describe.each(DOMAINS)('$name hooks', (d) => {
    const mod = d.mod as unknown as HookModule;

    it('lists from the tenant-scoped collection url', async () => {
        renderHook(() => mod[d.list]());

        await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
        expect(mockApiGet.mock.calls[0][0]).toBe(`/api/t/acme/${d.path}`);
        // A list schema is always passed — the array wrapper is easy to omit.
        expect(mockApiGet.mock.calls[0][1]).toBeDefined();
    });

    it('fetches one item by id', async () => {
        renderHook(() => mod[d.detail]('id-1' as never));

        await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
        expect(mockApiGet.mock.calls[0][0]).toBe(`/api/t/acme/${d.path}/id-1`);
    });

    it('does not fetch a detail with no id', () => {
        // The `id ? url : null` branch — every detail page renders once
        // before its route param resolves.
        renderHook(() => mod[d.detail](null as never));
        expect(mockApiGet).not.toHaveBeenCalled();
    });

    it('creates with POST to the collection url', async () => {
        const { result } = renderHook(() => mod[d.create]() as { mutate: (i: unknown) => Promise<unknown> });

        await act(async () => {
            await result.current.mutate({ name: 'x' });
        });

        expect(mockApiPost).toHaveBeenCalledWith(`/api/t/acme/${d.path}`, { name: 'x' });
        expect(mockApiPatch).not.toHaveBeenCalled();
    });

    it('deletes with DELETE to the item url', async () => {
        const { result } = renderHook(() => mod[d.remove]() as { mutate: (i: unknown) => Promise<unknown> });

        await act(async () => {
            await result.current.mutate('id-9');
        });

        expect(mockApiDelete).toHaveBeenCalledWith(`/api/t/acme/${d.path}/id-9`);
    });

    if (d.update) {
        it('updates with PATCH to the item url', async () => {
            const { result } = renderHook(
                () => mod[d.update as string]('id-2' as never) as { mutate: (i: unknown) => Promise<unknown> },
            );

            await act(async () => {
                await result.current.mutate({ name: 'y' });
            });

            expect(mockApiPatch).toHaveBeenCalledWith(`/api/t/acme/${d.path}/id-2`, { name: 'y' });
        });
    }
});

// ─── the one hook that breaks the pattern ────────────────────────────

describe('useControlDashboard', () => {
    it('reads the aggregate endpoint, not the collection', async () => {
        // Controls is the only domain with a dashboard rollup, so it is the
        // one function the table-driven pass above cannot reach.
        renderHook(() => controls.useControlDashboard());

        await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
        expect(mockApiGet.mock.calls[0][0]).toBe('/api/t/acme/controls/dashboard');
    });
});

// ─── barrel ──────────────────────────────────────────────────────────

describe('@/lib/hooks barrel', () => {
    it('re-exports every domain hook under its documented name', () => {
        // The barrel is the documented import path, so a rename that misses
        // it breaks callers with a runtime undefined rather than a type error.
        for (const d of DOMAINS) {
            for (const key of [d.list, d.detail, d.create, d.remove, d.update]) {
                if (!key) continue;
                expect(typeof (barrel as unknown as HookModule)[key]).toBe('function');
            }
        }
    });

    it('re-exports the shared primitives', () => {
        expect(typeof (barrel as unknown as HookModule).useControlDashboard).toBe('function');
        for (const key of ['useApi', 'useMutation', 'useTenantSWR', 'useTenantMutation', 'useKeyboardShortcut']) {
            expect(typeof (barrel as unknown as HookModule)[key]).toBe('function');
        }
    });
});
