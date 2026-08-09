/**
 * Epic 69 pilot #2 — practice-status optimistic mutation behaviour.
 *
 * The practice detail page used to flip `practice.status` via
 * `fetch(POST) → await refetch() → invalidateQueries(list)`. The
 * badge stayed on the OLD value for the entire round-trip, which
 * produced the "did the click land?" UX problem on slow networks.
 *
 * The Epic 69 migration converts the flow to `useTenantMutation`
 * with `optimisticUpdate`. This test pins the three load-bearing
 * behaviours — testing the migration works in isolation, without
 * having to mount the full 1300-line page:
 *
 *   1. **Optimistic apply.** As soon as `trigger({ status: NEW })`
 *      fires, every `useTenantSWR(CACHE_KEYS.practices.pageData(id))`
 *      consumer re-renders with the predicted status — synchronously,
 *      before the API responds.
 *
 *   2. **Rollback on API failure.** If the POST throws (4xx/5xx or
 *      network), the cache snapshot is restored automatically by
 *      `rollbackOnError: true` (the hook's default). The badge
 *      flips back to the original status with no spinner thrash.
 *
 *   3. **Background revalidation on success.** After the API
 *      resolves successfully, SWR refetches the page-data key. The
 *      cache ends up holding the server-authoritative value (which
 *      may differ from the optimistic prediction in the corner
 *      case where the server applied additional side effects).
 *
 * The test exercises a tiny `<StatusPractice>` harness that mirrors
 * the real component shape — read via `useTenantSWR` against
 * `CACHE_KEYS.practices.pageData(id)`, write via `useTenantMutation`.
 * Pinning the contract here, instead of mounting the whole detail
 * page, keeps the test fast and the assertions targeted at exactly
 * the migration behaviour.
 */

import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';

// ── Fixtures ───────────────────────────────────────────────────────────

interface PracticePageDataDTO {
    practice: { id: string; name: string; status: string };
    syncStatus: null;
}

const buildPayload = (status: string): PracticePageDataDTO => ({
    practice: { id: 'ctrl-1', name: 'Access logging', status },
    syncStatus: null,
});

// ── Mocks ──────────────────────────────────────────────────────────────

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
                    shouldRetryOnError: false,
                }}
            >
                {children}
            </SWRConfig>
        );
    };
}

// ── Harness ────────────────────────────────────────────────────────────
//
// Mirror-shape of the real detail-page wiring: same key, same
// optimistic-update closure, same invalidate fan-out. The harness
// renders only the status badge + a button per status so the test
// can assert badge text changes without dragging the whole page in.

function StatusPractice({ practiceId }: { practiceId: string }) {
    const key = CACHE_KEYS.practices.pageData(practiceId);
    const read = useTenantSWR<PracticePageDataDTO>(key);

    const mutation = useTenantMutation<
        PracticePageDataDTO,
        { status: string },
        unknown
    >({
        key,
        mutationFn: async ({ status }) => {
            const res = await fetch(
                `/api/t/acme/practices/${practiceId}/status`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                },
            );
            if (!res.ok) throw new Error('Status update failed');
            return res.json().catch(() => null);
        },
        optimisticUpdate: (current, { status }) =>
            current
                ? { ...current, practice: { ...current.practice, status } }
                : (current as unknown as PracticePageDataDTO),
        invalidate: [CACHE_KEYS.practices.list()],
    });

    return (
        <div>
            <span data-testid="status-badge">
                {read.data?.practice.status ?? '...'}
            </span>
            {['NOT_STARTED', 'IN_PROGRESS', 'IMPLEMENTED'].map((s) => (
                <button
                    key={s}
                    type="button"
                    onClick={() => {
                        // Fire-and-forget — the catch is intentional for
                        // the rollback test. The hook still re-throws so
                        // production code can `try/catch` for toast UX.
                        mutation.trigger({ status: s }).catch(() => {});
                    }}
                >
                    {s}
                </button>
            ))}
        </div>
    );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Practice status — optimistic mutation lifecycle', () => {
    it('flips the badge synchronously on click before the POST resolves (optimistic apply)', async () => {
        // Initial GET returns NOT_STARTED.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => buildPayload('NOT_STARTED'),
        });

        // The status POST never resolves during the assertion window —
        // we want to observe the optimistic state before the network
        // call returns. (`mockImplementationOnce` returning a never-
        // resolving promise simulates a slow upstream.)
        let resolveApi: (value: unknown) => void = () => {
            /* assigned below */
        };
        fetchMock.mockImplementationOnce(
            () =>
                new Promise<Response>((res) => {
                    resolveApi = (value) =>
                        res({
                            ok: true,
                            json: async () => value,
                        } as unknown as Response);
                }),
        );
        // Final revalidation GET (after we eventually resolve the POST):
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => buildPayload('IMPLEMENTED'),
        });

        render(<StatusPractice practiceId="ctrl-1" />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('status-badge').textContent).toBe(
                'NOT_STARTED',
            ),
        );

        await userEvent.click(screen.getByText('IMPLEMENTED'));

        // Badge updated SYNCHRONOUSLY to the optimistic value while
        // the POST is still pending — the network call hasn't resolved
        // and the badge is already showing IMPLEMENTED.
        await waitFor(() =>
            expect(screen.getByTestId('status-badge').textContent).toBe(
                'IMPLEMENTED',
            ),
        );

        // Cleanup — release the held-open promise.
        await act(async () => {
            resolveApi({ ok: true });
        });
    });

    it('rolls back the badge when the POST throws (rollback on error)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => buildPayload('NOT_STARTED'),
        });
        // The status POST fails — non-2xx → mutationFn throws → SWR
        // rolls back the cache.
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => ({ error: 'upstream 500' }),
        });

        render(<StatusPractice practiceId="ctrl-1" />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('status-badge').textContent).toBe(
                'NOT_STARTED',
            ),
        );

        await userEvent.click(screen.getByText('IN_PROGRESS'));

        // Even though the optimistic update briefly applied
        // IN_PROGRESS, the failed POST triggers rollback. Final state
        // for the user is back at NOT_STARTED.
        await waitFor(() =>
            expect(screen.getByTestId('status-badge').textContent).toBe(
                'NOT_STARTED',
            ),
        );
    });

    it('background-revalidates after success and overwrites cache with the authoritative value', async () => {
        // The server's authoritative response will be IN_PROGRESS_2
        // (a deliberately weird status) — proving the revalidation
        // GET runs and the cache ends up holding what the SERVER says,
        // not what the client predicted.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => buildPayload('NOT_STARTED'),
        });
        // POST /status — server-side side effect happens here.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => null,
        });
        // Revalidation GET after the mutation resolves.
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => buildPayload('IN_PROGRESS_2'),
        });

        render(<StatusPractice practiceId="ctrl-1" />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('status-badge').textContent).toBe(
                'NOT_STARTED',
            ),
        );

        // User predicts IN_PROGRESS …
        await userEvent.click(screen.getByText('IN_PROGRESS'));
        // … but the server actually returned IN_PROGRESS_2 — the
        // revalidation overwrites the optimistic value with the
        // authoritative one.
        await waitFor(() =>
            expect(screen.getByTestId('status-badge').textContent).toBe(
                'IN_PROGRESS_2',
            ),
        );
    });
});
