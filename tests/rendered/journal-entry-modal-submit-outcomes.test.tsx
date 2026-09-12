/**
 * @jest-environment jsdom
 *
 * #926 — what the OPERATOR sees for each outcome of a journal edit.
 *
 * `submit` resolves three ways and they have opposite futures: `'sent'` (the
 * server has it), `'queued'` (durably queued, every drain will retry), and
 * `'conflict'` (the server REFUSED it with a 409 and it is parked — skipped by
 * every drain until somebody resolves it).
 *
 * #921/#922 fixed the modal treating all three as "fine, close". That fix was
 * mutation-proved AT THE HOOK — `submit` returns a distinct `'conflict'` — but
 * nothing executed the surface, and the surface is where the defect actually
 * was: `setOpen(false)` with no `else`, so a refused correction closed the
 * modal exactly like a save and the operator's typed text went with it.
 *
 * `grep -rln JournalEntryModal tests/` returned only guards and E2E specs when
 * #922 shipped — no rendered test mounted this component at all. This is that
 * test, owed and filed at the time rather than skipped quietly.
 *
 * The seam is the `offlineSubmit` PROP the modal already accepts, so the
 * outcome is injected directly and no hook needs faking to steer it.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/en.json';
import { JournalEntryModal } from '@/app/t/[tenantSlug]/(app)/journal/JournalEntryModal';

// The Modal primitive calls useRouter (it owns the discard-guard navigation).
// Same shape every other rendered suite in this repo uses.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/journal',
    useSearchParams: () => new URLSearchParams(),
}));

// The modal reads five reference lists; none of them decide anything here.
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: undefined, error: undefined, isLoading: false, mutate: jest.fn() }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));
// Only the FALLBACK hook — every test below injects `offlineSubmit` instead,
// which is the seam that lets the outcome be chosen without faking a store.
jest.mock('@/lib/offline/use-offline-sync', () => ({
    useOfflineSync: () => ({ submit: jest.fn(async () => 'sent') }),
}));

const MODAL = messages.journal.entryModal as unknown as Record<string, string>;

const INITIAL = {
    id: 'e1',
    version: 3,
    type: 'ACTIVITY',
    status: 'DONE',
    title: 'Spray block 4',
    occurredAt: '2026-09-01T08:00:00.000Z',
    notes: 'corrected rate',
};

type Outcome = 'sent' | 'queued' | 'conflict';

function mountEdit(outcome: Outcome) {
    const offlineSubmit = jest.fn(async () => outcome);
    const setOpen = jest.fn();
    const onSaved = jest.fn();
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <JournalEntryModal
                open
                setOpen={setOpen}
                tenantSlug="acme"
                initial={INITIAL}
                onSaved={onSaved}
                offlineSubmit={offlineSubmit as never}
            />
        </NextIntlClientProvider>,
    );
    const form = document.getElementById('journal-entry-form') as HTMLFormElement;
    return { offlineSubmit, setOpen, onSaved, form };
}

describe('JournalEntryModal — the three submit outcomes an operator can hit', () => {
    it('CONFLICT: the modal stays OPEN and says what happened', async () => {
        const { setOpen, onSaved, form } = mountEdit('conflict');
        fireEvent.submit(form);

        await waitFor(() => {
            expect(screen.getByText(MODAL.saveConflict)).toBeInTheDocument();
        });
        // The whole defect: closing here is the app's universal success
        // affordance, and the operator's correction is parked where no journal
        // screen used to show it.
        expect(setOpen).not.toHaveBeenCalledWith(false);
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('CONFLICT: the typed text is still on screen to re-apply', async () => {
        const { form } = mountEdit('conflict');
        fireEvent.submit(form);
        await waitFor(() => expect(screen.getByText(MODAL.saveConflict)).toBeInTheDocument());
        // Keeping the modal open is only worth anything if it still holds the
        // edit — otherwise "stay open" is just a slower way to lose the work.
        expect(screen.getByDisplayValue('Spray block 4')).toBeInTheDocument();
    });

    // CONTROL — without this, a modal that NEVER closed would satisfy the
    // conflict assertions above.
    it('CONTROL: SENT closes the modal and reports the save', async () => {
        const { setOpen, onSaved, form } = mountEdit('sent');
        fireEvent.submit(form);

        await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
        expect(onSaved).toHaveBeenCalledWith({ id: 'e1' });
        expect(screen.queryByText(MODAL.saveConflict)).toBeNull();
    });

    // CONTROL — a genuine offline queue must also close, and must NOT claim a
    // server save. Both halves matter: closing proves the conflict case is not
    // just "any non-sent stays open", and the absent `onSaved` is what stops
    // the parent revalidating against a row the server does not have yet.
    it('CONTROL: QUEUED closes the modal but does not report a save', async () => {
        const { setOpen, onSaved, form } = mountEdit('queued');
        fireEvent.submit(form);

        await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
        expect(onSaved).not.toHaveBeenCalled();
        expect(screen.queryByText(MODAL.saveConflict)).toBeNull();
    });

    it('the edit carries the version it was opened with, as If-Match', async () => {
        const { offlineSubmit, form } = mountEdit('sent');
        fireEvent.submit(form);

        await waitFor(() => expect(offlineSubmit).toHaveBeenCalled());
        const input = (offlineSubmit.mock.calls[0] as unknown[])[0] as {
            method: string;
            url: string;
            ifMatch?: number;
        };
        expect(input.method).toBe('PATCH');
        expect(input.url).toBe('/api/t/acme/journal/e1');
        // Without the version the server cannot 409 a stale write, and the
        // optimistic lock #919 added is inert from this surface.
        expect(input.ifMatch).toBe(3);
    });
});
