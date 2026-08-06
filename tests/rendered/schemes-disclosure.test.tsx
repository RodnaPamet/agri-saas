/**
 * The scheme list discloses that its catalogues are demo subsets, and its rows
 * go somewhere.
 *
 * There was NO rendered coverage on this surface at all — which is exactly why
 * both defects shipped. A list whose rows carry `hover:bg-bg-muted` and no
 * `onRowClick` looks correct in every static read of the file; only mounting
 * it and clicking shows the dead end. And a `description` field that is
 * fetched and never rendered is invisible to a reader of the query and to a
 * reader of the JSX alike — you have to look at the output.
 *
 * The catalogues are 3-8% stubs. GlobalG.A.P. carries 7 control points against
 * ~200+; EU Organic 5 against a 61-article regulation. A farmer who maps their
 * practices to 7 control points and sees "GlobalG.A.P." will believe they are
 * covered, and the only in-UI signal was a parenthetical in the name.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { SchemesClient, type SchemeRow } from
    '@/app/t/[tenantSlug]/(app)/schemes/SchemesClient';
import { setViewport, restoreViewport } from './viewport';
import { TenantProvider } from '@/lib/tenant-context-provider';

const push = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/t/acme/schemes',
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (_key: string, opts: { fallbackData?: unknown }) => ({
        data: opts?.fallbackData,
        isLoading: false,
        isValidating: false,
        error: undefined,
        mutate: jest.fn(),
    }),
}));

const DEMO: SchemeRow = {
    id: 'fw-1',
    key: 'GLOBALGAP-IFA-DEMO',
    name: 'GlobalG.A.P. IFA (illustrative demo)',
    description: 'Illustrative concept-only subset.',
    isDemo: true,
    coverageNote: '7 of ~200+ control points',
    _count: { requirements: 7, packs: 1 },
};

const FULL: SchemeRow = {
    id: 'fw-2',
    key: 'REAL-STANDARD',
    name: 'A complete standard',
    description: null,
    isDemo: false,
    coverageNote: null,
    _count: { requirements: 200, packs: 1 },
};

// The desktop <table> branch is the subject. Under the project-wide jsdom stub
// the app is a PHONE and DataTable renders cards instead, so a test that
// forgot this would assert against a branch it never executed.
beforeEach(() => {
    jest.clearAllMocks();
    setViewport('desktop');
});
afterEach(restoreViewport);

function renderList(schemes: SchemeRow[]) {
    return render(
        <SchemesClient
            initialSchemes={schemes}
            tenantSlug="acme"
            permissions={{ canAuthorScheme: false }}
        />,
    );
}

describe('demo disclosure', () => {
    it('badges a demo catalogue', () => {
        renderList([DEMO]);
        expect(screen.getByText('Demo subset')).toBeInTheDocument();
    });

    it('says HOW partial it is, not just that it is', () => {
        // "Demo" alone does not tell a farmer whether they are looking at 7
        // control points or 190.
        renderList([DEMO]);
        expect(screen.getByText('7 of ~200+ control points')).toBeInTheDocument();
    });

    it('does not badge a complete standard', () => {
        renderList([FULL]);
        expect(screen.queryByText('Demo subset')).not.toBeInTheDocument();
    });

    it('badges only the demo row when both are listed', () => {
        renderList([DEMO, FULL]);
        expect(screen.getAllByText('Demo subset')).toHaveLength(1);
    });
});

describe('rows are not a dead end', () => {
    it('clicking a row opens that scheme', () => {
        // The row style promised a click for as long as the page existed and
        // there was nothing to click through to — no onRowClick, and no
        // [schemeKey] route behind it.
        renderList([DEMO]);
        // eslint-disable-next-line no-console -- one-off DOM probe
        // A SINGLE click. DataTable defaults selection on, which makes the
        // first click toggle selection and moves the row action to
        // double-click — on a list with no batch actions that is a click spent
        // for nothing, under a row that renders `cursor-pointer`.
        fireEvent.click(screen.getByText('GlobalG.A.P. IFA (illustrative demo)'));
        expect(push).toHaveBeenCalledWith('/t/acme/schemes/GLOBALGAP-IFA-DEMO');
    });

    it('navigates by KEY, not by id', () => {
        // The detail route is keyed by scheme key; pushing the row's cuid
        // would 404 on a page that otherwise looks wired.
        renderList([FULL]);
        fireEvent.click(screen.getByText('A complete standard'));
        expect(push).toHaveBeenCalledWith('/t/acme/schemes/REAL-STANDARD');
        expect(push).not.toHaveBeenCalledWith(expect.stringContaining('fw-2'));
    });
});

describe('the authoring affordance follows the platform gate', () => {
    it('is absent for an ordinary farm', () => {
        // Authoring writes the GLOBAL catalogue, so the API refuses it outside
        // the platform tenant. A button whose submit 404s is its own defect.
        renderList([DEMO]);
        expect(screen.queryByRole('button', { name: /scheme/i })).not.toBeInTheDocument();
    });

    it('is present for the platform tenant', () => {
        // The authoring modal reaches for TenantContext, so this branch needs
        // the provider the app shell supplies. Wrapping only here keeps the
        // ordinary-farm cases (the common path) mounting exactly as the page
        // does for a farm.
        render(
            <TenantProvider value={{ slug: 'platform-support', isPlatformTenant: true } as never}>
                <SchemesClient
                    initialSchemes={[DEMO]}
                    tenantSlug="platform-support"
                    permissions={{ canAuthorScheme: true }}
                />
            </TenantProvider>,
        );
        expect(document.getElementById('new-scheme-btn')).toBeInTheDocument();
    });
});
