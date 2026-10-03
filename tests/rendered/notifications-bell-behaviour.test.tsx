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

import { NotificationsBell } from '@/components/layout/notifications-bell';

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
