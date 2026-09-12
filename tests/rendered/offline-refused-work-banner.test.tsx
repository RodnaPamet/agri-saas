/**
 * @jest-environment jsdom
 *
 * #923 — a refused write has to be SEEN, or parking it only swaps a silently
 * destroyed write for a silently stuck one.
 *
 * This is the lesson from #922 applied before the fact. There, a conflict
 * resolution UI existed, worked, and was mounted in exactly one place, so
 * journal conflicts could never be resolved — a complete, unreachable
 * mechanism. So this file asserts the MOUNT, not the component: the refusal
 * renders from `UnsyncedWorkBanner`, which `ClientProviders` mounts app-wide,
 * and it carries a per-item action that actually clears the row.
 *
 * It also pins the copy being STATUS-AWARE. The client sees only a number: a
 * 404 means the parent record is gone and re-entry is pointless, while a 400
 * means the payload was rejected and the work is not on the server. One string
 * for every 4xx would tell an operator to re-enter a compliance record that
 * either cannot be re-entered or already exists.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../messages/en.json';
import { UnsyncedWorkBanner } from '@/components/offline/UnsyncedWorkBanner';

const discardRefused = jest.fn(async () => {});
let refused: Array<{ id: string; label: string; refusedStatus?: number }> = [];

jest.mock('@/lib/offline/use-offline-sync', () => ({
    useOfflineSync: () => ({
        online: true,
        pending: 0,
        pendingPhotos: 0,
        lost: null,
        acknowledgeLostWork: jest.fn(),
        durability: null,
        refused,
        discardRefused,
        conflicts: [],
        resolveConflict: jest.fn(),
        submit: jest.fn(),
        submitPhoto: jest.fn(),
        flush: jest.fn(),
        queueGrowing: false,
        foreign: 0,
    }),
}));

function renderBanner() {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <UnsyncedWorkBanner />
        </NextIntlClientProvider>,
    );
}

describe('UnsyncedWorkBanner — refused work', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        refused = [];
    });

    it('renders nothing when nothing was refused', () => {
        renderBanner();
        expect(screen.queryByTestId('offline-refused-work')).toBeNull();
    });

    it('names the refused write, so the operator knows WHICH record failed', () => {
        refused = [{ id: 'a', label: 'Spray block 4', refusedStatus: 400 }];
        renderBanner();
        const panel = screen.getByTestId('offline-refused-work');
        expect(panel).toBeInTheDocument();
        expect(panel).toHaveTextContent('Spray block 4');
    });

    it('a 400 says to check the server before re-entering', () => {
        refused = [{ id: 'a', label: 'Spray block 4', refusedStatus: 400 }];
        renderBanner();
        expect(screen.getByTestId('offline-refused-work')).toHaveTextContent(
            messages.offline.refused.rejected,
        );
    });

    it('a 404 says the parent record is gone — different remedy, different words', () => {
        refused = [{ id: 'a', label: 'Photo for entry 12', refusedStatus: 404 }];
        renderBanner();
        const panel = screen.getByTestId('offline-refused-work');
        expect(panel).toHaveTextContent(messages.offline.refused.gone);
        expect(panel).not.toHaveTextContent(messages.offline.refused.rejected);
    });

    it('discarding is per-item and explicit', async () => {
        refused = [
            { id: 'a', label: 'Spray block 4', refusedStatus: 400 },
            { id: 'b', label: 'Harvest lot 9', refusedStatus: 400 },
        ];
        renderBanner();
        const buttons = screen.getAllByRole('button', { name: messages.offline.refused.discard });
        expect(buttons).toHaveLength(2);
        await userEvent.click(buttons[1]);
        await waitFor(() => expect(discardRefused).toHaveBeenCalledTimes(1));
        // The SECOND item, not whichever the handler happened to close over.
        expect(discardRefused).toHaveBeenCalledWith('b');
    });

    // CONTROL — there is deliberately no "dismiss all". A refusal means the
    // work is NOT on the server, so clearing the group without a person
    // deciding per item is the destruction #923 exists to stop.
    it('CONTROL: offers no group-level dismiss', () => {
        refused = [{ id: 'a', label: 'Spray block 4', refusedStatus: 400 }];
        renderBanner();
        const panel = screen.getByTestId('offline-refused-work');
        const buttons = Array.from(panel.querySelectorAll('button'));
        expect(buttons).toHaveLength(1);
    });
});
