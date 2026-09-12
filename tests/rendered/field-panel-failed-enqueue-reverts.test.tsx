/**
 * @jest-environment jsdom
 *
 * #933 — a failed enqueue must not leave a phantom "Done" on screen.
 *
 * `OfflineFieldPanel` writes the optimistic state AND persists the snapshot
 * before the send is attempted. When `submit` throws — IndexedDB unavailable,
 * quota exhausted, the store refusing the item — the catch reported the failure
 * and "reverted" with `await mutate()`.
 *
 * That is not the inverse of anything, and the case where it matters is exactly
 * the case where it cannot work: the mark never reached the server, so a
 * refetch returns data deep-equal to what SWR already holds, SWR keeps the SAME
 * object reference, and the `[data, taskId]` effect that mirrors server→view
 * never re-runs. Offline the refetch cannot even resolve.
 *
 * So the row read DONE, the message said it was reverted, the snapshot on disk
 * was the optimistic one, and the outbox was EMPTY — nothing queued, no pending
 * pill, no loss record. A fourth state that reads exactly like "on the server",
 * arriving on the one path where the queue cannot be the safety net.
 *
 * The assertions below are about the VIEW and the SNAPSHOT, not about `mutate`
 * being called — calling it was never the problem.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/en.json';

const saveFieldSnapshot = jest.fn();
const readFieldSnapshot = jest.fn((..._a: unknown[]) => undefined);
jest.mock('@/lib/offline/field-snapshot', () => ({
    saveFieldSnapshot: (...a: unknown[]) => saveFieldSnapshot(...a),
    readFieldSnapshot: (...a: unknown[]) => readFieldSnapshot(...a),
    clearFieldSnapshot: jest.fn(),
}));

const submit = jest.fn();
const mutate = jest.fn(async () => undefined);
jest.mock('@/lib/offline/use-offline-sync', () => ({
    useOfflineSync: () => ({
        online: false,
        pending: 0,
        pendingPhotos: 0,
        queueGrowing: false,
        foreign: 0,
        durability: null,
        submit,
        submitPhoto: jest.fn(),
        flush: jest.fn(),
        conflicts: [],
        resolveConflict: jest.fn(),
        refused: [],
        discardRefused: jest.fn(),
        lost: null,
        acknowledgeLostWork: jest.fn(),
    }),
}));

const VIEW = {
    task: { id: 't1', key: 'OP-1', title: 'Spray north block', status: 'IN_PROGRESS' },
    lines: [
        { id: 'l1', status: 'PENDING', doseValue: 2, version: 3, parcel: { id: 'p1', name: 'Parcel A' } },
    ],
    parcels: [{ id: 'p1', name: 'Parcel A', geometry: null }],
    location: { id: 'loc1', name: 'North', boundsJson: null },
    progress: { total: 1, done: 0 },
};

// Stable reference on every call — this is the crux. SWR holds one object for
// unchanged server data, which is why `mutate()` could never revert anything.
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: VIEW, error: undefined, isLoading: false, mutate }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/field/t1',
    useSearchParams: () => new URLSearchParams(),
}));

import { OfflineFieldPanel } from '@/components/offline/OfflineFieldPanel';

const OFFLINE = messages.offline as unknown as Record<string, string>;

function mount() {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <OfflineFieldPanel taskId="t1" />
        </NextIntlClientProvider>,
    );
}

/** The snapshot the component last persisted. */
function lastSnapshot() {
    const calls = saveFieldSnapshot.mock.calls;
    return calls.length ? (calls[calls.length - 1][1] as typeof VIEW) : null;
}

async function clickDone() {
    const btn = await screen.findByRole('button', { name: /done/i });
    fireEvent.click(btn);
}

describe('#933 — a failed enqueue reverts the optimistic mark', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        readFieldSnapshot.mockReturnValue(undefined);
    });

    it('restores the line to PENDING in the PERSISTED snapshot', async () => {
        submit.mockRejectedValue(new Error('offline photo queue unavailable (no IndexedDB)'));
        mount();
        await clickDone();

        await waitFor(() => expect(submit).toHaveBeenCalled());
        // The optimistic snapshot was written first; the LAST one must undo it.
        await waitFor(() => {
            const snap = lastSnapshot();
            expect(snap?.lines[0].status).toBe('PENDING');
        });
        expect(lastSnapshot()?.progress.done).toBe(0);
    });

    it('tells the operator it failed', async () => {
        submit.mockRejectedValue(new Error('nope'));
        mount();
        await clickDone();
        await waitFor(() =>
            expect(screen.getByText(OFFLINE.saveError)).toBeInTheDocument(),
        );
    });

    // CONTROL — a SUCCESSFUL queue must keep the optimistic DONE. Without this,
    // a build that reverted unconditionally would satisfy the cases above while
    // undoing every mark an operator makes offline.
    it('CONTROL: a queued mark KEEPS the optimistic DONE', async () => {
        submit.mockResolvedValue('queued');
        mount();
        await clickDone();

        await waitFor(() => expect(submit).toHaveBeenCalled());
        await waitFor(() => expect(lastSnapshot()?.lines[0].status).toBe('DONE'));
        expect(lastSnapshot()?.progress.done).toBe(1);
        expect(screen.queryByText(OFFLINE.saveError)).toBeNull();
    });

    // CONTROL — the optimistic write itself still happens, or "reverts
    // correctly" would be satisfied by never applying the mark at all.
    it('CONTROL: the optimistic write is applied before the send', async () => {
        submit.mockImplementation(async () => {
            // At this moment the optimistic snapshot must already be persisted.
            expect(lastSnapshot()?.lines[0].status).toBe('DONE');
            return 'queued';
        });
        mount();
        await clickDone();
        await waitFor(() => expect(submit).toHaveBeenCalled());
    });
});
