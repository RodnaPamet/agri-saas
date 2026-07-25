/**
 * Farm-risk parcel card — honesty of the satellite copy.
 *
 * The card's LOADING line is gated on `geeConfigured`, not just on
 * `isLoading`:
 *
 *     {riskQ.isLoading && !risk
 *         ? geeConfigured ? t('analyzing') : t('loading')
 *         : …}
 *
 * On a deployment with no Earth-Engine credentials nothing is analysed —
 * the request never touches a satellite pass — so claiming "Analysing
 * satellite imagery…" is a lie. That is the regression this file locks:
 * flip the gate off and test #1 fails.
 *
 * Same harness also covers the three cheap payload assertions:
 *   • NDVI/NDMI readings render beside the level badges;
 *   • `acquiredDate` renders through `ag.risk.asOf` ("Satellite pass: …"),
 *     the honest imagery-date label that replaced the dead `risk.summary`
 *     branch — a payload carrying a stray `summary` string must NOT put
 *     that string in the DOM;
 *   • `configured: false` renders `ag.risk.unavailable`.
 *
 * Copy comes from the REAL `messages/en.json` — the jsdom project's
 * `tests/rendered/setup.ts` next-intl mock resolves keys through the
 * English catalogue, so these assertions are byte-identical to
 * production output.
 */

import { render, screen } from '@testing-library/react';

// ─── next/navigation: stable router + params (Modal/Breadcrumbs read them) ─
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/farm-risk',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

// ─── tenant API url helper (AskInsuranceModal builds its POST url) ────────
jest.mock('@/lib/tenant-context-provider', () => {
    // Hoisted builders so the identities stay stable across renders (the
    // real hooks are useCallback-memoized per tenant).
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

// ─── tenant SWR — one URL-switching mock drives BOTH endpoints ────────────
//
// `/locations/<id>/parcels` (the list) is always resolved; the per-parcel
// `/agro/parcel-analysis?parcelId=<id>` state is swapped per test via the
// module-scope `riskState` box, which the hook body reads at RENDER time.

interface SwrState {
    data: unknown;
    isLoading: boolean;
}

const PARCELS = {
    parcels: [{ id: 'p1', name: 'North 40', areaHa: 4.2, cropType: 'Wheat' }],
};

const riskState: SwrState = { data: undefined, isLoading: true };
const mutate = jest.fn(async () => undefined);

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string | null) => {
        if (path === '/locations/loc-1/parcels') {
            return { data: PARCELS, error: undefined, isLoading: false, mutate };
        }
        if (path && path.startsWith('/agro/parcel-analysis')) {
            return {
                data: riskState.data,
                error: undefined,
                isLoading: riskState.isLoading,
                mutate,
            };
        }
        return { data: undefined, error: undefined, isLoading: false, mutate };
    },
    usePrefetchTenant: () => () => {},
}));

// ─── Import after mocks ──────────────────────────────────────────────────

import { FarmRiskClient } from '@/app/t/[tenantSlug]/(app)/farm-risk/FarmRiskClient';

const LOCATIONS = [{ id: 'loc-1', name: 'Home Farm' }];

/**
 * A landed `ParcelRisk` payload. `extra` exists so a test can smuggle a
 * field the DTO does NOT declare (e.g. a stray `summary`) and assert the
 * component has no rendering path for it.
 */
function makeRisk(extra: Record<string, unknown> = {}) {
    return {
        parcelId: 'p1',
        name: 'North 40',
        areaHa: 4.2,
        cropType: 'Wheat',
        configured: true,
        ndvi: 0.72,
        ndmi: 0.31,
        vegetation: 'good',
        moisture: 'stress',
        overall: 'watch',
        acquiredDate: '2026-07-18',
        ...extra,
    };
}

function setRisk(state: SwrState) {
    riskState.data = state.data;
    riskState.isLoading = state.isLoading;
}

function renderClient(geeConfigured: boolean) {
    return render(
        <FarmRiskClient
            tenantSlug="acme"
            locations={LOCATIONS}
            geeConfigured={geeConfigured}
        />,
    );
}

beforeEach(() => {
    mutate.mockClear();
    setRisk({ data: undefined, isLoading: true });
});

describe('FarmRiskClient — loading copy is gated on geeConfigured', () => {
    it('says only "Loading…" — never the imagery claim — when Earth Engine is NOT configured', () => {
        renderClient(false);

        expect(screen.getByText('Loading…')).toBeInTheDocument();
        // The regression: without credentials no imagery is analysed, so
        // the analysis claim must not appear.
        expect(
            screen.queryByText('Analysing satellite imagery…'),
        ).not.toBeInTheDocument();
    });

    it('says "Analysing satellite imagery…" when Earth Engine IS configured', () => {
        renderClient(true);

        expect(
            screen.getByText('Analysing satellite imagery…'),
        ).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    it('drops the loading line entirely once the payload lands, even mid-revalidation', () => {
        // `isLoading && !risk` — a revalidation with data already in hand
        // shows the readings, not a loading line.
        setRisk({ data: makeRisk(), isLoading: true });
        renderClient(true);

        expect(
            screen.queryByText('Analysing satellite imagery…'),
        ).not.toBeInTheDocument();
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
        expect(screen.getByText('NDVI 0.72')).toBeInTheDocument();
    });
});

describe('FarmRiskClient — landed risk payload', () => {
    it('renders the NDVI/NDMI readings alongside the level badges', () => {
        setRisk({ data: makeRisk(), isLoading: false });
        renderClient(true);

        // Raw indices, tabular-nums spans.
        expect(screen.getByText('NDVI 0.72')).toBeInTheDocument();
        expect(screen.getByText('NDMI 0.31')).toBeInTheDocument();

        // …beside the level badges: overall `watch`, vegetation `good`,
        // moisture `stress` → three distinct English labels.
        expect(screen.getByText('Watch')).toBeInTheDocument();
        expect(screen.getByText('Healthy')).toBeInTheDocument();
        expect(screen.getByText('Stress')).toBeInTheDocument();

        // Section captions the badges sit under.
        expect(screen.getByText('Vegetation')).toBeInTheDocument();
        expect(screen.getByText('Moisture')).toBeInTheDocument();

        // The InfoTooltip help triggers render (popup content does NOT —
        // TOOLTIPS_ENABLED is off — but the accessible label is wired).
        expect(
            screen.getByRole('button', { name: 'About the NDVI reading' }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: 'About the NDMI reading' }),
        ).toBeInTheDocument();
    });

    it('renders the honest "Satellite pass: {date}" line from acquiredDate', () => {
        setRisk({ data: makeRisk({ acquiredDate: '2026-07-18' }), isLoading: false });
        renderClient(true);

        expect(screen.getByText('Satellite pass: 2026-07-18')).toBeInTheDocument();
    });

    it('omits the satellite-pass line when acquiredDate is null', () => {
        setRisk({ data: makeRisk({ acquiredDate: null }), isLoading: false });
        renderClient(true);

        expect(screen.queryByText(/Satellite pass:/)).not.toBeInTheDocument();
    });

    it('has NO summary rendering path — a stray DTO `summary` never reaches the DOM', () => {
        const STRAY = 'Canopy is thinning after the dry spell.';
        setRisk({ data: makeRisk({ summary: STRAY }), isLoading: false });
        renderClient(true);

        expect(screen.queryByText(STRAY)).not.toBeInTheDocument();
        // The date line is what replaced that dead branch.
        expect(screen.getByText('Satellite pass: 2026-07-18')).toBeInTheDocument();
    });

    it('renders the unavailable copy when risk.configured is false', () => {
        setRisk({ data: makeRisk({ configured: false }), isLoading: false });
        renderClient(true);

        expect(
            screen.getByText(
                'Satellite analysis is unavailable — verify in the field.',
            ),
        ).toBeInTheDocument();
    });

    it('renders the unavailable copy when the request settles with no payload', () => {
        setRisk({ data: undefined, isLoading: false });
        renderClient(true);

        expect(
            screen.getByText(
                'Satellite analysis is unavailable — verify in the field.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });
});
