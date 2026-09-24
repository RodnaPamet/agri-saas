/**
 * The parcel archive page — what a farmer actually sees.
 *
 * The three design guards and the typechecker pin this page's STRUCTURE: that
 * it uses the detail shell, a MetaStrip, one primary action per file. None of
 * them can say whether a crop season renders, whether a free-text weed
 * survives to the screen, or whether an empty archive explains itself rather
 * than showing nothing. That is what this file is for.
 *
 * The assertions are chosen around the ways this page could silently lie:
 *
 *   - a dose rendered from a Decimal STRING must not be reformatted, because
 *     the wire carries exact values and a float would round a spray rate;
 *   - a weed the catalogue does not know must still appear, since `otherWeeds`
 *     exists precisely so a farmer can record what they actually found;
 *   - an empty list must say it is empty, because an archive that renders
 *     nothing is indistinguishable from one that failed to load.
 */
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/parcels/p1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme', parcelId: 'p1' }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantContext: () => ({ tenantSlug: 'acme', permissions: { canWrite: true } }),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

const mockHistory = {
    data: undefined as unknown,
    error: undefined as unknown,
    isLoading: false,
};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ ...mockHistory, mutate: jest.fn() }),
}));
jest.mock('@/lib/api-client', () => ({
    apiPost: jest.fn().mockResolvedValue({ id: 'new' }),
    apiDelete: jest.fn().mockResolvedValue({ ok: true }),
    ApiClientError: class extends Error {},
}));

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import ParcelHistoryPage from '@/app/t/[tenantSlug]/(app)/parcels/[parcelId]/page';
import enMessages from '@/../messages/en.json';

const COPY = enMessages.ag.parcelHistory;

const FULL = {
    parcel: { id: 'p1', name: 'North block', cropType: 'Wheat' },
    cropSeasons: [
        { id: 'cs1', year: 2026, cropType: 'Wheat', sownAt: '2025-10-12T00:00:00.000Z', harvestedAt: null, notes: null },
        { id: 'cs2', year: 2024, cropType: 'Grass', sownAt: null, harvestedAt: null, notes: null },
    ],
    operations: [
        {
            id: 'op1', taskId: 't1', operationType: 'SPRAY', title: 'Spring spray',
            completedAt: '2026-04-02T00:00:00.000Z', productName: 'Roundup',
            doseValue: '1.2345', doseUnit: 'l/ha', targetNote: null,
        },
    ],
    weedObservations: [
        {
            id: 'w1', observedAt: '2026-05-14T00:00:00.000Z',
            weedKeys: ['Sorghum halepense'], otherWeeds: ['нещо непознато'], notes: null,
        },
    ],
};

const EMPTY = {
    parcel: { id: 'p1', name: 'North block', cropType: null },
    cropSeasons: [], operations: [], weedObservations: [],
};

function mount(data: unknown) {
    mockHistory.data = data;
    mockHistory.error = undefined;
    mockHistory.isLoading = false;
    return render(
        <TooltipProvider delayDuration={0}>
            <ParcelHistoryPage />
        </TooltipProvider>,
    );
}

describe('the archive renders what the farmer recorded', () => {
    it('shows each crop season with its harvest year', () => {
        mount(FULL);
        expect(screen.getByText('2026')).toBeInTheDocument();
        expect(screen.getByText('2024')).toBeInTheDocument();
    });

    it('renders a crop that is NOT in the picker catalogue', () => {
        // `Grass` was live on a real parcel while absent from CROP_OPTIONS.
        // `cropLabel` falls back to the raw value; this asserts the page does
        // not swallow one it cannot translate.
        mount(FULL);
        expect(screen.getByText('Grass')).toBeInTheDocument();
    });

    it('renders the dose EXACTLY as the wire carried it', () => {
        // The API sends a Decimal as a string so a spray rate cannot be
        // rounded. Formatting it as a number here would undo that.
        mount(FULL);
        expect(screen.getByText(/1\.2345/)).toBeInTheDocument();
        expect(screen.getByText(/Roundup/)).toBeInTheDocument();
    });

    it('shows catalogue weeds AND free-text weeds together', () => {
        // Storage keeps two columns so the controlled half stays reportable.
        // The farmer does not think of them as two lists, and the screen
        // must not either — `otherWeeds` exists so an unlisted species is
        // still recordable, which is worthless if it is then hidden.
        mount(FULL);
        expect(screen.getByText(/Johnson grass/)).toBeInTheDocument();   // catalogue → localised
        expect(screen.getByText(/нещо непознато/)).toBeInTheDocument();  // free text → verbatim
    });

    it('names the current crop in the meta strip', () => {
        mount(FULL);
        expect(screen.getByText(COPY.currentCrop)).toBeInTheDocument();
    });
});

describe('an empty archive explains itself', () => {
    it('shows a distinct empty state for each section', () => {
        // An archive that renders nothing is indistinguishable from one that
        // failed to load. Each section says which kind of nothing it is.
        mount(EMPTY);
        expect(screen.getByText(COPY.cropsEmpty)).toBeInTheDocument();
        expect(screen.getByText(COPY.opsEmpty)).toBeInTheDocument();
        expect(screen.getByText(COPY.weedsEmpty)).toBeInTheDocument();
    });

    it('says so when no current crop is set, rather than rendering a blank', () => {
        mount(EMPTY);
        expect(screen.getByText(COPY.noCurrentCrop)).toBeInTheDocument();
    });

    it('still offers both add actions on an empty archive', () => {
        // The state where a farmer most needs them — back-filling starts here.
        mount(EMPTY);
        expect(screen.getByRole('button', { name: COPY.cropsAdd })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: COPY.weedsAdd })).toBeInTheDocument();
    });
});

describe('the authoring paths are reachable', () => {
    it('opens the crop form', async () => {
        const user = userEvent.setup();
        mount(EMPTY);
        await user.click(screen.getByRole('button', { name: COPY.cropsAdd }));
        expect(await screen.findByText(COPY.fieldYearHint)).toBeInTheDocument();
    });

    it('opens the weed form, and offers the free-text escape beside the list', async () => {
        const user = userEvent.setup();
        mount(EMPTY);
        await user.click(screen.getByRole('button', { name: COPY.weedsAdd }));
        expect(await screen.findByText(COPY.fieldWeedsHint)).toBeInTheDocument();
        expect(screen.getByText(COPY.otherWeed)).toBeInTheDocument();
    });
});
