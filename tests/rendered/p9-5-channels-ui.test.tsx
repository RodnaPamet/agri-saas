/**
 * P9.5 — «Канали», the channel web UI (#2939).
 *
 * Owner rulings 2026-11-10: the noun is «Канали», and it is a sidebar item in
 * the «Пазар» section rather than a bottom tab.
 *
 * The rules asserted here are the ones that are invisible when broken:
 *
 *   - the directory groups by the KEY PREFIX, not by `kind`. P9.2 made the
 *     prefix load-bearing, and a `TOPIC` channel that is not an input proves
 *     the difference — grouping on `kind` puts it under «Горива и торове».
 *   - prepending older posts captures the anchor BEFORE the fetch and restores
 *     it AFTER the commit that adds the rows. The anchor ARITHMETIC is #2826's
 *     and is tested there; what is asserted here is the page's POLICY, which
 *     is the half a page can get wrong.
 *   - a non-member gets no composer. The database refuses their post
 *     (`channel_post_insert`'s WITH CHECK), so a composer could only fail.
 *   - a hidden post renders as deleted from `deleted: true` with NO
 *     `deletedAt` — the combination the DM path never produces, because a
 *     channel post has no deletion timestamp to give.
 *
 * Both viewports, because `tests/rendered/setup.ts` answers `matches: false`
 * to every query and the app is therefore a PHONE by default: a desktop branch
 * can go unexecuted while a suite stays green.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { restoreViewport, setViewport } from './viewport';

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
    usePathname: () => '/t/acme/channels',
    useSearchParams: () => new URLSearchParams(),
}));

const apiGet = jest.fn();
const apiPost = jest.fn();
const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiDelete: (...a: unknown[]) => apiDelete(...a),
    apiPatch: jest.fn(),
}));

const plainSwr = jest.fn();
jest.mock('swr', () => ({
    __esModule: true,
    default: (...a: unknown[]) => plainSwr(...a),
}));

/**
 * The undo toast's TRIGGER is captured, not its rendering.
 *
 * sonner renders into a portal and no `<Toaster>` is mounted here, so the
 * toast's text is not in the DOM — asserting on it graded the portal. The
 * trigger INPUT is the contract: what was scheduled, and that it was not run.
 * `requireActual` is spread so the barrel's other hooks stay real, which is
 * the partial-barrel-mock trap this repo has ~55 instances of.
 */
const undoInput: { action?: () => Promise<unknown>; message?: string }[] = [];
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToastWithUndo: () => (input: { action: () => Promise<unknown>; message: string }) => {
        undoInput.push(input);
        return 'toast-id';
    },
}));

/**
 * The timeline is REPLACED, and that is deliberate for this file.
 *
 * Two reasons. The real one renders through react-window in a jsdom with no
 * layout engine, which #2826 already covers at the primitive level — and the
 * property under test here is the page's CALL ORDER around a prepend, which
 * needs the handle's two methods to be observable. The double records the
 * `messages` it was given on every render, so the adapter's REVERSAL (the API
 * is newest-first, the timeline oldest-first) is asserted on the prop rather
 * than inferred from the DOM.
 */
const calls: string[] = [];
const rendered: { messages: { id: string; deleted?: boolean }[] }[] = [];
jest.mock('@/components/chat/message-timeline', () => ({
    MessageTimeline: React.forwardRef(
        // NAMED, because `react/display-name` is an ERROR-severity rule and
        // the lint ceiling allows zero errors — an anonymous arrow inside
        // `forwardRef` has no display name to report.
        function MockMessageTimeline(
            props: { messages: { id: string; deleted?: boolean }[] },
            ref: React.Ref<unknown>,
        ) {
            rendered.push({ messages: props.messages });
            React.useImperativeHandle(ref, () => ({
                anchor: () => {
                    calls.push('anchor');
                    return { key: 'k', offsetInViewport: 7 };
                },
                restore: () => {
                    calls.push('restore');
                },
            }));
            return (
                <div data-testid="timeline">
                    {props.messages.map((m) => (
                        <div key={m.id} data-testid={`row-${m.id}`}>
                            {m.deleted ? 'DELETED' : m.id}
                        </div>
                    ))}
                </div>
            );
        },
    ),
}));

import { ChannelsDirectoryClient } from '@/app/t/[tenantSlug]/(app)/channels/ChannelsDirectoryClient';
import { ChannelFeedClient } from '@/app/t/[tenantSlug]/(app)/channels/[channelId]/ChannelFeedClient';

function channel(over: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'c1', key: 'crop:wheat', nameBg: 'Пшеница', nameEn: 'Wheat',
        kind: 'CROP', memberCount: 3, slowModeSeconds: 0,
        joined: false, banned: false, ...over,
    };
}

function post(over: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'p1', authorUserId: 'u-other', body: 'здравей', kind: 'POST',
        createdAt: '2026-11-10T09:00:00.000Z', deleted: false,
        resolvedAt: null, replyCount: 0, ...over,
    };
}

beforeEach(() => {
    calls.length = 0;
    rendered.length = 0;
    undoInput.length = 0;
    apiGet.mockReset();
    apiPost.mockReset();
    apiDelete.mockReset();
    plainSwr.mockReset();
});

afterEach(restoreViewport);

describe('the directory', () => {
    function mountDirectory(channels: unknown[]) {
        plainSwr.mockImplementation(() => ({
            data: { channels }, error: undefined, isLoading: false, mutate: jest.fn(),
        }));
        return render(<ChannelsDirectoryClient tenantSlug="acme" />);
    }

    for (const viewport of ['mobile', 'desktop'] as const) {
        it(`${viewport}: lists channels and offers Join`, () => {
            setViewport(viewport);
            mountDirectory([channel()]);
            expect(screen.getByText('Wheat')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'join' })).toBeInTheDocument();
        });
    }

    it('groups by the KEY PREFIX, not by `kind`', () => {
        setViewport('desktop');
        mountDirectory([
            channel({ id: 'a', key: 'crop:wheat', nameEn: 'Wheat' }),
            channel({ id: 'b', key: 'oblast:plovdiv', nameEn: 'Plovdiv', kind: 'OBLAST' }),
            channel({ id: 'c', key: 'input:diesel', nameEn: 'Diesel', kind: 'TOPIC' }),
            // THE DISCRIMINATOR: a `TOPIC` whose key is not `input:`. Grouping
            // on `kind` would file it under «Горива и торове» beside diesel;
            // the prefix puts it in «Други». Without this row the two rules
            // are indistinguishable, because every TOPIC seeded today is an
            // input.
            channel({ id: 'd', key: 'topic:weather', nameEn: 'Weather', kind: 'TOPIC' }),
        ]);
        const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
        expect(headings).toEqual(['group.crop', 'group.oblast', 'group.input', 'group.other']);

        // And «Други» holds the TOPIC that is not an input — asserted by
        // POSITION, because a heading list alone would pass if every channel
        // had landed in one group.
        const other = screen.getByText('group.other').closest('section')!;
        expect(other.textContent).toContain('Weather');
        expect(other.textContent).not.toContain('Diesel');

        // THE DISCRIMINATOR, and the first draft did not have it: grouping by
        // `kind` SURVIVED the mutation, because the «Други» group filters by
        // PREFIX either way, so the stray TOPIC landed in both groups and
        // every assertion above still held. What separates the two rules is
        // that the input group must NOT contain it.
        const input = screen.getByText('group.input').closest('section')!;
        expect(input.textContent).toContain('Diesel');
        expect(input.textContent).not.toContain('Weather');

        // And no channel is rendered TWICE — which is the shape the surviving
        // mutation actually produced.
        expect(screen.getAllByText('Weather')).toHaveLength(1);
    });

    it('a BANNED channel shows a badge and NO button', () => {
        setViewport('desktop');
        mountDirectory([channel({ banned: true, joined: true })]);
        expect(screen.getByText('banned')).toBeInTheDocument();
        // P9.1 keeps the membership row on a ban precisely so a rejoin cannot
        // escape it, so a button here would fail with no explanation.
        expect(screen.queryByRole('button', { name: 'leave' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'join' })).not.toBeInTheDocument();
    });

    it('joining calls POST and revalidates', async () => {
        setViewport('desktop');
        const mutate = jest.fn();
        plainSwr.mockImplementation(() => ({
            data: { channels: [channel()] }, error: undefined, isLoading: false, mutate,
        }));
        apiPost.mockResolvedValue({ joined: true, alreadyMember: false });
        render(<ChannelsDirectoryClient tenantSlug="acme" />);

        await userEvent.click(screen.getByRole('button', { name: 'join' }));
        await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/social/channels/c1/join', {}));
        // Revalidated rather than guessed: `memberCount` is denormalised
        // because a member cannot count the others, so an invented number
        // could not be corrected by any later read.
        await waitFor(() => expect(mutate).toHaveBeenCalled());
    });

    it('leaving DEFERS the DELETE through the undo toast', async () => {
        setViewport('desktop');
        plainSwr.mockImplementation(() => ({
            data: { channels: [channel({ joined: true })] },
            error: undefined, isLoading: false, mutate: jest.fn(),
        }));
        apiDelete.mockResolvedValue(undefined);
        render(<ChannelsDirectoryClient tenantSlug="acme" />);

        await userEvent.click(screen.getByRole('button', { name: 'leave' }));

        // NOT YET. Epic 67's whole point is that the destructive commit is
        // deferred, so Undo cancels it before it reaches the server — and
        // leaving is not lossless: the row carries `lastReadAt` and
        // `mutedAt`, and rejoining writes a fresh one.
        //
        // Asserting the ABSENCE immediately after the click is what separates
        // "wired to the toast" from "fires straight away and shows a toast
        // about it", which is the shape the convention exists to prevent.
        expect(apiDelete).not.toHaveBeenCalled();
        expect(apiPost).not.toHaveBeenCalled();

        // And it IS the DELETE that was scheduled. Running the captured
        // action is what separates "the toast was shown" from "the toast was
        // given the right thing to do" — a trigger handed a no-op would
        // satisfy every assertion above and silently never leave the channel.
        expect(undoInput).toHaveLength(1);
        expect(undoInput[0]!.message).toBe('leftChannel');
        await undoInput[0]!.action!();
        expect(apiDelete).toHaveBeenCalledWith('/api/social/channels/c1/join');
    });

    it('joining is IMMEDIATE — an undo window would delay what was asked for', async () => {
        setViewport('desktop');
        plainSwr.mockImplementation(() => ({
            data: { channels: [channel({ joined: false })] },
            error: undefined, isLoading: false, mutate: jest.fn(),
        }));
        apiPost.mockResolvedValue({ joined: true });
        render(<ChannelsDirectoryClient tenantSlug="acme" />);

        await userEvent.click(screen.getByRole('button', { name: 'join' }));
        // The CONTROL for the case above: if BOTH went through the toast, that
        // test would pass while nothing was ever immediate, and a person
        // joining a channel would wait five seconds to see it.
        await waitFor(() => expect(apiPost).toHaveBeenCalled());
    });

    it('a person-scoped LITERAL path, never a tenant one', () => {
        setViewport('desktop');
        mountDirectory([channel()]);
        // Channel policies key on `app.user_id`, which `runInTenantContext`
        // does not set, so a `/api/t/{slug}/…` path would read zero rows with
        // NO error (#1664) — an empty directory indistinguishable from a
        // deployment that seeded none.
        // The KEY is what is asserted. The directory passes no options, so
        // naming a third argument here would grade the call's arity rather
        // than the path, and would break the next time a `refreshInterval` is
        // added for a reason that has nothing to do with tenancy.
        expect(plainSwr.mock.calls.map((c: unknown[]) => c[0]))
            .toContain('/api/social/channels');
        expect(plainSwr.mock.calls.every((c: unknown[]) => !String(c[0]).startsWith('/api/t/')))
            .toBe(true);
    });
});

describe('the feed', () => {
    function mountFeed(
        posts: unknown[],
        opts: { hasMore?: boolean; joined?: boolean; banned?: boolean } = {},
    ) {
        const mutate = jest.fn();
        plainSwr.mockImplementation((key: string) => {
            if (key === '/api/social/channels') {
                return {
                    data: {
                        channels: [channel({
                            id: 'c1',
                            joined: opts.joined ?? true,
                            banned: opts.banned ?? false,
                        })],
                    },
                    error: undefined, isLoading: false, mutate: jest.fn(),
                };
            }
            return {
                data: { posts, hasMore: opts.hasMore ?? false },
                error: undefined, isLoading: false, mutate,
            };
        });
        return {
            mutate,
            ...render(
                <ChannelFeedClient tenantSlug="acme" channelId="c1" myUserId="u-me" />,
            ),
        };
    }

    for (const viewport of ['mobile', 'desktop'] as const) {
        it(`${viewport}: mounts the shared timeline, not a second one`, () => {
            setViewport(viewport);
            mountFeed([post({ id: 'p1' })]);
            expect(screen.getByTestId('timeline')).toBeInTheDocument();
            expect(screen.getByTestId('row-p1')).toBeInTheDocument();
        });
    }

    it('REVERSES the feed: the API is newest-first, the timeline oldest-first', () => {
        setViewport('desktop');
        mountFeed([
            post({ id: 'newest', createdAt: '2026-11-10T12:00:00.000Z' }),
            post({ id: 'oldest', createdAt: '2026-11-10T09:00:00.000Z' }),
        ]);
        // Asserted on the PROP, not the DOM: order is the deliverable, and a
        // DOM read could not tell a reversal from a styling choice.
        const last = rendered[rendered.length - 1]!;
        expect(last.messages.map((m) => m.id)).toEqual(['oldest', 'newest']);
    });

    it('a hidden post renders DELETED from the boolean, with no timestamp', () => {
        setViewport('desktop');
        mountFeed([post({ id: 'gone', deleted: true, body: '' })]);
        const last = rendered[rendered.length - 1]!;
        expect(last.messages[0]!.deleted).toBe(true);
        expect(screen.getByTestId('row-gone').textContent).toBe('DELETED');
        // The combination the DM path never produces: a channel post has no
        // deletion TIMESTAMP, because the three removal columns are collapsed
        // into one boolean so a reader cannot tell a moderator's act from the
        // author's. Passing `deletedAt: post.createdAt` would render the same
        // and store a false fact.
        expect(last.messages[0]).not.toHaveProperty('deletedAt');
    });

    it('captures the anchor BEFORE the fetch and restores AFTER the commit', async () => {
        setViewport('desktop');
        let resolveFetch: (v: unknown) => void = () => undefined;
        apiGet.mockImplementation(
            () => new Promise((res) => { resolveFetch = res; }),
        );
        mountFeed([post({ id: 'p2', createdAt: '2026-11-10T10:00:00.000Z' })], { hasMore: true });

        await userEvent.click(screen.getByRole('button', { name: 'loadOlder' }));

        // THE ORDER IS THE ASSERTION. The anchor must be taken before the
        // await: between the two the reader may scroll, and an anchor read
        // afterwards records where they ended up rather than where the prepend
        // has to put them back.
        expect(calls).toEqual(['anchor']);
        expect(apiGet).toHaveBeenCalledWith(
            '/api/social/channels/c1?before=2026-11-10T10%3A00%3A00.000Z',
        );

        resolveFetch({ posts: [post({ id: 'p1', createdAt: '2026-11-10T08:00:00.000Z' })], hasMore: false });

        await waitFor(() => expect(calls).toEqual(['anchor', 'restore']));
        // And the older row is actually there — a restore that fired without
        // the rows arriving would satisfy the order and nothing else.
        await waitFor(() => expect(screen.getByTestId('row-p1')).toBeInTheDocument());
    });

    it('a failed older page does not restore', async () => {
        // ## The clearing is DEFENSIVE, and this test says only what it can
        //
        // The handler nulls `pendingAnchor` in its catch, and removing that
        // line leaves this suite GREEN — measured. The reason is worth
        // writing down rather than papering over with a stronger-sounding
        // name: the layout effect fires on a change to `older`, only a
        // SUCCESSFUL page changes `older`, and that page captures its own
        // anchor before fetching, overwriting any stale one. So a leftover
        // anchor has no commit to fire on in this code path.
        //
        // What is asserted here is the observable part: a failed page does not
        // move the reader. The clearing stays as a guard against a future
        // commit path that does not re-capture, and is recorded as UNPROVEN
        // rather than claimed.
        setViewport('desktop');
        apiGet.mockRejectedValue(new Error('nope'));
        const { mutate } = mountFeed([post({ id: 'p2' })], { hasMore: true });

        await userEvent.click(screen.getByRole('button', { name: 'loadOlder' }));
        await waitFor(() => expect(apiGet).toHaveBeenCalled());

        // `anchor` was taken; `restore` must NOT follow. Leaving it set would
        // restore on some later commit — a poll, a post — and move the reader
        // for no reason they can see.
        expect(calls).toEqual(['anchor']);
        expect(mutate).not.toHaveBeenCalled();
    });

    it('a NON-MEMBER gets no composer and a named way in', () => {
        setViewport('desktop');
        mountFeed([post()], { joined: false });
        // The database refuses their post, so a composer could only fail.
        expect(screen.queryByPlaceholderText('composerPlaceholder')).not.toBeInTheDocument();
        expect(screen.getByText('joinToPost')).toBeInTheDocument();
        // A LINK to the directory, which is where Join lives — naming the way
        // in rather than describing it.
        expect(screen.getByRole('link', { name: 'title' })).toHaveAttribute(
            'href', '/t/acme/channels',
        );
    });

    it('a BANNED member is told, not shown a composer', () => {
        setViewport('desktop');
        mountFeed([post()], { joined: true, banned: true });
        expect(screen.queryByPlaceholderText('composerPlaceholder')).not.toBeInTheDocument();
        expect(screen.getByText('bannedHere')).toBeInTheDocument();
    });

    it('a FAILED post KEEPS the operator\'s text', async () => {
        setViewport('desktop');
        apiPost.mockRejectedValue(new Error('slow mode'));
        mountFeed([post()], { joined: true });

        const box = screen.getByPlaceholderText('composerPlaceholder');
        await userEvent.type(box, 'важно');
        await userEvent.click(screen.getByRole('button', { name: 'send' }));

        // `MessageComposer` clears on anything that is not `false`, and its
        // own docblock records what that cost: the text used to be cleared
        // unconditionally and synchronously, so a failed send lost the
        // operator's words. A channel post fails for reasons they can act on —
        // slow mode, a ban, a refused mention — so the handler returns false.
        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        await waitFor(() => expect(box).toHaveValue('важно'));
    });

    it('a SUCCESSFUL post clears the box', async () => {
        setViewport('desktop');
        apiPost.mockResolvedValue({ postId: 'new' });
        mountFeed([post()], { joined: true });

        const box = screen.getByPlaceholderText('composerPlaceholder');
        await userEvent.type(box, 'готово');
        await userEvent.click(screen.getByRole('button', { name: 'send' }));

        // The CONTROL. Without it, a handler that returned `false`
        // unconditionally would satisfy the case above while never clearing,
        // and the operator would re-send the same post every time.
        await waitFor(() => expect(box).toHaveValue(''));
    });

    it('a MEMBER gets the composer', () => {
        setViewport('desktop');
        mountFeed([post()], { joined: true });
        // The control: without it, every assertion above passes for a screen
        // that never renders a composer at all.
        expect(screen.getByPlaceholderText('composerPlaceholder')).toBeInTheDocument();
    });
});
