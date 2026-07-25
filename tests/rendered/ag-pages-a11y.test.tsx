/**
 * WCAG-2.1-AA axe sweep for the five agriculture surfaces.
 *
 * Renders each ag client component against mocked data + the standard
 * next-intl / tenant-context / SWR wrapper used by the other rendered
 * tests and asserts `toHaveNoViolations()`. Mirrors the render shape of
 * `tests/rendered/risk-board-page.test.tsx` (SWR-backed pages) and
 * `tests/rendered/entity-list-page.test.tsx` (EntityListPage-backed
 * pages) so the harness stays consistent.
 *
 * Surfaces covered:
 *   1. LocationsClient        — locations list (DataTable + ListPageShell)
 *   2. InventoryClient        — input stock / lots / ledger
 *   3. CropPlansClient        — crop-plan succession list (EntityListPage)
 *   4. YieldClient            — grain yield records (EntityListPage)
 *   5. OfflineFieldPanel      — phones-with-gloves field-op client
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { SWRConfig } from 'swr';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';

// ─── Shared module mocks ─────────────────────────────────────────────

jest.mock('@/lib/tenant-context-provider', () => {
    // Mirror the real hooks' referential stability: production
    // useTenantApiUrl / useTenantHref are useCallback-memoized (one stable
    // fn per tenant). Returning a fresh closure per call would make any
    // consumer effect that lists the builder in its deps re-run every
    // render — so hoist the builders to module scope here.
    const apiUrl = (path: string) =>
        `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useTenantContext: () => ({
            tenantName: 'Acme Farms',
            tenantSlug: 'acme',
            currencySymbol: '€',
        }),
    };
});

jest.mock('next-intl', () => {
    // next-intl's `useTranslations` returns a CALLABLE that also carries
    // `.has()` / `.rich()` / `.markup()` / `.raw()`. Some ag components
    // (e.g. AgStatusBadge) probe `t.has(key)` before falling back to a
    // hard-coded label, so the mock must expose that surface — a bare
    // function would throw `t.has is not a function`.
    const makeT = () => {
        const t = (key: string, opts?: Record<string, unknown>) =>
            opts && 'count' in opts ? `${key}:${opts.count}` : key;
        // Report "key missing" so label-resolving components take their
        // English-fallback branch (deterministic, no message catalog).
        t.has = () => false;
        t.rich = (key: string) => key;
        t.markup = (key: string) => key;
        t.raw = (key: string) => key;
        return t;
    };
    return {
        useTranslations: () => makeT(),
        useFormatter: () => ({
            number: (v: unknown) => String(v),
            dateTime: (v: unknown) => String(v),
            relativeTime: (v: unknown) => String(v),
        }),
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme', locationId: 'loc-1' }),
}));

// MapCanvas is dynamically imported (ssr:false) + depends on MapLibre's
// WebGL canvas, which jsdom can't paint. Stub it to its accessible
// shell (the role/aria-label wrapper the real component renders) so the
// axe pass exercises the surrounding page chrome, not the GL canvas.
jest.mock('@/components/ui/map/MapCanvas', () => ({
    __esModule: true,
    MapCanvas: ({ className }: { className?: string }) => (
        <div
            role="group"
            aria-label="Parcel map"
            tabIndex={0}
            className={className}
        />
    ),
    default: ({ className }: { className?: string }) => (
        <div role="group" aria-label="Parcel map" tabIndex={0} className={className} />
    ),
}));

// ─── SWR data injection ──────────────────────────────────────────────
//
// LocationsClient / InventoryClient / OfflineFieldPanel read through
// `useTenantSWR(path)`. A single mock dispatches per-path fixtures so
// each page mounts with realistic, populated data (empty-state-only
// renders would hide the row chrome the axe pass needs to cover).

const SWR_FIXTURES: Record<string, unknown> = {
    '/locations': [
        { id: 'loc-1', name: 'Home Farm', status: 'ACTIVE', _count: { parcels: 4 } },
        { id: 'loc-2', name: 'River Block', status: 'ACTIVE', _count: { parcels: 2 } },
    ],
    // FLAG 5 — the lot list now fetches the cursor first page (`?limit=50`),
    // which returns the `{ items, pageInfo }` envelope.
    '/inventory/lots?limit=50': {
        items: [
            {
                id: 'lot-1',
                lotCode: 'BATCH-2027-04',
                item: { id: 'i1', name: 'Roundup PowerMAX', category: 'PESTICIDE' },
                unit: { id: 'u1', symbol: 'L' },
                location: { id: 'loc-1', name: 'Home Farm' },
                quantityOnHand: 120,
                expiresAt: '2027-09-01T00:00:00.000Z',
                lowStock: true,
            },
            {
                id: 'lot-2',
                lotCode: 'SEED-CORN-A',
                item: { id: 'i2', name: 'Corn Seed', category: 'SEED' },
                unit: { id: 'u2', symbol: 'kg' },
                location: null,
                quantityOnHand: 800,
                expiresAt: null,
                lowStock: false,
            },
        ],
        pageInfo: { hasNextPage: false },
    },
    '/items': [
        { id: 'i1', name: 'Roundup PowerMAX', category: 'PESTICIDE' },
        { id: 'i2', name: 'Corn Seed', category: 'SEED' },
    ],
    '/units': [
        { id: 'u1', name: 'Litre', symbol: 'L', measure: 'VOLUME' },
        { id: 'u2', name: 'Kilogram', symbol: 'kg', measure: 'MASS' },
    ],
    '/field-operations/op-1': {
        task: { id: 'op-1', key: 'OP-12', title: 'Spray paddock 4', status: 'IN_PROGRESS' },
        lines: [
            {
                id: 'line-1',
                status: 'PENDING',
                doseValue: 2.5,
                parcel: { id: 'p1', name: 'North 40', areaHa: 4.2 },
                product: { id: 'i1', name: 'Roundup PowerMAX' },
                doseUnit: { id: 'u1', symbol: 'L/ha' },
            },
            {
                id: 'line-2',
                status: 'DONE',
                doseValue: 3,
                parcel: { id: 'p2', name: 'South 20', areaHa: 2.1 },
                product: { id: 'i1', name: 'Roundup PowerMAX' },
                doseUnit: { id: 'u1', symbol: 'L/ha' },
            },
        ],
        parcels: [
            { id: 'p1', name: 'North 40', areaHa: 4.2, geometry: null },
            { id: 'p2', name: 'South 20', areaHa: 2.1, geometry: null },
        ],
        location: { id: 'loc-1', name: 'Home Farm', boundsJson: null },
        progress: { total: 2, done: 1 },
    },
};

const mutate = jest.fn(async () => undefined);

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string | null) => {
        if (!path) return { data: undefined, error: undefined, isLoading: false, mutate };
        const data = SWR_FIXTURES[path];
        return { data, error: undefined, isLoading: false, mutate };
    },
    // Hover-prefetch companion — a no-op returning a no-op callback in tests.
    usePrefetchTenant: () => () => {},
}));

// Offline outbox primitive — the field client reads online/pending +
// submit/flush. Stub a connected, empty-outbox state.
jest.mock('@/lib/offline/use-offline-sync', () => ({
    useOfflineSync: () => ({
        online: true,
        pending: 0,
        pendingPhotos: 0,
        submit: jest.fn(async () => 'sent' as const),
        submitPhoto: jest.fn(async () => 'sent' as const),
        flush: jest.fn(async () => ({ ok: 0, failed: 0 })),
        conflicts: [],
        resolveConflict: jest.fn(async () => {}),
    }),
}));

jest.mock('@/lib/offline/field-snapshot', () => ({
    saveFieldSnapshot: jest.fn(),
    readFieldSnapshot: jest.fn(() => null),
    clearFieldSnapshot: jest.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────

import { LocationsClient } from '@/app/t/[tenantSlug]/(app)/locations/LocationsClient';
import { InventoryClient } from '@/app/t/[tenantSlug]/(app)/inventory/InventoryClient';
import { CropPlansClient } from '@/app/t/[tenantSlug]/(app)/planning/CropPlansClient';
import { YieldClient } from '@/app/t/[tenantSlug]/(app)/grain/yield/YieldClient';
import { OfflineFieldPanel } from '@/components/offline/OfflineFieldPanel';

// ─── Harness ─────────────────────────────────────────────────────────

function renderWithProviders(ui: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    // The real app mounts every page inside `AppShell`'s `<main>`
    // landmark. A page-internal `<header>` (ListPageShell.Header /
    // PageHeader) is only a `banner` landmark when it sits at the top
    // level of the document — inside `<main>` it carries no landmark
    // role. Wrapping the fragment in `<main>` here reproduces that real
    // DOM context, so axe's banner-landmark rules evaluate the same way
    // they do in production (rather than flagging the isolated fragment).
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={0}>
                    <main>{ui}</main>
                </TooltipProvider>
            </QueryClientProvider>
        </SWRConfig>,
    );
}

const CROP_PLANS = [
    {
        id: 'cp-1',
        name: 'Spring lettuce succession',
        status: 'ACTIVE',
        successions: 6,
        intervalDays: 14,
        season: { id: 's1', name: 'Spring 2027' },
        cropType: { id: 'ct1', name: 'Lettuce' },
        variety: { id: 'v1', name: 'Little Gem' },
        _count: { plantings: 6 },
    },
    {
        id: 'cp-2',
        name: 'Carrot main crop',
        status: 'DRAFT',
        successions: 2,
        intervalDays: 0,
        season: { id: 's1', name: 'Spring 2027' },
        cropType: { id: 'ct2', name: 'Carrot' },
        variety: null,
        _count: { plantings: 0 },
    },
];

const YIELD_RECORDS = [
    {
        id: 'y-1',
        plantingId: 'p1',
        locationId: 'loc-1',
        seasonId: 's1',
        commodity: 'Winter Wheat',
        harvestedAt: '2027-08-12T00:00:00.000Z',
        grossTonnes: 42.5,
        moisturePct: 13.2,
        areaHa: 8.4,
        tPerHa: 5.06,
        valuationNotes: null,
        planting: { id: 'p1', successionNumber: 1 },
        location: { id: 'loc-1', name: 'Home Farm' },
        season: { id: 's1', name: 'Spring 2027' },
    },
];

// ─── Tests ───────────────────────────────────────────────────────────

describe('Ag pages — WCAG 2.1 AA (jest-axe)', () => {
    it('LocationsClient has no accessibility violations', async () => {
        const { container } = renderWithProviders(
            <LocationsClient tenantSlug="acme" />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('InventoryClient has no accessibility violations', async () => {
        const { container } = renderWithProviders(
            <InventoryClient tenantSlug="acme" />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('CropPlansClient has no accessibility violations', async () => {
        const { container } = renderWithProviders(
            <CropPlansClient
                initialPlans={CROP_PLANS}
                seasons={[]}
                cropTypes={[]}
                varieties={[]}
                locations={[]}
                tenantSlug="acme"
                permissions={{ canWrite: true }}
            />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('YieldClient has no accessibility violations', async () => {
        const { container } = renderWithProviders(
            <YieldClient
                initialRecords={YIELD_RECORDS}
                tenantSlug="acme"
                permissions={{ canWrite: true }}
            />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('OfflineFieldPanel has no accessibility violations', async () => {
        const { container } = renderWithProviders(
            <OfflineFieldPanel taskId="op-1" />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });
});
