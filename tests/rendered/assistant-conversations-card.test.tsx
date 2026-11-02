/**
 * «Какво помни асистентът» — the EXCHANGES half, on the web (#2695).
 *
 * The behaviours worth a test are the ones a reasonable implementation gets
 * wrong: what a flag-off person sees, what somebody with no history sees, and
 * that this card's delete is visibly about CONVERSATIONS rather than about the
 * profile points above it.
 */
jest.mock('next/navigation', () => ({
    // `Modal.Confirm` calls `useRouter()` and throws outside a Next tree.
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/account/profile',
    useSearchParams: () => new URLSearchParams(),
}));

const apiGet = jest.fn();
const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiDelete: (...a: unknown[]) => apiDelete(...a),
}));

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';

import { setViewport, restoreViewport } from './viewport';
import { AssistantConversationsCard } from '@/app/account/profile/AssistantConversationsCard';
// EN: `tests/rendered/setup.ts` mocks next-intl to resolve English whatever
// the provider is handed. The Bulgarian copy's parity is the i18n gate's job.
import messages from '../../messages/en/app.json';

const COPY = messages.account.assistantConversations;

/** A fresh SWR cache per mount — the default cache is module-scoped. */
function mount(enabled: boolean) {
    return render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <NextIntlClientProvider locale="en" messages={messages}>
                <AssistantConversationsCard enabled={enabled} />
            </NextIntlClientProvider>
        </SWRConfig>,
    );
}

beforeEach(() => {
    setViewport('mobile');
    apiGet.mockReset();
    apiDelete.mockReset();
    apiGet.mockResolvedValue({ conversations: [] });
});

afterEach(restoreViewport);

describe('the flag-off person', () => {
    it('sees NOTHING, and the card does not even ask', async () => {
        const { container } = mount(false);
        expect(container).toBeEmptyDOMElement();
        await waitFor(() => expect(apiGet).not.toHaveBeenCalled());
    });
});

describe('with no history', () => {
    it('says so, and offers no delete-all', async () => {
        mount(true);
        expect(await screen.findByText(COPY.emptyTitle)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: COPY.deleteAll })).toBeNull();
    });
});

describe('with conversations', () => {
    beforeEach(() => {
        apiGet.mockResolvedValue({
            conversations: [
                {
                    id: 'c1',
                    startedAt: '2026-11-01T09:00:00.000Z',
                    lastTurnAt: '2026-11-01T09:30:00.000Z',
                    turns: 4,
                    opening: 'какво да правя с белите мухи',
                },
                {
                    id: 'c2',
                    startedAt: '2026-10-30T08:00:00.000Z',
                    lastTurnAt: '2026-10-30T08:10:00.000Z',
                    turns: 2,
                    opening: null,
                },
            ],
        });
    });

    it('labels each row with the person’s own first question', async () => {
        mount(true);
        expect(await screen.findByText('какво да правя с белите мухи')).toBeInTheDocument();
    });

    it('gives an exchange with no question its own words, not a blank line', async () => {
        // `opening: null` is a real state — a conversation abandoned before a
        // question landed — and a blank row reads as a rendering bug.
        mount(true);
        expect(await screen.findByText(COPY.noOpening)).toBeInTheDocument();
    });

    it('reads the PERSON-scoped endpoint, never a tenant one', async () => {
        mount(true);
        await screen.findByText('какво да правя с белите мухи');
        // A tenant path would hide the exchanges this person had in their
        // other farms, and would hide them silently.
        expect(apiGet).toHaveBeenCalledWith('/api/account/assistant-conversations');
    });

    it('deletes ONE through the undo toast, not immediately', async () => {
        mount(true);
        const buttons = await screen.findAllByRole('button', { name: COPY.delete });
        fireEvent.click(buttons[0]);
        // The toast owns the 5s window, so nothing is sent on the click.
        expect(apiDelete).not.toHaveBeenCalled();
    });
});

describe('delete-all on BOTH devices — the confirm switches implementation', () => {
    beforeEach(() => {
        apiGet.mockResolvedValue({
            conversations: [
                {
                    id: 'c1',
                    startedAt: '2026-11-01T09:00:00.000Z',
                    lastTurnAt: '2026-11-01T09:30:00.000Z',
                    turns: 4,
                    opening: 'нещо',
                },
            ],
        });
    });

    it.each(['desktop', 'mobile'] as const)('confirms first, and says the POINTS are kept (%s)', async (viewport) => {
        setViewport(viewport);
        mount(true);
        fireEvent.click(await screen.findByRole('button', { name: COPY.deleteAll }));

        // Radix renders the title twice — visible plus an a11y copy.
        expect((await screen.findAllByText(COPY.deleteAllConfirmTitle)).length).toBeGreaterThan(0);
        expect(apiDelete).not.toHaveBeenCalled();

        // The body must say the profile points SURVIVE. Without it a person
        // reasonably reads "delete all conversations" as deleting everything
        // the assistant knows — two controls, two scopes, and the copy is the
        // only thing that distinguishes them.
        expect(COPY.deleteAllConfirmBody).toMatch(/remembered points are kept/i);
    });
});
