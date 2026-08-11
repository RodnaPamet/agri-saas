/**
 * In-map merge UI — Location detail Map tab.
 *
 * MapCanvas mounts MapLibre/WebGL, which jsdom can't render, so we mock
 * the dynamic-imported MapCanvas with a lightweight stub that exposes the
 * selection seam (`selectedIds`, `onSelectionChange`). That lets us drive
 * selection from the test and assert the page's merge toolbar logic + API
 * wiring:
 *
 *   1. the Select/Draw/Edit/Split map-mode toggle is GONE — the map is
 *      select-only now (draw/edit/split were removed with the toggle);
 *   2. the Merge action appears ONLY when ≥2 parcels are selected;
 *   3. confirming the merge modal POSTs `{ parcelIds, name }` to
 *      `.../parcels/merge`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

// ─── next/navigation: stable params + router (Modal calls useRouter) ─
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', locationId: 'loc1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    // The page reads `?parcelId` / `?tab` deep-links (feat/delight-shareables).
    useSearchParams: () => new URLSearchParams(),
    // The detail page's smart back-affordance (feat/smart-nav) reads the
    // pathname to resolve its destination.
    usePathname: () => '/t/acme/locations/loc1',
}));

// ─── tenant API url helper (mirrors the real `/api/t/{slug}` prefix) ─
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p.startsWith('/') ? p : `/${p}`}`,
}));

// ─── typed API client — capture POST bodies ────────────────────────
const apiPost = jest.fn();
const apiPatch = jest.fn();
class ApiClientError extends Error {
    status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.name = 'ApiClientError';
        this.status = status;
    }
}
jest.mock('@/lib/api-client', () => ({
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiPatch: (...a: unknown[]) => apiPatch(...a),
    ApiClientError,
}));

// ─── tenant SWR — route by path; expose a mutate spy ───────────────
const mutate = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string | null) => {
        if (path === '/locations/loc1') {
            return { data: { id: 'loc1', name: 'Field A', status: 'ACTIVE', _count: { parcels: 3 } }, isLoading: false, error: null, mutate };
        }
        if (path === '/locations/loc1/parcels') {
            return {
                data: {
                    locationId: 'loc1',
                    bounds: [0, 0, 1, 1],
                    parcels: [
                        { id: 'p1', name: 'North', areaHa: 10, geometry: { type: 'Polygon', coordinates: [] } },
                        { id: 'p2', name: 'South', areaHa: 5, geometry: { type: 'Polygon', coordinates: [] } },
                    ],
                },
                isLoading: false,
                error: null,
                mutate,
            };
        }
        // /agro/<index>-tiles, /operations, etc.
        return { data: undefined, isLoading: false, error: null, mutate };
    },
}));

// ─── MapCanvas stub — drives the selection seam from the test ──────
// `next/dynamic` resolves `import('@/components/ui/map/MapCanvas')` to
// `m.MapCanvas`; mocking the module makes the dynamic component this stub.
let lastSelectionHandler: ((ids: string[]) => void) | undefined;
jest.mock('@/components/ui/map/MapCanvas', () => ({
    MapCanvas: (props: {
        selectedIds?: string[];
        onSelectionChange?: (ids: string[]) => void;
    }) => {
        lastSelectionHandler = props.onSelectionChange;
        return (
            <div data-testid="map-canvas" data-selected={(props.selectedIds ?? []).join(',')} />
        );
    },
}));

// next/dynamic → resolve synchronously to the (mocked) module export.
jest.mock('next/dynamic', () => (loader: () => Promise<{ MapCanvas: React.ComponentType<unknown> }>) => {
    // The loader is `() => import('...').then(m => m.MapCanvas)`; but we
    // can't await in a sync mock, so return the mocked MapCanvas directly.
    const mod = require('@/components/ui/map/MapCanvas');
    void loader;
    return mod.MapCanvas;
});

// Quiet noisy side panels not under test.
jest.mock('@/components/ui/map/SpatialImportModal', () => ({ SpatialImportModal: () => null }));
jest.mock('@/components/ui/map/PrescriptionPanel', () => ({ PrescriptionPanel: () => <div data-testid="prescription-panel" /> }));
jest.mock('@/components/ui/map/FieldOperationPanel', () => ({ FieldOperationPanel: () => null }));
// The parcel sheet (#3) is now the create-operation form and mounts a
// react-query UserCombobox; stub it — this test exercises the merge toolbar,
// not the sheet, and provides no QueryClientProvider.
jest.mock('@/components/ui/map/ParcelDetailSheet', () => ({ ParcelDetailSheet: () => null }));

import { TooltipProvider } from '@/components/ui/tooltip';
import LocationDetailPage from '@/app/t/[tenantSlug]/(app)/locations/[locationId]/page';

function openMapTab() {
    // The Map tab's icon-only controls (cadastre overlay, parcel-group
    // locator) are `Tooltip`-wrapped, and Radix throws without a provider.
    // `providers.tsx` mounts one at the app root, so this mirrors
    // production rather than stripping the tooltips to suit the harness.
    render(
        <TooltipProvider delayDuration={0}>
            <LocationDetailPage />
        </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Map/i }));
}

beforeEach(() => {
    apiPost.mockReset();
    apiPatch.mockReset();
    mutate.mockReset();
    apiPost.mockResolvedValue({ id: 'new', areaHa: 15 });
    lastSelectionHandler = undefined;
});

describe('Location detail — merge toolbar', () => {
    it('no longer renders the Select/Draw/Edit/Split map-mode toggle', () => {
        openMapTab();
        // The toggle (and with it draw/edit/split authoring) was removed —
        // the map is select-only.
        for (const label of ['Select', 'Draw', 'Edit', 'Split']) {
            expect(screen.queryByRole('radio', { name: label })).not.toBeInTheDocument();
        }
    });

    it('shows the Merge action only when ≥2 parcels are selected', () => {
        openMapTab();
        // Nothing selected → no Merge trigger.
        expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();

        // Select one parcel → still no Merge.
        React.act(() => lastSelectionHandler?.(['p1']));
        expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();

        // Select a second → Merge appears.
        React.act(() => lastSelectionHandler?.(['p1', 'p2']));
        expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
    });

    it('merge modal POSTs { parcelIds, name } to .../parcels/merge', async () => {
        openMapTab();
        React.act(() => lastSelectionHandler?.(['p1', 'p2']));
        fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

        // Name the union + confirm.
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByPlaceholderText(/North block/i), { target: { value: 'Combined' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Merge parcels' }));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const [url, body] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/locations/loc1/parcels/merge');
        expect(body).toEqual({ parcelIds: ['p1', 'p2'], name: 'Combined' });
        await waitFor(() => expect(mutate).toHaveBeenCalled());
    });
});
