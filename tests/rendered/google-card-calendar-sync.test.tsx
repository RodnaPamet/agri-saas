/**
 * The Google card's calendar-sync control — #2020.
 *
 * Two fields of the sync's response are CONTRACTS rather than statistics, and
 * this file exists because a guard cannot tell whether they reach the screen:
 *
 *   - `partial: true` means the sync declined to delete anything, because the
 *     source read was truncated. The calendar may hold an event the farm no
 *     longer has.
 *   - `skippedEdited > 0` means events the farmer had edited were left alone,
 *     so the calendar deliberately disagrees with the farm.
 *
 * In both cases a plain "Calendar updated" is a claim about a clean run that
 * did not happen — the `truncated`-flag lesson from the offline basemap pack,
 * where an outage produced a sweep of 204s and a confident "Offline map ready"
 * over an empty pack.
 *
 * Copy comes from the REAL English catalogue via the project-wide next-intl
 * mock in `tests/rendered/setup.ts`, so these assertions are byte-identical to
 * production output — which also means a missing key would render as its own
 * dotted path and fail here rather than shipping.
 *
 * Viewport: the project default (a phone). Stated rather than inherited
 * silently — this card has no responsive branch, so the two viewports render
 * the same tree and the default is the honest choice.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiPostMock = jest.fn();

jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    __esModule: true,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));
jest.mock('@/lib/api-client', () => ({
    __esModule: true,
    apiPost: (...a: unknown[]) => apiPostMock(...a),
}));
// SPREAD the real barrel. `@/components/ui/hooks` exports a dozen hooks and a
// partial factory throws for every one it omits — the trap ~55 suites in this
// repo hit with `@/lib/audit`.
jest.mock('@/components/ui/hooks', () => ({
    ...(jest.requireActual('@/components/ui/hooks') as object),
    useToastWithUndo: () => jest.fn(),
}));

import { GoogleCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/GoogleCard';

/** One connection with Calendar granted, as the collection endpoint returns it. */
const WITH_CALENDAR = [
    {
        id: 'c1',
        name: 'Google',
        isEnabled: true,
        configJson: { grantedProducts: { drive: false, calendar: true } },
        createdAt: '2026-10-01T00:00:00Z',
    },
];

const DRIVE_ONLY = [
    {
        id: 'c1',
        name: 'Google',
        isEnabled: true,
        configJson: { grantedProducts: { drive: true, calendar: false } },
        createdAt: '2026-10-01T00:00:00Z',
    },
];

function stubList(rows: unknown[]) {
    global.fetch = jest.fn(async () =>
        ({ ok: true, status: 200, json: async () => rows }) as unknown as Response,
    ) as unknown as typeof fetch;
}

const CLEAN = { created: 2, updated: 1, deleted: 0, unchanged: 5, skippedEdited: 0, partial: false };

/** Mount, wait for the connection list, and return a typing-capable user. */
async function mountCard() {
    const user = userEvent.setup();
    render(<GoogleCard />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    return user;
}

beforeEach(() => {
    jest.clearAllMocks();
    apiPostMock.mockResolvedValue(CLEAN);
});

describe('the sync control is offered on the right connections (#2020)', () => {
    it('appears when Calendar is granted', async () => {
        stubList(WITH_CALENDAR);
        await mountCard();
        expect(await screen.findByRole('button', { name: 'Sync calendar' })).toBeInTheDocument();
    });

    it('is absent on a Drive-only connection', async () => {
        // Absent rather than disabled: a disabled control advertises a feature
        // this connection cannot perform, and the card already says Calendar
        // is not granted and how to fix it.
        stubList(DRIVE_ONLY);
        await mountCard();
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Sync calendar' })).not.toBeInTheDocument(),
        );
        // The control for the control: the card DID render, so the absence is
        // about the connection and not about a failed mount. Anchored, because
        // an unanchored /Connect/i also matches «Disconnect».
        expect(screen.getByRole('button', { name: /^Connect/ })).toBeInTheDocument();
    });

    it('is absent with no connection at all', async () => {
        stubList([]);
        await mountCard();
        expect(screen.queryByRole('button', { name: 'Sync calendar' })).not.toBeInTheDocument();
    });
});

describe('what the sync reports reaches the screen (#2020)', () => {
    it('a clean run shows the counts and NO warning', async () => {
        // The control. Without it, an implementation that always warned would
        // satisfy both cases below.
        stubList(WITH_CALENDAR);
        const user = await mountCard();
        await user.click(await screen.findByRole('button', { name: 'Sync calendar' }));

        expect(await screen.findByText(/Calendar updated/)).toBeInTheDocument();
        expect(screen.getByText(/New: 2/)).toBeInTheDocument();
        expect(screen.getByText(/Unchanged: 5/)).toBeInTheDocument();
        expect(screen.queryByText(/nothing was removed/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Left unchanged because you edited/)).not.toBeInTheDocument();
    });

    it('a TRUNCATED run says nothing was removed', async () => {
        // The whole point of the `partial` field. Without this notice the
        // farmer sees "Calendar updated" over a calendar that may hold a
        // deadline the farm has dropped.
        apiPostMock.mockResolvedValue({ ...CLEAN, partial: true });
        stubList(WITH_CALENDAR);
        const user = await mountCard();
        await user.click(await screen.findByRole('button', { name: 'Sync calendar' }));

        expect(await screen.findByText(/nothing was removed/)).toBeInTheDocument();
        expect(screen.getByText(/could not be read in full/)).toBeInTheDocument();
    });

    it('edited events are reported, with the count', async () => {
        apiPostMock.mockResolvedValue({ ...CLEAN, skippedEdited: 3 });
        stubList(WITH_CALENDAR);
        const user = await mountCard();
        await user.click(await screen.findByRole('button', { name: 'Sync calendar' }));

        expect(await screen.findByText(/Left unchanged because you edited them in Google: 3/))
            .toBeInTheDocument();
    });

    it('zero edited events shows no such notice', async () => {
        // `skippedEdited: 0` must not render "… : 0", which reads as a problem
        // where there is none.
        stubList(WITH_CALENDAR);
        const user = await mountCard();
        await user.click(await screen.findByRole('button', { name: 'Sync calendar' }));

        await screen.findByText(/Calendar updated/);
        expect(screen.queryByText(/Left unchanged because you edited/)).not.toBeInTheDocument();
    });
});

describe('a refusal shows the SERVER’s sentence (#2020)', () => {
    it('renders the message the server sent, not a local string', async () => {
        // Owner ruling #1677: the server resolves the locale and sends
        // `message` already translated, and the web reads the error `code`
        // nowhere. A local code->copy map would be the second catalogue that
        // ruling exists to prevent — and the server's sentence is the one that
        // names the remedy for THIS refusal.
        apiPostMock.mockRejectedValue(
            new Error(
                'The Google connection does not include Calendar access. Reconnect it and grant Calendar.',
            ),
        );
        stubList(WITH_CALENDAR);
        const user = await mountCard();
        await user.click(await screen.findByRole('button', { name: 'Sync calendar' }));

        expect(await screen.findByText(/Reconnect it and grant Calendar/)).toBeInTheDocument();
        // And no success notice beside it.
        expect(screen.queryByText(/Calendar updated/)).not.toBeInTheDocument();
    });

    it('lets the SERVER’s 60s budget expire before the client gives up', async () => {
        // `apiPost` otherwise applies a 20s default while the route declares
        // `maxDuration = 60`, so a first sync on an established farm would be
        // aborted by the client and reported as a failure having actually
        // succeeded. The signal must be the caller's.
        stubList(WITH_CALENDAR);
        const user = await mountCard();
        await user.click(await screen.findByRole('button', { name: 'Sync calendar' }));

        await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
        const init = apiPostMock.mock.calls[0][3] as RequestInit | undefined;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
});
