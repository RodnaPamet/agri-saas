/** @jest-environment jsdom */

/**
 * Behavioural (Tier-2) test — `<NotificationsBell>`.
 *
 * From `docs/roadmap-audit-2026-05-13.md` "Known broken / risky
 * areas" item #3: the bell (#432) shipped with an off-recipe hover
 * treatment and used raw `toLocaleDateString` for timestamps; #456
 * fixed it. The audit says: "worth confirming the bell actually
 * renders with correct hover + relative-time copy."
 *
 * A structural ratchet could assert the recipe consts are present in
 * source. It could NOT assert:
 *   - that the relative-time output is actually relative ("5m", "2h")
 *     and not a raw `toLocaleDateString` string;
 *   - that the hover class resolves to the canonical hover surface;
 *   - that the unread badge renders the right count from real data.
 *
 * This test renders the component, drives it with mocked
 * `/api/notifications` data, and asserts the RENDERED outcome.
 */

import {
    act,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

/**
 * No `@/env` mock here any more — #1982.
 *
 * This file briefly mocked `NEXT_PUBLIC_NOTIFICATIONS_SSE` on, because the
 * bell carried its own build-time gate. The gate now lives in
 * `/api/notifications/stream` as a `FeatureFlag` row, so the client always
 * attempts the connection and there is nothing here to switch.
 *
 * What makes every test below unaffected is the environment rather than a
 * mock: jsdom does not implement `EventSource` (probed: `typeof EventSource
 * === 'undefined'`), and the bell guards on that, so no stream is constructed
 * unless a test installs a double itself — as the throttle test does.
 */
import { NotificationsBell } from '@/components/layout/notifications-bell';
import { restoreViewport, setViewport, DEFAULT_VIEWPORT } from './viewport';

// ─── fetch mock ────────────────────────────────────────────────────

const fetchMock = jest.fn();

function isoMinutesAgo(min: number): string {
    return new Date(Date.now() - min * 60_000).toISOString();
}

interface NotifFixture {
    id: string;
    type: string;
    title: string;
    message: string;
    read: boolean;
    linkUrl: string | null;
    createdAt: string;
}

function makeNotifications(): NotifFixture[] {
    return [
        {
            id: 'n1',
            type: 'TASK',
            title: 'Practice C-12 needs review',
            message: 'A practice test is overdue.',
            read: false,
            linkUrl: '/t/acme/practices/c12',
            createdAt: isoMinutesAgo(5), // → "5m"
        },
        {
            id: 'n2',
            type: 'AUDIT',
            title: 'Audit cycle started',
            message: 'Q2 audit cycle has begun.',
            read: false,
            linkUrl: null,
            createdAt: isoMinutesAgo(150), // 2.5h → earlier TODAY, so a time of day
        },
        {
            id: 'n3',
            type: 'POLICY',
            title: 'Policy approved',
            message: 'Acceptable Use Policy v3 was approved.',
            read: true,
            linkUrl: null,
            createdAt: isoMinutesAgo(60 * 24 * 3), // 3d → "3d"
        },
    ];
}

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => restoreViewport());

describe('<NotificationsBell> — behavioural (Tier 2)', () => {
    it('renders the unread COUNT from real data (not a hard-coded badge)', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);

        // The mount-time ping fetches the list; the badge then shows
        // the count of `read: false` rows. The fixture has 2 unread.
        const badge = await screen.findByTestId(
            'notifications-unread-badge',
        );
        expect(badge.textContent).toBe('2');
    });

    it('does not render an unread badge when everything is read', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () =>
                makeNotifications().map((n) => ({ ...n, read: true })),
        });
        render(<NotificationsBell />);

        // Let the mount-time fetch settle.
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        // The badge is conditional on unreadCount > 0 — it must be
        // absent, not present-with-"0".
        await waitFor(() => {
            expect(
                screen.queryByTestId('notifications-unread-badge'),
            ).toBeNull();
        });
    });

    it('the bell button carries the canonical hover surface class', () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [],
        });
        render(<NotificationsBell />);
        const bell = screen.getByTestId('top-chrome-notifications-bell');

        // The audit's complaint was an OFF-recipe hover. The canonical
        // top-chrome hover surface is `hover:bg-bg-muted/50` +
        // `hover:text-content-emphasis`. Assert the rendered button
        // carries BOTH halves of the recipe — and is NOT using the
        // off-recipe solid `hover:bg-bg-muted` (no `/50`) the bell
        // originally shipped with.
        expect(bell.className).toContain('hover:bg-bg-muted/50');
        expect(bell.className).toContain('hover:text-content-emphasis');
    });

    it('renders LOCALISED relative timestamps — not "5m", and not raw dates', async () => {
        // The clock is FROZEN to local noon, and that is load-bearing rather
        // than tidiness. `isoMinutesAgo` builds its fixtures from the real
        // `Date.now()`, and the 150-minute case below asserts the chip renders
        // as a TIME OF DAY because that notification is "earlier today" — which
        // is false for 150 minutes after midnight. Measured 2026-10-04 at 00:37
        // local: this test failed on unmodified main with
        //     Expected pattern: /^\d{2}:\d{2}$/
        //     Received string:  "yesterday, 21:55"
        // and it failed the same way on CI run 111295862750, on a PR whose diff
        // touched only CLAUDE.md and one guard file. A ~2.5-hour window each
        // day in which the suite goes red for every branch.
        //
        // Only `Date` is faked. `userEvent` drives real timers, so faking those
        // too would hang the click below — hence `doNotFake` listing every
        // other fakeable API. Noon local (not UTC) so the "earlier today"
        // premise holds in any timezone the runner happens to use.
        jest.useFakeTimers({
            now: new Date(2026, 5, 15, 12, 0, 0),
            doNotFake: [
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'setImmediate',
                'clearImmediate',
                'queueMicrotask',
                'requestAnimationFrame',
                'cancelAnimationFrame',
                'requestIdleCallback',
                'cancelIdleCallback',
                'nextTick',
                'performance',
                'hrtime',
            ],
        });
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(screen.getByTestId('top-chrome-notifications-bell'));
        const list = await screen.findByTestId('notifications-list');
        await waitFor(() => {
            expect(list.querySelectorAll('.tabular-nums').length).toBeGreaterThan(0);
        });

        // P2.1 — this used to assert the literal tokens "5m", "2h", "3d".
        // Those were hand-built in this file and were ENGLISH for every user:
        // a Bulgarian farmer saw "5m". `formatChatTime` takes the phrasing
        // from Intl, so the assertions move from fixed strings to the SHAPE
        // each row should have.
        const chips = Array.from(list.querySelectorAll('.tabular-nums')).map(
            (c) => c.textContent ?? '',
        );
        expect(chips).toHaveLength(3);

        // 5 minutes → relative phrasing, in whatever language is active.
        expect(chips[0]).toMatch(/ago|преди|min|мин/i);
        // 150 minutes → earlier TODAY, so a time of day rather than "2h".
        expect(chips[1]).toMatch(/^\d{2}:\d{2}$/);
        // 3 days → still relative, not a date.
        expect(chips[2]).toMatch(/ago|преди|day|дни|дни|онзи/i);

        // The original regression this case was written for: no raw
        // `toLocaleDateString` output in a time chip. The length bound moves
        // 8 → 16 because a LOCALISED relative phrase is simply longer than
        // "5m" («преди 5 мин» is eleven characters) — but it stays a bound,
        // and 16 still excludes "30/09/2026, 15:43" (17) and every full
        // date-plus-time form. The slash and year checks are untouched, and
        // they are what actually separate a token from a date.
        const year = new Date().getFullYear().toString();
        for (const text of chips) {
            expect(text).not.toContain('/');
            expect(text).not.toContain(year);
            expect(text.length).toBeLessThanOrEqual(16);
        }
    });

    // ── both viewports, and here that is not a formality (#1995) ──
    //
    // P7.6's standing rule is "rendered tests at both `setViewport('mobile')`
    // and `('desktop')`", and for most components it buys insurance. For this
    // one it covers a different component tree: `@/components/ui/popover` is
    // "Radix Popover on desktop, Vaul Drawer on mobile (via `useMediaQuery`)".
    //
    // And jsdom's `matchMedia` stub answers `matches: false` to everything, so
    // the DEFAULT is mobile — meaning every popover assertion in this file has
    // only ever rendered the Vaul drawer, and the Radix path the bell shows on
    // a desktop browser had no coverage at all. That is why these two cases
    // are parametrised rather than given one extra `setViewport('desktop')`
    // case: the whole popover body is what changes.
    describe.each([['mobile'], ['desktop']] as const)('popover at %s', (viewport) => {
        beforeEach(() => setViewport(viewport));

    it('opening the popover renders one row per notification with the hover recipe', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(
            screen.getByTestId('top-chrome-notifications-bell'),
        );

        // Each notification renders a row keyed by id.
        const row1 = await screen.findByTestId('notification-row-n1');
        expect(
            screen.getByTestId('notification-row-n2'),
        ).toBeInTheDocument();
        expect(
            screen.getByTestId('notification-row-n3'),
        ).toBeInTheDocument();

        // The row hover surface is the canonical `hover:bg-bg-muted/50`
        // — the same /50 recipe as the bell button, not a solid tint.
        expect(row1.className).toContain('hover:bg-bg-muted/50');

        // n1 has a linkUrl → it must render as a real navigable
        // anchor, not a button.
        expect(row1.tagName).toBe('A');
        expect(row1.getAttribute('href')).toBe('/t/acme/practices/c12');
        // n2 has no linkUrl → renders as a button.
        expect(
            screen.getByTestId('notification-row-n2').tagName,
        ).toBe('BUTTON');
    });

    it('shows the "All clear" empty state when there are no notifications', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => [],
        });
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(
            screen.getByTestId('top-chrome-notifications-bell'),
        );

        // The audit's R11 personality vocabulary: "All clear", not a
        // generic "No notifications".
        expect(await screen.findByText('All clear')).toBeInTheDocument();
    });
    });

    it('REST-polls /api/notifications on a fixed interval (badge stays live)', async () => {
        // The bell's doc-comment promised a periodic poll; the code
        // shipped without one, so the badge froze at its mount-time
        // value. This asserts the poll is real: advancing the
        // 60s interval triggers a fresh fetch with no user action.
        jest.useFakeTimers();
        try {
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => makeNotifications(),
            });
            render(<NotificationsBell />);
            // Flush the mount-time fetch.
            await act(async () => {});
            const afterMount = fetchMock.mock.calls.length;
            expect(afterMount).toBeGreaterThanOrEqual(1);

            // One poll interval elapses → at least one more fetch.
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(afterMount);

            // The poll is periodic — a second interval fetches again.
            const afterFirstPoll = fetchMock.mock.calls.length;
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirstPoll);
        } finally {
            jest.useRealTimers();
        }
    });

    it('throttles the poll to 5 minutes once the stream opens, and back to 60s on error', async () => {
        /**
         * #1982 — this branch was UNREACHABLE before the fix.
         *
         * The cadence was read from a `sseHealthy` flag in the same tick that
         * constructed the `EventSource`, so `onopen` could not have fired and
         * the five-minute value was never chosen. `setInterval` was created
         * once and never revisited, so a healthy stream polled every 60s
         * forever. Nothing failed — the bell updated either way — which is
         * why it survived review and why the assertion below is the one that
         * discriminates: step 3 passes on 60s-forever code only by accident,
         * step 4 cannot.
         *
         * P7.6 (#1995) made that fix structural rather than careful: the
         * cadence is now DERIVED from the connection state the hook returns,
         * so the effect re-runs on every transition and there is no flag to
         * read at the wrong moment. These five steps are unchanged because
         * they describe behaviour rather than mechanism — which is why they
         * survived a rewrite of the mechanism, and the point of writing them
         * that way.
         */
        class FakeEventSource {
            static last: FakeEventSource | null = null;
            onopen: (() => void) | null = null;
            onmessage: ((e: { data: string }) => void) | null = null;
            onerror: (() => void) | null = null;
            closed = false;
            readonly url: string;
            constructor(url: string) {
                this.url = url;
                FakeEventSource.last = this;
            }
            close() {
                this.closed = true;
            }
        }
        const g = globalThis as unknown as { EventSource?: unknown };
        const had = Object.prototype.hasOwnProperty.call(g, 'EventSource');
        const prior = g.EventSource;
        g.EventSource = FakeEventSource;
        jest.useFakeTimers();
        try {
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => makeNotifications(),
            });
            render(<NotificationsBell />);
            await act(async () => {});

            // The stream is subscribed to, and to the right endpoint.
            //
            // `/api/me/stream` rather than `/api/notifications/stream` as of
            // P7.6 (#1995): the bell no longer owns a connection, it
            // subscribes to the one `useRealtime` shares. The handle is still
            // reachable here because the hook constructs a real `EventSource`
            // — this fake — so driving `onopen` and `onerror` below still
            // exercises the same transitions, now through the hook's state
            // rather than through the bell's own handlers.
            expect(FakeEventSource.last).not.toBeNull();
            expect(FakeEventSource.last!.url).toBe('/api/me/stream');

            // 1. Before the stream opens, the poll is the only signal: 60s.
            const beforeOpen = fetchMock.mock.calls.length;
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeOpen);

            // 2. The stream opens.
            await act(async () => {
                FakeEventSource.last!.onopen?.();
            });
            const afterOpen = fetchMock.mock.calls.length;

            // 3. 60s no longer triggers a poll — the throttle is in effect.
            //    This is the assertion the pre-fix code fails.
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBe(afterOpen);

            // 4. ...and it is a throttle, not a stop: the safety-net poll
            //    still fires at five minutes, so a cross-pod notification
            //    cannot be lost forever.
            await act(async () => {
                jest.advanceTimersByTime(4 * 60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(afterOpen);

            // 5. On error the cadence returns to 60s, because the poll is
            //    the only signal again.
            await act(async () => {
                FakeEventSource.last!.onerror?.();
            });
            const afterError = fetchMock.mock.calls.length;
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(afterError);
        } finally {
            jest.useRealTimers();
            if (had) g.EventSource = prior;
            else delete g.EventSource;
        }
    });

    it('CONTROL: the two viewports really do render different popovers', async () => {
        // Without this, the parametrisation above could be two runs of the
        // same tree and nobody would know — which is exactly the state the
        // file was in, since jsdom resolves every media query to false.
        //
        // Measured rather than guessed, and the first guess was wrong:
        // `[data-vaul-drawer]` is absent in both, and `data-radix-focus-guard`
        // is present in both (Vaul builds on Radix Dialog). Dumping every
        // data-/aria- attribute at each viewport gave the real split:
        //
        //   mobile  only: data-scroll-locked, data-aria-hidden
        //   desktop only: data-radix-popper-content-wrapper, data-radix-popper-side
        //
        // Both directions are asserted, so neither tree can satisfy both.
        const open = async (): Promise<{ popper: boolean; scrollLocked: boolean }> => {
            const user = userEvent.setup();
            fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] });
            const view = render(<NotificationsBell />);
            await waitFor(() => expect(fetchMock).toHaveBeenCalled());
            await user.click(screen.getByTestId('top-chrome-notifications-bell'));
            await screen.findByText('All clear');
            const shape = {
                popper: document.querySelector('[data-radix-popper-content-wrapper]') !== null,
                scrollLocked: document.querySelector('[data-scroll-locked]') !== null,
            };
            view.unmount();
            return shape;
        };

        setViewport('mobile');
        expect(await open()).toEqual({ popper: false, scrollLocked: true });

        setViewport('desktop');
        expect(await open()).toEqual({ popper: true, scrollLocked: false });
    });

    it('the default viewport is the mobile one, which is why the above is needed', () => {
        // Pinning the premise rather than restating it in prose. If the helper
        // ever defaults to desktop, the comment above goes stale silently and
        // the "every assertion ran mobile" claim stops being true.
        expect(DEFAULT_VIEWPORT).toBe('mobile');
    });
});
