/**
 * The exchange messaging screens — inbox and conversation.
 *
 * Covered behaviourally, not for a coverage number. These assert the four
 * rules that are invisible when broken:
 *
 *   - a RETRACTED message keeps its place and shows the tombstone, never its
 *     body. The server already nulls `body`, so a component that rendered it
 *     anyway would look right in every manual test and leak on the one row
 *     that mattered.
 *   - a failed send KEEPS the draft. Clearing optimistically loses what the
 *     operator typed to a dropped connection, and nothing on screen would say
 *     so afterwards.
 *   - a CLOSED thread has no composer at all — not a disabled one.
 *   - the read receipt fires ONCE per mount, not once per poll. The endpoint
 *     is monotonic so a repeat is harmless, which is exactly why a regression
 *     here would never surface as a bug report.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
    useLocale: () => 'en',
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), refresh: jest.fn(), replace: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/exchange/threads',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

const apiPost = jest.fn();
const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiDelete: (...a: unknown[]) => apiDelete(...a),
    apiGet: jest.fn(),
    apiPatch: jest.fn(),
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => swr(...a),
}));

import { ThreadsClient } from '@/app/t/[tenantSlug]/(app)/exchange/threads/ThreadsClient';
import { ThreadClient } from '@/app/t/[tenantSlug]/(app)/exchange/threads/[threadId]/ThreadClient';

const mutate = jest.fn();
function swrReturns(data: unknown, over: Record<string, unknown> = {}) {
    swr.mockReturnValue({ data, isLoading: false, error: undefined, mutate, ...over });
}

function msg(over: Record<string, unknown> = {}) {
    return {
        id: 'm1', senderTenantId: 't-them', mine: false,
        body: 'Имате ли още налично?', deleted: false,
        createdAt: '2026-09-20T08:00:00.000Z', ...over,
    };
}
function thread(over: Record<string, unknown> = {}) {
    return {
        id: 'th1', listingId: 'l1', listingCommodity: 'Wheat',
        role: 'seller', lastMessageAt: '2026-09-20T08:00:00.000Z',
        closed: false, unreadCount: 1, messages: [msg()], ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    apiPost.mockResolvedValue({});
    apiDelete.mockResolvedValue(undefined);
});

describe('inbox', () => {
    it('shows both sides in one list, and flags the unread one', () => {
        swrReturns({
            threads: [
                { id: 'a', listingId: 'l1', listingCommodity: 'Wheat', role: 'seller',
                  lastMessageAt: '2026-09-20T08:00:00.000Z', closed: false, hasUnread: true },
                { id: 'b', listingId: 'l2', listingCommodity: 'Barley', role: 'inquirer',
                  lastMessageAt: '2026-09-19T08:00:00.000Z', closed: false, hasUnread: false },
            ],
        });
        render(<ThreadsClient />);

        expect(screen.getByText('Wheat')).toBeInTheDocument();
        expect(screen.getByText('Barley')).toBeInTheDocument();
        // One inbox, both roles — the point of the screen.
        expect(screen.getByText('roleSeller')).toBeInTheDocument();
        expect(screen.getByText('roleInquirer')).toBeInTheDocument();
        // Exactly one unread badge: a component that rendered it unconditionally
        // would still pass an `exists` assertion.
        expect(screen.getAllByText('unread')).toHaveLength(1);
    });

    it('polls — an inbox that never refreshes is not an inbox', () => {
        swrReturns({ threads: [] });
        render(<ThreadsClient />);
        expect(swr).toHaveBeenCalledWith('/exchange/threads', { refreshInterval: 30_000 });
        expect(screen.getByText('inboxEmpty')).toBeInTheDocument();
    });
});

describe('conversation', () => {
    it('shows a retracted message as a tombstone and never its body', () => {
        swrReturns(thread({
            messages: [
                msg({ id: 'm1', body: 'still here' }),
                // Deliberately ADVERSARIAL: the server nulls `body` on delete,
                // so this row cannot arrive from our own API. It is shaped this
                // way to pin that the component keys on the `deleted` FLAG and
                // not on body-nullity — with `body: null` the assertion has no
                // teeth, because `m.body ?? tombstone` renders identically and
                // a mutation to exactly that passed.
                msg({ id: 'm2', mine: true, body: 'retracted text', deleted: true }),
            ],
        }));
        render(<ThreadClient threadId="th1" />);

        expect(screen.getByText('still here')).toBeInTheDocument();
        expect(screen.getByText('deleted')).toBeInTheDocument();
        expect(screen.queryByText('retracted text')).not.toBeInTheDocument();
        // The retraction keeps its place rather than vanishing.
        expect(screen.getAllByText(/you|them/)).toHaveLength(2);
        // A retracted message offers no "remove" — there is nothing left.
        expect(screen.queryByText('remove')).not.toBeInTheDocument();
    });

    it('KEEPS the draft when the send fails', async () => {
        const user = userEvent.setup();
        swrReturns(thread());
        // Reject the SEND only. `mockRejectedValueOnce` would have been
        // consumed by the read receipt, which fires first on mount and
        // swallows its own errors — the send would then have SUCCEEDED and
        // this test would have been asserting nothing.
        apiPost.mockImplementation((url: unknown) =>
            String(url).endsWith('/messages')
                ? Promise.reject(new Error('network'))
                : Promise.resolve({}),
        );
        render(<ThreadClient threadId="th1" />);

        const box = screen.getByPlaceholderText('composerPlaceholder');
        await user.type(box, 'Да, 40 тона.');
        await user.click(screen.getByRole('button', { name: 'send' }));

        expect(await screen.findByText('sendFailed')).toBeInTheDocument();
        // The whole point: the text survives the failure.
        expect(box).toHaveValue('Да, 40 тона.');
    });

    it('clears the draft only once the send succeeds', async () => {
        const user = userEvent.setup();
        swrReturns(thread());
        render(<ThreadClient threadId="th1" />);

        const box = screen.getByPlaceholderText('composerPlaceholder');
        await user.type(box, 'Да, 40 тона.');
        await user.click(screen.getByRole('button', { name: 'send' }));

        await waitFor(() => expect(box).toHaveValue(''));
        expect(apiPost).toHaveBeenCalledWith(
            '/api/t/acme/exchange/threads/th1/messages',
            { body: 'Да, 40 тона.' },
        );
    });

    it('a closed thread has no composer at all', () => {
        swrReturns(thread({ closed: true }));
        render(<ThreadClient threadId="th1" />);

        // 'closed' appears twice by design — once in the meta strip's status
        // and once as the notice where the composer would be.
        expect(screen.getAllByText('closed')).toHaveLength(2);
        expect(screen.queryByText('open')).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('composerPlaceholder')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'send' })).not.toBeInTheDocument();
    });

    it('marks read once per mount, not once per render', async () => {
        swrReturns(thread());
        const { rerender } = render(<ThreadClient threadId="th1" />);
        await waitFor(() =>
            expect(apiPost).toHaveBeenCalledWith('/api/t/acme/exchange/threads/th1/read', {}),
        );

        rerender(<ThreadClient threadId="th1" />);
        rerender(<ThreadClient threadId="th1" />);
        const reads = apiPost.mock.calls.filter(([url]) => String(url).endsWith('/read'));
        expect(reads).toHaveLength(1);
    });

    it('does not claim a read receipt before the thread has loaded', () => {
        swrReturns(undefined, { isLoading: true });
        render(<ThreadClient threadId="th1" />);
        // A receipt for a thread that may 404 would be a lie.
        expect(apiPost).not.toHaveBeenCalled();
    });
});
