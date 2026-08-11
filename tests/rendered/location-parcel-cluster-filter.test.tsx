/**
 * Location detail — the parcel-overview map filters the parcels table.
 *
 * This is the end-to-end half of P3: a cluster is picked, the Epic 53
 * filter state changes, and the table beneath it narrows. The map
 * component is deliberately NOT stubbed — a stub would prove the page
 * wires up whatever the stub exposes, not that the shipped control
 * reaches the shipped filter. Only the 100 KB geometry asset is mocked,
 * because jsdom has nothing to fetch it from.
 *
 * ── Which DataTable branch these exercise ────────────────────────────
 *
 * The parcels table is a `<DataTable mobileFallback="card">` and the
 * jsdom default viewport is a PHONE, where `MobileCardList` renders
 * instead and omits every column without `meta.mobileCard`. The row
 * assertions below therefore pin `desktop` and read the real `<table>`.
 * The final test pins `mobile` deliberately: the filter is a property of
 * the page, not of a viewport, and a fix applied to one DataTable branch
 * is not a fix applied to the other.
 *
 * ── Canvas ───────────────────────────────────────────────────────────
 *
 * jsdom returns null from `getContext('2d')`, so nothing is painted and
 * every click below goes through the cluster LIST — which is the point.
 * That list is the accessible path P3.4 requires, and these tests are
 * what prove it reaches the same filter state a canvas click would.
 *
 * Every `it()` names the production break it catches.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { setViewport, restoreViewport } from './viewport';

// `useFilterContext` seeds from `window.location.search` directly, and the
// page's `?tab=` initializer reads `useSearchParams` — keep both looking
// at the same URL so a test can drive them together.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', locationId: 'loc1' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => '/t/acme/locations/loc1',
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p.startsWith('/') ? p : `/${p}`}`,
}));

jest.mock('@/lib/api-client', () => ({
    apiPost: jest.fn(),
    apiPatch: jest.fn(),
    apiDelete: jest.fn(),
    ApiClientError: class extends Error {},
}));

// Four parcels, two crops, in two proximity groups — so a cluster cut and
// a crop cut can be shown to COMPOSE rather than override each other.
const PARCELS = [
    { id: 'p1', name: 'Нива 1', areaHa: 5, cropType: 'Wheat', geometry: null },
    { id: 'p2', name: 'Нива 2', areaHa: 4, cropType: 'Wheat', geometry: null },
    { id: 'p3', name: 'Нива 3', areaHa: 3, cropType: 'Sunflower', geometry: null },
    { id: 'p4', name: 'Нива 4', areaHa: 2, cropType: 'Sunflower', geometry: null },
];

const OVERVIEW = {
    clusters: [
        {
            id: 'cA',
            lon: 26.9,
            lat: 43.11,
            count: 2,
            parcelIds: ['p1', 'p3'],
            totalAreaHa: 8,
            label: 'Драгоево',
        },
        {
            id: 'cB',
            lon: 26.7,
            lat: 43.2,
            count: 2,
            parcelIds: ['p2', 'p4'],
            totalAreaHa: 6,
            label: 'Каспичан',
        },
    ],
    parcels: [
        { id: 'p1', lon: 26.9, lat: 43.11 },
        { id: 'p2', lon: 26.7, lat: 43.2 },
        { id: 'p3', lon: 26.901, lat: 43.111 },
        { id: 'p4', lon: 26.701, lat: 43.201 },
    ],
    bbox: [26.7, 43.09, 26.94, 43.2],
    positionedCount: 4,
    unpositionedCount: 0,
    unpositionedParcelIds: [],
    truncated: false,
};

/**
 * A FINER clustering, as tier 12 would cut it — different pitch,
 * therefore different member sets, therefore different ids. `cFINE`
 * exists here and nowhere else, which is what lets the snapshot test
 * below distinguish "the filter survived the tier change" from "the id
 * happened to still be there".
 */
const OVERVIEW_TIER_12 = {
    ...OVERVIEW,
    clusters: [
        {
            id: 'cFINE',
            lon: 26.9,
            lat: 43.11,
            count: 2,
            parcelIds: ['p1', 'p3'],
            totalAreaHa: 8,
            label: 'Драгоево',
        },
    ],
};

const swrKeys: string[] = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string | null) => {
        if (path) swrKeys.push(path);
        const idle = { data: undefined, isLoading: false, isValidating: false, error: null, mutate: jest.fn() };
        if (path === '/locations/loc1') {
            return {
                ...idle,
                data: { id: 'loc1', name: 'Field A', status: 'ACTIVE', _count: { parcels: 4 } },
            };
        }
        if (path === '/locations/loc1/parcels') {
            return { ...idle, data: { locationId: 'loc1', bounds: [0, 0, 1, 1], parcels: PARCELS } };
        }
        if (path?.startsWith('/locations/loc1/parcel-clusters')) {
            return { ...idle, data: path.endsWith('zoom=12') ? OVERVIEW_TIER_12 : OVERVIEW };
        }
        return idle;
    },
    usePrefetchTenant: () => () => {},
}));

// The only mock the map itself gets: a 100 KB static asset jsdom cannot fetch.
jest.mock('@/lib/geo/bg-geometry-client', () => ({
    loadBgMapGeometry: () =>
        Promise.resolve({
            W: 1000,
            H: 600,
            proj: {
                minX: 22.3482, maxX: 28.60972, minY: 41.23384, maxY: 44.21002,
                cos: 0.734655, ox: 51.769, oy: 10, s: 194.8807,
            },
            oblasti: [],
            outlinePath: '',
        }),
    resetBgMapGeometryCache: () => {},
}));

// MapCanvas is MapLibre/WebGL and lives in the OTHER tab; keep it off the
// graph exactly as the merge suite does.
jest.mock('@/components/ui/map/MapCanvas', () => ({
    MapCanvas: () => <div data-testid="map-canvas" />,
}));
jest.mock('next/dynamic', () => () => {
    const mod = require('@/components/ui/map/MapCanvas');
    return mod.MapCanvas;
});
jest.mock('@/components/ui/map/SpatialImportModal', () => ({ SpatialImportModal: () => null }));
jest.mock('@/components/ui/map/PrescriptionPanel', () => ({ PrescriptionPanel: () => null }));
jest.mock('@/components/ui/map/FieldOperationPanel', () => ({ FieldOperationPanel: () => null }));
jest.mock('@/components/ui/map/ParcelDetailSheet', () => ({ ParcelDetailSheet: () => null }));

import LocationDetailPage from '@/app/t/[tenantSlug]/(app)/locations/[locationId]/page';

function setUrl(search: string) {
    window.history.replaceState({}, '', `/t/acme/locations/loc1${search}`);
}

/** Render on the Overview tab with the parcels accordion expanded. */
function openParcels() {
    render(<LocationDetailPage />);
    fireEvent.click(screen.getByRole('button', { name: /^Parcels/ }));
}

/**
 * Row names, found by CONTENT rather than by column index — DataTable
 * renders a selection column by default, and pinning this to cell[1]
 * would break on a props change that has nothing to do with filtering.
 */
function tableParcelNames(): string[] {
    const table = screen.getByRole('table');
    return within(table)
        .getAllByRole('row')
        .slice(1) // header
        .map(
            (r) =>
                within(r)
                    .getAllByRole('cell')
                    .map((c) => c.textContent?.trim() ?? '')
                    .find((txt) => txt.startsWith('Нива')) ?? '',
        )
        .filter(Boolean);
}

beforeEach(() => {
    swrKeys.length = 0;
    setUrl('?tab=overview');
});
afterEach(() => {
    restoreViewport();
    setUrl('');
    jest.clearAllMocks();
});

describe('cluster selection narrows the parcels table (desktop)', () => {
    beforeEach(() => setViewport('desktop'));

    it('lists every parcel before anything is filtered', () => {
        openParcels();
        expect(tableParcelNames()).toEqual(['Нива 1', 'Нива 2', 'Нива 3', 'Нива 4']);
    });

    // Break: the map being a decoration that filters nothing — the whole
    // point of P3, and the one thing a stubbed map could never prove.
    it('narrows the table to a group picked from the accessible list', () => {
        openParcels();
        fireEvent.click(screen.getByRole('button', { name: 'Драгоево · 2 parcels' }));
        expect(tableParcelNames()).toEqual(['Нива 1', 'Нива 3']);
    });

    // Break: the accordion's count reading the unfiltered total above a
    // filtered table — it keyed off the crop chip alone before this work.
    it('keeps the accordion count honest about what is on screen', () => {
        openParcels();
        expect(screen.getByRole('button', { name: 'Parcels 4' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Драгоево · 2 parcels' }));
        expect(screen.getByRole('button', { name: 'Parcels 2' })).toBeInTheDocument();
    });

    // Break: the two facets overriding each other instead of composing,
    // which is what two independent filter mechanisms on one table gets you.
    it('composes the cluster facet with the crop chips', () => {
        openParcels();
        fireEvent.click(screen.getByRole('button', { name: 'Драгоево · 2 parcels' }));
        fireEvent.click(screen.getByRole('radio', { name: 'Wheat' }));
        // cA is {p1, p3}; Wheat is {p1, p2}. The intersection is p1 alone.
        expect(tableParcelNames()).toEqual(['Нива 1']);
    });

    it('restores the whole holding when the group is cleared', () => {
        openParcels();
        fireEvent.click(screen.getByRole('button', { name: 'Каспичан · 2 parcels' }));
        expect(tableParcelNames()).toEqual(['Нива 2', 'Нива 4']);
        fireEvent.click(screen.getByRole('button', { name: 'Show all parcels' }));
        expect(tableParcelNames()).toEqual(['Нива 1', 'Нива 2', 'Нива 3', 'Нива 4']);
    });

    // Break: a shared `?cluster=` link resolving against a payload cut at
    // a different grid pitch, filtering to zero rows and calling the
    // holding empty. The tier rides in the token so the first fetch is
    // the one that can answer it.
    it('resolves a shared link against the pitch the id was minted at', () => {
        // `cFINE` exists ONLY in the tier-12 cut. If the cold load used
        // the page's default tier instead of the token's, the id would
        // resolve to nothing and the table would render every parcel (or,
        // worse, none) — so this genuinely discriminates.
        setUrl('?tab=overview&cluster=cFINE%4012');
        openParcels();
        expect(tableParcelNames()).toEqual(['Нива 1', 'Нива 3']);

        const clusterKeys = swrKeys.filter((k) => k.includes('parcel-clusters'));
        expect(clusterKeys[0]).toBe('/locations/loc1/parcel-clusters?zoom=12');
    });

    // Break: THE central failure this design exists to prevent. The map
    // settles to the tier its own framing wants (9 here), whose cut does
    // not contain `cFINE` at all. Filtering by a live re-lookup would
    // find nothing and the table would render its empty state — a
    // confident "no parcels" produced by a stale id. The snapshot is
    // what makes the answer survive.
    it('keeps the picked group after the view settles to a different pitch', () => {
        setUrl('?tab=overview&cluster=cFINE%4012');
        openParcels();

        const clusterKeys = swrKeys.filter((k) => k.includes('parcel-clusters'));
        expect(clusterKeys).toContain('/locations/loc1/parcel-clusters?zoom=9');
        // The tier-9 payload has no `cFINE`, and the rows are still right.
        expect(tableParcelNames()).toEqual(['Нива 1', 'Нива 3']);
    });

    // Break: filtering the table to nothing and rendering that as an empty
    // holding, when the truth is that the group no longer exists.
    it('clears a token that resolves to no group rather than emptying the table', () => {
        setUrl('?tab=overview&cluster=cGONE%409');
        openParcels();
        expect(tableParcelNames()).toEqual(['Нива 1', 'Нива 2', 'Нива 3', 'Нива 4']);
    });
});

describe('cluster selection narrows the parcels list (mobile)', () => {
    beforeEach(() => setViewport('mobile'));

    // Break: the filter working in the `<table>` branch only. On a phone
    // `MobileCardList` renders instead, and this product's operator is on
    // a phone — a fix applied to one branch is not a fix applied to both.
    it('filters the card list too', () => {
        openParcels();
        expect(screen.queryByRole('table')).toBeNull();
        expect(screen.getByText('Нива 2')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Драгоево · 2 parcels' }));
        expect(screen.getByText('Нива 1')).toBeInTheDocument();
        expect(screen.queryByText('Нива 2')).toBeNull();
    });
});
