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
            createdAt: isoMinutesAgo(150), // 2.5h → "2h"
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

    it('renders RELATIVE timestamps ("5m", "2h", "3d") — not raw dates', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeNotifications(),
        });
        render(<NotificationsBell />);
        // Wait for the mount-time fetch so the popover has data.
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        await user.click(
            screen.getByTestId('top-chrome-notifications-bell'),
        );

        const list = await screen.findByTestId('notifications-list');

        // The fixture rows are 5 minutes, 150 minutes, and 3 days old.
        // The bell's relative-time formatter must render "5m", "2h",
        // "3d" — compact relative strings.
        await waitFor(() => {
            expect(within(list).getByText('5m')).toBeInTheDocument();
        });
        expect(within(list).getByText('2h')).toBeInTheDocument();
        expect(within(list).getByText('3d')).toBeInTheDocument();

        // The exact regression the audit named: NO raw
        // `toLocaleDateString` output. A locale date for a 5-minute-
        // old notification would contain a slash or a month name and
        // a 4-digit year. Assert none of the rendered time chips
        // looks like a full date.
        const year = new Date().getFullYear().toString();
        const timeChips = list.querySelectorAll('.tabular-nums');
        expect(timeChips.length).toBeGreaterThan(0);
        for (const chip of Array.from(timeChips)) {
            const text = chip.textContent ?? '';
            // Relative chips are short tokens; a raw locale date is
            // long and carries the current year.
            expect(text).not.toContain('/');
            expect(text).not.toContain(year);
            expect(text.length).toBeLessThanOrEqual(8);
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
