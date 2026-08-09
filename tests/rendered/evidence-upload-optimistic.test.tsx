/**
 * Epic 69 pilot #3 — evidence upload optimistic-append behaviour.
 *
 * The headline UX of this migration: when a user uploads a file, a
 * pending row appears in the evidence list IMMEDIATELY — before the
 * multipart POST resolves — so the page feels instant on slow
 * networks. The same `useTenantMutation` lifecycle protects against
 * a failed upload (the optimistic row rolls back) and against a
 * partial-success multi-file batch (each call gets its own
 * cache snapshot).
 *
 * The integration involves two cache-touching components running in
 * the same SWR provider:
 *   - `EvidenceClient` reads the list via `useTenantSWR`.
 *   - `UploadEvidenceModal` writes via `useTenantMutation`.
 *
 * To pin the contract precisely we don't mount either of those
 * heavy components in the test — instead a minimal harness mirrors
 * the exact wiring (same SWR key from `CACHE_KEYS.evidence.list()`,
 * same `useTenantMutation` shape, same `optimisticUpdate` closure
 * that prepends a `PENDING_UPLOAD` row). If a future PR drifts the
 * shape, the structural ratchets in the existing
 * `tests/unit/practice-detail-shell-adoption.test.ts` template
 * (extended below) catch it on the production component.
 */

import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
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

interface EvidenceRow {
    id: string;
    title: string;
    status: string;
}

const initialList: EvidenceRow[] = [
    { id: 'ev-1', title: 'SOC2 audit pack', status: 'APPROVED' },
];

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
// Mirrors the real wiring: SWR read on `CACHE_KEYS.evidence.list()`
// + a `useTenantMutation` whose `optimisticUpdate` prepends a
// `PENDING_UPLOAD` row. The `Upload` button drives a single
// trigger() per click — concurrent uploads in the real modal are
// just N independent triggers.

function EvidenceUploadHarness() {
    const key = CACHE_KEYS.evidence.list();
    const read = useTenantSWR<EvidenceRow[]>(key);

    const mutation = useTenantMutation<
        EvidenceRow[],
        { tempId: string; title: string; failOnPurpose?: boolean },
        { id: string; title: string; status: string }
    >({
        key,
        mutationFn: async ({ title, failOnPurpose }) => {
            const res = await fetch(`/api/t/acme/evidence/uploads`, {
                method: 'POST',
                body: JSON.stringify({ title, failOnPurpose }),
            });
            if (!res.ok) {
                throw new Error('Upload failed');
            }
            return res.json();
        },
        optimisticUpdate: (current, vars) => [
            {
                id: vars.tempId,
                title: vars.title,
                status: 'PENDING_UPLOAD',
            },
            ...(current ?? []),
        ],
    });

    return (
        <div>
            <ul data-testid="evidence-list">
                {(read.data ?? []).map((row) => (
                    <li
                        key={row.id}
                        data-testid={`row-${row.id}`}
                        data-status={row.status}
                    >
                        {row.title}
                    </li>
                ))}
            </ul>
            <button
                onClick={() => {
                    const tempId = `temp:${Math.random().toString(36).slice(2)}`;
                    mutation
                        .trigger({ tempId, title: 'New evidence' })
                        .catch(() => {
                            /* rollback already applied */
                        });
                }}
            >
                Upload
            </button>
            <button
                onClick={() => {
                    const tempId = `temp-fail:${Math.random()
                        .toString(36)
                        .slice(2)}`;
                    mutation
                        .trigger({
                            tempId,
                            title: 'Doomed evidence',
                            failOnPurpose: true,
                        })
                        .catch(() => {
                            /* rollback already applied */
                        });
                }}
            >
                UploadFail
            </button>
        </div>
    );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Evidence upload — optimistic append lifecycle', () => {
    it('inserts a PENDING_UPLOAD row before the API resolves (optimistic append)', async () => {
        // Initial GET returns the single existing row.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => initialList,
        });
        // Hold the upload POST open until the assertion window closes.
        let resolveUpload: (value: unknown) => void = () => {
            /* assigned below */
        };
        fetchMock.mockImplementationOnce(
            () =>
                new Promise<Response>((res) => {
                    resolveUpload = (value) =>
                        res({
                            ok: true,
                            json: async () => value,
                        } as unknown as Response);
                }),
        );
        // Eventual revalidation GET — the new server-truth list
        // contains the original row + a server-id'd new row.
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => [
                { id: 'ev-2', title: 'New evidence', status: 'SUBMITTED' },
                ...initialList,
            ],
        });

        render(<EvidenceUploadHarness />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('row-ev-1')).toBeInTheDocument(),
        );

        // Click upload — optimistic row appears synchronously.
        await act(async () => {
            screen.getByText('Upload').click();
        });

        // Pending row visible in the list with PENDING_UPLOAD status,
        // ahead of the existing row.
        const list = await screen.findByTestId('evidence-list');
        const pendingRows = Array.from(list.children).filter((node) =>
            (node as HTMLElement).dataset.status === 'PENDING_UPLOAD',
        );
        expect(pendingRows).toHaveLength(1);
        expect(pendingRows[0].textContent).toBe('New evidence');

        // Cleanup — release the held promise so the test exits cleanly.
        await act(async () => {
            resolveUpload({ id: 'ev-2', title: 'New evidence', status: 'SUBMITTED' });
        });
    });

    it('rolls the optimistic row back on upload failure', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => initialList,
        });
        // Upload rejects → mutation throws → SWR rolls cache back.
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            json: async () => ({ error: 'upstream 500' }),
        });

        render(<EvidenceUploadHarness />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('row-ev-1')).toBeInTheDocument(),
        );

        await act(async () => {
            screen.getByText('UploadFail').click();
        });

        // No PENDING row remains; the failed optimistic insert
        // rolled back. The existing approved row is untouched.
        await waitFor(() => {
            const list = screen.getByTestId('evidence-list');
            const pendingRows = Array.from(list.children).filter(
                (node) =>
                    (node as HTMLElement).dataset.status === 'PENDING_UPLOAD',
            );
            expect(pendingRows).toHaveLength(0);
        });
        expect(screen.getByTestId('row-ev-1')).toBeInTheDocument();
    });

    it('post-success revalidation replaces the temp row with the server-truth row', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => initialList,
        });
        // Upload returns a real id immediately.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                id: 'ev-2',
                title: 'New evidence',
                status: 'SUBMITTED',
            }),
        });
        // Revalidation list — has the real server-id row, no temp.
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => [
                { id: 'ev-2', title: 'New evidence', status: 'SUBMITTED' },
                ...initialList,
            ],
        });

        render(<EvidenceUploadHarness />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('row-ev-1')).toBeInTheDocument(),
        );

        await act(async () => {
            screen.getByText('Upload').click();
        });

        // The cache eventually holds the server-truth row (real id),
        // not a `temp:…` placeholder.
        await waitFor(() =>
            expect(screen.getByTestId('row-ev-2')).toBeInTheDocument(),
        );
        const list = screen.getByTestId('evidence-list');
        const idsInDom = Array.from(list.children).map(
            (n) => (n as HTMLElement).dataset.testid,
        );
        // No `row-temp:*` survived.
        expect(idsInDom.some((id) => id?.startsWith('row-temp:'))).toBe(false);
    });
});
