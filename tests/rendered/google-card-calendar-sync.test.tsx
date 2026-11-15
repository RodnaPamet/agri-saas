/**
 * The Google card offers NO calendar sync — #2020, then scrapped (#3070).
 *
 * ## What this file used to be, and why it is not deleted
 *
 * It was the behavioural cover for the sync control: eight cases over the two
 * fields of the response that are CONTRACTS rather than statistics
 * (`partial: true` meaning nothing was deleted, `skippedEdited > 0` meaning
 * the farmer's own edits were left alone), because a plain "Calendar updated"
 * over either one claims a clean run that did not happen.
 *
 * The owner scrapped the sync on 2026-11-15 — "let's scrap the google calendar
 * sync for now, leave the lunar in-app calendar" — and ruled to drop the
 * Calendar scope with it, so `GOOGLE_SCOPES` requests Drive only and the
 * control, its hint and its three result banners are gone from the card.
 *
 * Deleting this suite was the obvious move and is the wrong one twice over.
 * `rendered-coverage-floor` counts it (269 → 270 at #2020), so deletion means
 * lowering a shared ratchet to pay for a product decision — and more
 * importantly, the removal is a DECISION that deserves a pin. "For now" means
 * somebody will eventually propose putting the button back; this file is what
 * makes that proposal confront the scope it would need rather than reappear as
 * a tidy-looking revert.
 *
 * ## A negative assertion needs a positive control, and here it needs three
 *
 * "No Sync calendar button" is satisfied perfectly by a card that failed to
 * mount, by a fetch that never resolved, and by a renamed label. So every case
 * below also asserts the card RENDERED, and the strongest case asserts the
 * absence on the one connection that could still perform a sync — a
 * pre-existing grant — rather than only on connections that never could.
 *
 * Copy comes from the REAL English catalogue via the project-wide next-intl
 * mock in `tests/rendered/setup.ts`, so a missing key renders as its own
 * dotted path and fails here rather than shipping. That is what caught
 * `admin.integrations.googleCalendar` being deleted along with the sync keys.
 *
 * Viewport: the project default (a phone). Stated rather than inherited
 * silently — this card has no responsive branch, so both viewports render the
 * same tree and the default is the honest choice.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const apiPostMock = jest.fn();

jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    __esModule: true,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));
// Still mocked, and the assertion is that NOTHING calls it. The card no longer
// imports `apiPost` at all, so this doubles as a check that no sync request
// survives by another route.
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

/**
 * A connection that ALREADY holds a Calendar grant.
 *
 * This is the load-bearing fixture. No new connection can have it — the scope
 * is no longer requested — but one made before the scope was dropped can, and
 * it is the only connection on which a sync control could still work. A suite
 * that only checked Drive-only connections would pass with the button fully
 * restored.
 */
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

async function mountCard() {
    render(<GoogleCard />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the calendar sync control is gone (#3070)', () => {
    it('is absent even on a connection that still HOLDS a Calendar grant', async () => {
        stubList(WITH_CALENDAR);
        await mountCard();

        // The card rendered — so the absence below is about the feature and
        // not about a failed mount. Anchored, because an unanchored /Connect/i
        // also matches «Disconnect».
        expect(await screen.findByRole('button', { name: /^Connect/ })).toBeInTheDocument();
        expect(screen.getByText('Google')).toBeInTheDocument();

        expect(screen.queryByRole('button', { name: 'Sync calendar' })).not.toBeInTheDocument();
        // Nor its hint, nor any sync request.
        expect(screen.queryByText(/separate «Agrent/)).not.toBeInTheDocument();
        expect(apiPostMock).not.toHaveBeenCalled();
    });

    it('still REPORTS the Calendar grant it holds', async () => {
        // Removing the sync is not the same as hiding what we can reach. This
        // connection granted Calendar and that access has not been given back,
        // so the card has to say so — the integrations page is where a farm
        // sees what we hold, and the privacy notice points people at it.
        //
        // This is also the assertion that would have caught the actual defect:
        // deleting `admin.integrations.googleCalendar` along with the sync copy
        // left the badge rendering its own key path as user-facing text.
        stubList(WITH_CALENDAR);
        await mountCard();

        const granted = await screen.findByText(/^Calendar:/);
        expect(granted).toBeInTheDocument();
        expect(granted.textContent).toContain('Granted');
        // Not a dotted key path, which is what a missing key renders as.
        expect(granted.textContent).not.toMatch(/admin\.integrations/);
    });

    it('does not ask a Drive-only connection to reconnect for Calendar', async () => {
        // The reconnect nag is Drive-only now. While it also fired on a
        // missing Calendar grant it told every farm to reconnect to grant a
        // scope the consent screen no longer requests — advice that cannot be
        // followed, and the card is where somebody would keep trying.
        stubList(DRIVE_ONLY);
        await mountCard();

        expect(await screen.findByRole('button', { name: /^Connect/ })).toBeInTheDocument();
        expect(
            screen.queryByText(/To grant the missing permissions/),
        ).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Sync calendar' })).not.toBeInTheDocument();
    });

    it('still nags when DRIVE is the grant that is missing', async () => {
        // The control for the case above: the nag is narrowed, not deleted. A
        // card that never nagged would satisfy the previous assertion.
        stubList(WITH_CALENDAR);
        await mountCard();

        expect(await screen.findByText(/To grant the missing permissions/)).toBeInTheDocument();
    });

    it('is absent with no connection at all', async () => {
        stubList([]);
        await mountCard();

        expect(await screen.findByText(/No Google account is connected/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Sync calendar' })).not.toBeInTheDocument();
    });
});
