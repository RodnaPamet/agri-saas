/**
 * P8.4 — direct messages on the exchange messaging surface (#2798).
 *
 * Owner ruling 2026-11-07: «Съобщения» stays with the exchange and DMs go
 * INTO that screen, so there is no `/messages` and no new bottom-bar tab.
 *
 * The rules asserted here are the ones that are invisible when broken:
 *
 *   - the DM half is fetched with `?source=dm`. Without it `listInbox` also
 *     returns its PERSON-scoped exchange half, which admits the caller only as
 *     inquirer or seller — so the screen would show some exchange threads
 *     twice and would disagree with itself about who may see a colleague's
 *     negotiation.
 *   - a half that is OFF is not fetched at all, and a half that FAILS does not
 *     blank the rows the other half returned.
 *   - the read cursor is FROZEN, so the «Нови съобщения» divider survives the
 *     mark-read this screen performs on arrival.
 *   - a REQUEST has three shapes and only one gets a composer.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { restoreViewport, setViewport } from './viewport';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
    useLocale: () => 'en',
}));

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push, refresh: jest.fn(), replace: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/exchange/threads',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

const apiGet = jest.fn();
const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiDelete: jest.fn(),
    apiPatch: jest.fn(),
}));

const tenantSwr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => tenantSwr(...a),
}));

const plainSwr = jest.fn();
jest.mock('swr', () => ({
    __esModule: true,
    default: (...a: unknown[]) => plainSwr(...a),
}));

import { ThreadsClient } from '@/app/t/[tenantSlug]/(app)/exchange/threads/ThreadsClient';
import { DmConversationClient } from '@/app/t/[tenantSlug]/(app)/exchange/threads/dm/[conversationId]/DmConversationClient';

const ME = 'user-me';
const THEM = 'user-them';

function idle() {
    return { data: undefined, error: undefined, isLoading: false, mutate: jest.fn() };
}
function loaded<T>(data: T) {
    return { data, error: undefined, isLoading: false, mutate: jest.fn() };
}
function failed() {
    return { data: undefined, error: new Error('nope'), isLoading: false, mutate: jest.fn() };
}

const EX_THREAD = {
    id: 'th1',
    listingId: 'l1',
    listingCommodity: 'Wheat',
    listingRegionName: 'Dobrich',
    listingQuantityTonnes: '25',
    sellerDisplayName: null,
    role: 'inquirer' as const,
    lastMessageAt: '2026-11-07T09:00:00.000Z',
    closed: false,
    hasUnread: false,
};

const DM_ITEM = {
    source: 'dm' as const,
    id: 'c1',
    lastMessageAt: '2026-11-07T10:00:00.000Z',
    lastReadAt: null,
    unread: true,
    awaitingMyAnswer: false,
    title: 'Agro Ltd',
};

beforeEach(() => {
    // SAID, not inherited. `tests/rendered/setup.ts` answers `matches: false`
    // to every query, so the default is a phone — and a suite that does not
    // declare which device it means is green about a viewport nobody chose.
    // A phone is the right one here: an operator reads messages standing in a
    // field, and `rendered-viewport-switchers` caps how many suites may reach
    // a switcher without naming one.
    setViewport('mobile');
    jest.clearAllMocks();
    tenantSwr.mockReturnValue(idle());
    plainSwr.mockReturnValue(idle());
    apiPost.mockResolvedValue({});
});

afterEach(restoreViewport);

// ───────────────── the merged inbox ─────────────────

describe('ThreadsClient — one screen, two kinds', () => {
    it('asks the DM inbox for source=dm ONLY', () => {
        render(<ThreadsClient exchange directMessages />);
        // Without the filter the response also carries `listInbox`'s
        // PERSON-scoped exchange half, which admits the caller only as
        // inquirer or seller — so the screen would render some threads twice,
        // from two different audiences.
        const key = plainSwr.mock.calls[0]?.[0] as string;
        expect(key).toContain('/api/social/inbox');
        expect(key).toContain('source=dm');
    });

    it('does not fetch a half that is OFF', () => {
        render(<ThreadsClient exchange={false} directMessages />);
        // SWR skips a null key. A disabled half must not be requested: the API
        // would 404 on the flag or redirect on the module, and an error for a
        // surface the caller was never offered is noise they cannot act on.
        expect(tenantSwr.mock.calls[0]?.[0]).toBeNull();
        expect(plainSwr.mock.calls[0]?.[0]).not.toBeNull();

        jest.clearAllMocks();
        tenantSwr.mockReturnValue(idle());
        plainSwr.mockReturnValue(idle());
        render(<ThreadsClient exchange directMessages={false} />);
        expect(tenantSwr.mock.calls[0]?.[0]).toBe('/exchange/threads');
        expect(plainSwr.mock.calls[0]?.[0]).toBeNull();
    });

    it('merges both kinds into ONE order, newest first', () => {
        tenantSwr.mockReturnValue(loaded({ threads: [EX_THREAD] }));
        plainSwr.mockReturnValue(loaded({ items: [DM_ITEM] }));
        render(<ThreadsClient exchange directMessages />);

        // Scoped to row links by requiring a path DEEPER than the inbox.
        // `getAllByRole('link')` also returns the breadcrumbs AND
        // `<ExchangeNav>`, which itself links to `/exchange/threads` — so
        // both looser filters I tried first (every link; every link
        // containing `/exchange/threads`) asserted against chrome and read
        // as an ordering bug in the merge.
        const hrefs = screen
            .getAllByRole('link')
            .map((l) => l.getAttribute('href') ?? '')
            .filter((h) => h.includes('/exchange/threads/'));
        expect(hrefs).toHaveLength(2);
        // The DM is newer (10:00 vs 09:00), so it leads. A screen that
        // appended one kind after the other would pass a "both render" test
        // and still bury today's conversation under last week's.
        expect(hrefs[0]).toBe('/t/acme/exchange/threads/dm/c1');
        expect(hrefs[1]).toBe('/t/acme/exchange/threads/th1');
    });

    it('keeps one half when the OTHER fails', () => {
        tenantSwr.mockReturnValue(failed());
        plainSwr.mockReturnValue(loaded({ items: [DM_ITEM] }));
        render(<ThreadsClient exchange directMessages />);

        expect(screen.getByText('Agro Ltd')).toBeInTheDocument();
        expect(screen.queryByText('loadError')).not.toBeInTheDocument();
    });

    it('shows the error state only when EVERY asked-for half failed', () => {
        tenantSwr.mockReturnValue(failed());
        plainSwr.mockReturnValue(failed());
        render(<ThreadsClient exchange directMessages />);
        expect(screen.getByText('loadError')).toBeInTheDocument();
    });

    it('marks an unanswered request with a phrase, not a coined noun', () => {
        plainSwr.mockReturnValue(
            loaded({ items: [{ ...DM_ITEM, awaitingMyAnswer: true }] }),
        );
        render(<ThreadsClient exchange={false} directMessages />);
        // «Заявки» is spoken for by `exchange.nav.myInterests`, so the row
        // carries a phrase and this PR coins no bucket name.
        expect(screen.getByText('awaitingYourReply')).toBeInTheDocument();
    });

    it('does not mark a conversation the caller opened', () => {
        plainSwr.mockReturnValue(
            loaded({ items: [{ ...DM_ITEM, awaitingMyAnswer: false }] }),
        );
        render(<ThreadsClient exchange={false} directMessages />);
        expect(screen.queryByText('awaitingYourReply')).not.toBeInTheDocument();
    });

    it('falls back to a neutral label when the counterparty has no public name', () => {
        plainSwr.mockReturnValue(loaded({ items: [{ ...DM_ITEM, title: null }] }));
        render(<ThreadsClient exchange={false} directMessages />);
        // A null title is a real state — the other party has no public
        // profile — so an empty row would look like a failed render.
        expect(screen.getByText('directConversation')).toBeInTheDocument();
    });

    it('renders the same rows on a DESKTOP, where ListPageShell behaves differently', () => {
        // Not a formality. `<ListPageShell>` is a no-op on a phone and
        // viewport-CLAMPS on a desktop, so asserting only the default leaves
        // the clamped branch unexercised — the 2026-07-30 audit found three
        // suites green about a branch they had never run, and
        // `rendered-viewport-switchers` caps how many may stay that way.
        //
        // The rows themselves are width-fluid, which is the property this
        // pins: the merge must not depend on the device.
        tenantSwr.mockReturnValue(loaded({ threads: [EX_THREAD] }));
        plainSwr.mockReturnValue(loaded({ items: [DM_ITEM] }));

        setViewport('desktop');
        render(<ThreadsClient exchange directMessages />);
        const hrefs = screen
            .getAllByRole('link')
            .map((l) => l.getAttribute('href') ?? '')
            .filter((h) => h.includes('/exchange/threads/'));
        expect(hrefs).toEqual([
            '/t/acme/exchange/threads/dm/c1',
            '/t/acme/exchange/threads/th1',
        ]);
    });
});

// ───────────────── the conversation ─────────────────

function conversation(over: Record<string, unknown> = {}) {
    return {
        id: 'c1',
        state: 'ACCEPTED',
        initiatedByUserId: THEM,
        lastMessageAt: '2026-11-07T10:00:00.000Z',
        lastReadAt: null,
        messages: [
            {
                id: 'm1',
                senderUserId: THEM,
                body: 'Имате ли още пшеница?',
                createdAt: '2026-11-07T09:00:00.000Z',
                editedAt: null,
                deletedAt: null,
                reactions: [],
            },
        ],
        olderCursor: null,
        hasOlder: false,
        ...over,
    };
}

function mountConversation(over: Record<string, unknown> = {}) {
    const mutate = jest.fn();
    plainSwr.mockReturnValue({
        data: conversation(over),
        error: undefined,
        isLoading: false,
        mutate,
    });
    // `TooltipProvider` is part of this screen's REAL environment, not
    // scaffolding: `src/app/providers.tsx` mounts one around the whole app, and
    // since #2833 every bubble from the other party carries an `<IconAction>`
    // for «Сигнализирай» — which is a Radix Tooltip trigger. Without a provider
    // the render throws «`Tooltip` must be used within `TooltipProvider`» and
    // all twelve cases here fail at the mount.
    //
    // This file passed before only because `DmConversationClient` passed the
    // timeline no per-message callback, so the bubble rendered no interactive
    // affordance at all. `chat-primitives.test.tsx` already carries the same
    // provider for the same reason.
    // A FUNCTION, not a constant. Passing `rerender` the SAME element object
    // lets React bail out of the subtree entirely — measured: with a shared
    // `const tree`, removing the once-per-conversation guard in
    // `DmConversationClient` left all 22 cases green, because the effect never
    // re-ran. A fresh element every call is what makes the rerender real.
    const tree = () => (
        <TooltipProvider delayDuration={0}>
            <DmConversationClient conversationId="c1" myUserId={ME} personBlocksEnabled />
        </TooltipProvider>
    );
    const view = render(tree());
    // `rerender` REPLACES the whole tree, so a bare
    // `view.rerender(<DmConversationClient … />)` drops the provider and throws
    // at the Tooltip — which is how two cases here failed after #2833 even with
    // the provider added at mount. Handing back a wrapped rerender means a
    // caller cannot forget it, rather than each call site remembering.
    const rerender = () => view.rerender(tree());
    return { mutate, view, rerender };
}

describe('DmConversationClient', () => {
    it('renders the messages through the P8.3 timeline', () => {
        mountConversation();
        expect(screen.getByText('Имате ли още пшеница?')).toBeInTheDocument();
    });

    it('offers accept/decline and NO composer on a request somebody else opened', () => {
        mountConversation({ state: 'REQUEST', initiatedByUserId: THEM });
        expect(screen.getByRole('button', { name: 'requestAccept' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'requestDecline' })).toBeInTheDocument();
        // P8.1's rule is that a stranger gets ONE message until accepted, so a
        // composer here would be a control the server refuses.
        expect(screen.queryByLabelText('composerPlaceholder')).not.toBeInTheDocument();
    });

    it('states the wait on a request the caller opened, instead of a failing composer', () => {
        mountConversation({ state: 'REQUEST', initiatedByUserId: ME });
        expect(screen.queryByRole('button', { name: 'requestAccept' })).not.toBeInTheDocument();
        expect(screen.getByText('awaitingAcceptance')).toBeInTheDocument();
        expect(screen.queryByLabelText('composerPlaceholder')).not.toBeInTheDocument();
    });

    it('gives an ACCEPTED conversation a working composer', () => {
        mountConversation();
        expect(screen.getByLabelText('composerPlaceholder')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'requestAccept' })).not.toBeInTheDocument();
    });

    it('sends through the social route and refetches', async () => {
        const { mutate } = mountConversation();
        const box = screen.getByLabelText('composerPlaceholder');
        await userEvent.type(box, 'да, имам');
        await userEvent.click(screen.getByRole('button', { name: 'send' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
            '/api/social/conversations/c1/messages',
            { body: 'да, имам' },
        ));
        await waitFor(() => expect(mutate).toHaveBeenCalled());
    });

    it('moves the read cursor ONCE per conversation, not once per poll', async () => {
        const { view, rerender } = mountConversation();
        await waitFor(() =>
            expect(apiPost).toHaveBeenCalledWith(
                '/api/social/conversations/c1/read',
                expect.objectContaining({ readAt: expect.any(String) }),
            ),
        );
        const readCalls = () =>
            apiPost.mock.calls.filter((c) => String(c[0]).endsWith('/read')).length;
        expect(readCalls()).toBe(1);

        // A poll RE-RENDERS the same instance with a FRESH OBJECT. Both
        // halves of that matter, and getting either wrong made this test
        // vacuous:
        //
        //   - calling `mountConversation()` again is a new component, where
        //     marking again is correct behaviour;
        //   - re-rendering with the SAME `data` reference means the effect's
        //     `[data, path]` deps are unchanged, so React never re-runs it and
        //     the guard under test is never reached. Deleting the guard left
        //     this green.
        //
        // A real poll parses new JSON, so the object is new and the content is
        // equal — which is exactly when a missing guard double-marks.
        plainSwr.mockReturnValue({
            data: conversation(),
            error: undefined,
            isLoading: false,
            mutate: jest.fn(),
        });
        rerender();
        await waitFor(() => expect(readCalls()).toBe(1));
    });

    it('keeps the «Нови съобщения» divider after the mark-read lands', async () => {
        // The screen marks itself read on arrival, so a divider derived from
        // LIVE data vanishes under the reader a moment after they get there.
        // `firstUnreadId` is frozen on the first payload for exactly that, and
        // nothing asserted it until this case: with `lastReadAt` never moving
        // in the fixture, recomputing gave the same answer and unfreezing the
        // cursor left every other test green.
        const { view, rerender } = mountConversation({ lastReadAt: null });
        expect(screen.getByText('newMessages')).toBeInTheDocument();

        // The poll that follows the mark-read: same messages, cursor now PAST
        // the one unread message.
        plainSwr.mockReturnValue({
            data: conversation({ lastReadAt: '2026-11-07T12:00:00.000Z' }),
            error: undefined,
            isLoading: false,
            mutate: jest.fn(),
        });
        rerender();

        expect(screen.getByText('newMessages')).toBeInTheDocument();
    });

    it('shows no divider when the reader has already seen everything', () => {
        // The control for the case above: a frozen cursor must not mean an
        // ALWAYS-present divider, which would satisfy the freeze assertion
        // while being wrong for every caught-up reader.
        mountConversation({ lastReadAt: '2026-11-07T12:00:00.000Z' });
        expect(screen.queryByText('newMessages')).not.toBeInTheDocument();
    });

    it('leaves the screen when the request is DECLINED', async () => {
        mountConversation({ state: 'REQUEST', initiatedByUserId: THEM });
        await userEvent.click(screen.getByRole('button', { name: 'requestDecline' }));
        await waitFor(() =>
            expect(apiPost).toHaveBeenCalledWith(
                '/api/social/conversations/c1/respond',
                { decision: 'DECLINE' },
            ),
        );
        // A declined conversation answers not-found on every content path, so
        // staying would show a screen the server has stopped serving.
        await waitFor(() => expect(push).toHaveBeenCalledWith('/t/acme/exchange/threads'));
    });

    it('offers the block control only once the other party has written', () => {
        mountConversation();
        // `trigger` is `trustSafety.blockPerson.trigger` echoed by this
        // suite's next-intl mock, which returns the key.
        expect(screen.getByRole('button', { name: 'trigger' })).toBeInTheDocument();
    });

    it('offers no block control when only the caller has written', () => {
        mountConversation({
            messages: [
                {
                    id: 'm1',
                    senderUserId: ME,
                    body: 'здравейте',
                    createdAt: '2026-11-07T09:00:00.000Z',
                    editedAt: null,
                    deletedAt: null,
                    reactions: [],
                },
            ],
        });
        // The payload names people only on messages, so there is nobody to
        // name yet — the same constraint P5.3 worked under, and the same
        // consequence.
        expect(screen.queryByRole('button', { name: 'trigger' })).not.toBeInTheDocument();
    });

    it('renders the "load older" control once there IS an older page', () => {
        // THE INVERSION THIS TEST EXISTED FOR. It asserted the ABSENCE of this
        // control through P8.4, because #2826 owned paging and its anchoring
        // together — anchoring with no paging is untestable, paging with no
        // anchoring is a visible jump. #2826 shipped both, so the absence is
        // no longer the property; the control is.
        mountConversation({ hasOlder: true, olderCursor: 'cursor-abc' });
        expect(screen.getByRole('button', { name: /older/i })).toBeInTheDocument();
    });

    it('renders NO "load older" control when there is no older page', () => {
        // The control for the inversion above. Without it, "the button is
        // there" is satisfied by a button rendered unconditionally — which
        // would offer a page that does not exist and answer a click with
        // nothing.
        mountConversation({ hasOlder: false, olderCursor: null });
        expect(screen.queryByRole('button', { name: /older/i })).not.toBeInTheDocument();
    });

    // ── the quoted reply, #2829's page half ──────────────────────────────
    //
    // The component stage (#2898) gave the bubble a reply control and the
    // composer a quote slot. What only this screen can hold is the STATE
    // between them, and the two things that can go wrong here are both
    // silent: the quote never reaching the request, and the quote surviving a
    // send.

    it('quotes the message the reply control names, in the composer', async () => {
        mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        // The composer renders the quoted BODY, derived from `messages` rather
        // than snapshotted at click time — so a message the other party
        // retracts stops being quoted instead of showing stale text.
        await waitFor(() =>
            expect(screen.getByText('replyingTo')).toBeInTheDocument());
        expect(screen.getAllByText('Имате ли още пшеница?').length).toBeGreaterThan(1);
    });

    it('sends replyToMessageId, which is the only thing the server can act on', async () => {
        mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'да, имам' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));

        // THE ASSERTION THAT MATTERS, and it is on the REQUEST rather than on
        // the screen. A quote rendered in the composer and dropped from the
        // body looks identical to a working reply from the sender's side —
        // which is #2890 verbatim, one field and one layer along.
        await waitFor(() =>
            expect(apiPost).toHaveBeenCalledWith(
                '/api/social/conversations/c1/messages',
                { body: 'да, имам', replyToMessageId: 'm1' },
            ));
    });

    it('sends NO replyToMessageId when nothing is quoted', async () => {
        // The control. Without it the case above is satisfied by a screen that
        // attaches the key unconditionally — and the schema `.strip()`s a null,
        // so the server would accept it and the defect would be invisible.
        mountConversation();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'здравей' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));
        await waitFor(() =>
            expect(apiPost).toHaveBeenCalledWith(
                '/api/social/conversations/c1/messages',
                { body: 'здравей' },
            ));
    });

    it('clears the quote after a SUCCESSFUL send', async () => {
        mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        await waitFor(() => expect(screen.getByText('replyingTo')).toBeInTheDocument());

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'да' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));
        await waitFor(() =>
            expect(screen.queryByText('replyingTo')).not.toBeInTheDocument());
    });

    it('RETAINS the quote when the send fails', async () => {
        // `pending`'s own contract, extended: a failed send keeps the body, so
        // it has to keep the quote with it. Clearing on attempt rather than on
        // success would make a retry send the same words with their context
        // silently dropped — and the operator cannot see that it happened.
        // AIMED AT THE RECIPIENT, not at a call index. `mockRejectedValueOnce`
        // was the first draft and it failed this test for the wrong reason:
        // the screen marks itself read on mount, so the `/read` POST consumed
        // the rejection and the send succeeded. Same shape as the statement
        // queue's own note — a once-mock lands on whichever call arrives
        // first, and here that is never the one under test.
        apiPost.mockImplementation((url: unknown) =>
            String(url).endsWith('/messages')
                ? Promise.reject(new Error('offline'))
                : Promise.resolve({}));
        mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        await waitFor(() => expect(screen.getByText('replyingTo')).toBeInTheDocument());

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'да' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));
        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(screen.getByText('replyingTo')).toBeInTheDocument();
        // And the operator is TOLD. The first draft caught the rejection and
        // logged it, which `observability-foundation`'s console guard refused
        // — correctly, because a console reaches no farmer. The sibling
        // exchange screen already answers a failed send with
        // `exchange…sendFailed`, so this mirrors it rather than inventing
        // copy: two message screens in one product disagreeing about what a
        // failure says would be the defect.
        await waitFor(() => expect(screen.getByText('sendFailed')).toBeInTheDocument());
        // AND THE TEXT SURVIVES. Found while writing the case below, which
        // could not retry because the composer was empty: `MessageComposer`
        // cleared the body UNCONDITIONALLY and synchronously, in the same tick
        // as `onSend`, so `pending`'s documented "the text is retained"
        // never got a chance. A failure message telling the operator to try
        // again, with nothing left to try, is worse than either half alone.
        expect(screen.getByRole('textbox')).toHaveValue('да');
    });

    it('clears the failure message on the next ATTEMPT, not on a timer', async () => {
        // Reset where the attempt starts, so the message stays until the
        // operator does something about it. A timer would clear it while they
        // were still reading.
        apiPost.mockImplementation((url: unknown) =>
            String(url).endsWith('/messages')
                ? Promise.reject(new Error('offline'))
                : Promise.resolve({}));
        mountConversation();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'едно' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));
        await waitFor(() => expect(screen.getByText('sendFailed')).toBeInTheDocument());

        apiPost.mockResolvedValue({});
        fireEvent.click(screen.getByRole('button', { name: 'send' }));
        await waitFor(() =>
            expect(screen.queryByText('sendFailed')).not.toBeInTheDocument());
    });

    it('drops the quote when the quoted message is DELETED under it', async () => {
        // The operator chose to answer something that is no longer there.
        // Quoting it as «изтрито» would show them a quote they did not pick,
        // and sending would point a reply at a retraction.
        const { rerender } = mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        await waitFor(() => expect(screen.getByText('replyingTo')).toBeInTheDocument());

        plainSwr.mockReturnValue({
            // A FRESH object, not a mutated one: the memo and the effect key on
            // `messages`, and handing back the same array lets React bail out
            // — the shape that made `tree()` a function in this file.
            data: conversation({
                messages: [
                    {
                        id: 'm1',
                        senderUserId: THEM,
                        body: null,
                        createdAt: '2026-11-07T09:00:00.000Z',
                        editedAt: null,
                        deletedAt: '2026-11-07T11:00:00.000Z',
                        reactions: [],
                    },
                ],
            }),
            error: undefined,
            isLoading: false,
            mutate: jest.fn(),
        });
        rerender();
        await waitFor(() =>
            expect(screen.queryByText('replyingTo')).not.toBeInTheDocument());
    });

    it('does not SEND a target that was deleted under the composer', async () => {
        // FOUND BY MUTATION, and it is the half the screen-level case above
        // cannot see. Swapping the send back to the raw `replyToId` passed all
        // 29 other cases: the quote vanished from the screen and the request
        // still carried the id, so the server would have quoted a retracted
        // message in the thread while the sender saw no quote at all.
        //
        // The rule the code states — every consumer reads the DERIVED
        // `replyingTo`, never `replyToId` — had no test until this one.
        const { rerender } = mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        await waitFor(() => expect(screen.getByText('replyingTo')).toBeInTheDocument());

        plainSwr.mockReturnValue({
            data: conversation({
                messages: [
                    {
                        id: 'm1',
                        senderUserId: THEM,
                        body: null,
                        createdAt: '2026-11-07T09:00:00.000Z',
                        editedAt: null,
                        deletedAt: '2026-11-07T11:00:00.000Z',
                        reactions: [],
                    },
                ],
            }),
            error: undefined,
            isLoading: false,
            mutate: jest.fn(),
        });
        // RERENDER, never a second `render`. The first draft mounted a fresh
        // tree here and the mutation survived: a new component gets a fresh
        // `useState(null)`, so `replyToId` was never set in the tree under
        // test and the assertion passed over nothing. The harness had reset
        // the very state the case is about.
        rerender();

        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'все пак отговарям' } });
        fireEvent.click(screen.getByRole('button', { name: 'send' }));

        await waitFor(() =>
            expect(apiPost).toHaveBeenCalledWith(
                '/api/social/conversations/c1/messages',
                { body: 'все пак отговарям' },
            ));
    });

    it('offers an explicit dismiss, because a tap elsewhere does NOT clear it', async () => {
        // The product choice recorded on #2829: the quote persists until
        // cleared or sent, because one lost to a stray tap sends a message
        // without its context and the reader cannot tell. That makes the
        // dismiss control load-bearing rather than a convenience, and it is a
        // real button so a keyboard reaches it.
        mountConversation();
        fireEvent.click(screen.getByRole('button', { name: 'replyToMessage' }));
        await waitFor(() => expect(screen.getByText('replyingTo')).toBeInTheDocument());

        const clear = screen.getByRole('button', { name: 'clearQuote' });
        clear.focus();
        expect(clear).toHaveFocus();
        fireEvent.click(clear);
        await waitFor(() =>
            expect(screen.queryByText('replyingTo')).not.toBeInTheDocument());
    });
});
