/**
 * Epic 69 wave #4 — tasks bulk-mutation optimistic lifecycle.
 *
 * Pins the same optimistic-apply / rollback / revalidate contract
 * the dashboard / practice-status / evidence-upload tests pin, but
 * for the multi-row bulk pattern unique to the tasks list:
 *
 *   1. Selecting 3 tasks and applying "status: RESOLVED" flips
 *      every selected row's status synchronously, before the POST
 *      resolves.
 *   2. If the bulk endpoint fails, ALL three rows roll back to
 *      their pre-mutation status — the optimistic update is
 *      transactional from the user's perspective.
 *
 * The harness mirrors the production hook wiring exactly: same SWR
 * key (`CACHE_KEYS.tasks.list()`), same `useTenantMutation` shape,
 * same `optimisticUpdate` closure that walks the list and patches
 * every selected id.
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

interface Task {
    id: string;
    title: string;
    status: string;
}

const initialTasks: Task[] = [
    { id: 't1', title: 'Patch CIS 5.1', status: 'OPEN' },
    { id: 't2', title: 'Update SOC2 evidence', status: 'OPEN' },
    { id: 't3', title: 'Rotate admin keys', status: 'OPEN' },
];

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

function makeWrapper() {
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig
                value={{ provider: () => new Map(), shouldRetryOnError: false }}
            >
                {children}
            </SWRConfig>
        );
    };
}

function TasksBulkHarness({ failOnPurpose = false }: { failOnPurpose?: boolean }) {
    const key = CACHE_KEYS.tasks.list();
    const read = useTenantSWR<Task[]>(key);

    const mutation = useTenantMutation<
        Task[],
        { ids: string[]; status: string },
        unknown
    >({
        key,
        mutationFn: async () => {
            const res = await fetch('/api/t/acme/tasks/bulk/status', {
                method: 'POST',
            });
            if (!res.ok) throw new Error('Bulk action failed');
            return res.json();
        },
        optimisticUpdate: (current, { ids, status }) =>
            (current ?? []).map((task) =>
                ids.includes(task.id) ? { ...task, status } : task,
            ),
    });

    return (
        <div>
            <ul data-testid="task-list">
                {(read.data ?? []).map((task) => (
                    <li
                        key={task.id}
                        data-testid={`task-${task.id}`}
                        data-status={task.status}
                    >
                        {task.title}
                    </li>
                ))}
            </ul>
            <button
                onClick={() => {
                    mutation
                        .trigger({
                            ids: ['t1', 't2', 't3'],
                            status: failOnPurpose
                                ? 'INVALID_STATUS'
                                : 'RESOLVED',
                        })
                        .catch(() => {
                            /* rollback already applied */
                        });
                }}
            >
                ApplyBulk
            </button>
        </div>
    );
}

describe('Tasks bulk mutation — optimistic lifecycle', () => {
    it('flips every selected task status before the bulk POST resolves', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => initialTasks,
        });
        // Hold the bulk POST open so the optimistic state is observable.
        let resolveBulk: (value: unknown) => void = () => {
            /* assigned below */
        };
        fetchMock.mockImplementationOnce(
            () =>
                new Promise<Response>((res) => {
                    resolveBulk = (value) =>
                        res({
                            ok: true,
                            json: async () => value,
                        } as unknown as Response);
                }),
        );
        // Eventual revalidation GET — server confirms the change.
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () =>
                initialTasks.map((t) => ({ ...t, status: 'RESOLVED' })),
        });

        render(<TasksBulkHarness />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('task-t1')).toBeInTheDocument(),
        );
        // All three start OPEN.
        expect(
            (screen.getByTestId('task-t1') as HTMLElement).dataset.status,
        ).toBe('OPEN');

        await act(async () => {
            screen.getByText('ApplyBulk').click();
        });

        // All three flip synchronously to RESOLVED — before the POST
        // resolves.
        await waitFor(() => {
            for (const id of ['t1', 't2', 't3']) {
                expect(
                    (screen.getByTestId(`task-${id}`) as HTMLElement).dataset
                        .status,
                ).toBe('RESOLVED');
            }
        });

        // Cleanup.
        await act(async () => {
            resolveBulk({ ok: true });
        });
    });

    it('rolls every selected task back when the bulk POST throws', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => initialTasks,
        });
        // Bulk POST fails.
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid status' }),
        });

        render(<TasksBulkHarness failOnPurpose />, { wrapper: makeWrapper() });

        await waitFor(() =>
            expect(screen.getByTestId('task-t1')).toBeInTheDocument(),
        );

        await act(async () => {
            screen.getByText('ApplyBulk').click();
        });

        // Despite the optimistic prediction briefly applying
        // INVALID_STATUS to all three rows, the failed POST triggers
        // rollback. Final state for the user is back at OPEN for
        // every selected row.
        await waitFor(() => {
            for (const id of ['t1', 't2', 't3']) {
                expect(
                    (screen.getByTestId(`task-${id}`) as HTMLElement).dataset
                        .status,
                ).toBe('OPEN');
            }
        });
    });
});
