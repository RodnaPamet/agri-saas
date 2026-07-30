/**
 * The jsdom viewport mechanism, executed rather than asserted-about.
 *
 * `tests/rendered/setup.ts` stubs `matchMedia` to answer
 * `matches: false` for EVERY query, and `useMediaQuery` derives its
 * device from two `min-width` probes — so the default rendered-suite
 * viewport is a PHONE. Every `<DataTable mobileFallback="card">` in the
 * app therefore renders CARDS by default, and the desktop `<table>`
 * branch is unreachable unless a test says otherwise.
 *
 * That coupling is load-bearing and invisible: it lives in the
 * interaction between a setup-file polyfill and a hook's breakpoint
 * list, in two different directories. A guard that greps either file
 * would prove the text is present without proving the mechanism works.
 * So this suite RUNS it:
 *
 *   1. the default (untouched) stub resolves to `isMobile`;
 *   2. `setViewport('desktop')` resolves to `isDesktop`;
 *   3. `setViewport('tablet')` resolves to `isTablet` — the middle band
 *      exists in `useMediaQuery` and is easy to break by answering
 *      `min-width` probes with a single boolean;
 *   4. `restoreViewport()` puts the phone default back, so a suite that
 *      pins one test to a desktop cannot leak it into the next;
 *   5. the branch that actually matters — `<DataTable
 *      mobileFallback="card">` renders `<MobileCardList>` on the
 *      default viewport and a real `<table>` on a desktop.
 *
 * If a future change adds a breakpoint to `useMediaQuery`, or renames
 * the probe, (2)/(3) fail here rather than silently reverting every
 * `setViewport('desktop')` call site in the suite to a phone.
 */
import { render, screen } from '@testing-library/react';

import { useMediaQuery } from '@/components/ui/hooks';
import { DataTable, createColumns } from '@/components/ui/table';

import {
    DEFAULT_VIEWPORT,
    restoreViewport,
    setViewport,
} from './viewport';

afterEach(restoreViewport);

// ─── Device probe ────────────────────────────────────────────────────

function DeviceProbe() {
    const { device, isMobile, isTablet, isDesktop, width } = useMediaQuery();
    return (
        <output>
            {`device=${device} mobile=${isMobile} tablet=${isTablet} desktop=${isDesktop} width=${width}`}
        </output>
    );
}

const readProbe = () => screen.getByRole('status').textContent;

describe('rendered-suite viewport helper', () => {
    it('resolves to a PHONE when no test touches the stub', () => {
        // The documented default. `setup.ts` answers `matches: false` to
        // both `min-width` probes, and `useMediaQuery` falls through to
        // 'mobile'. This is the branch the app ships to the people who
        // use it most, so it is the right default — but it must be a
        // KNOWN default, not a surprise.
        render(<DeviceProbe />);
        expect(readProbe()).toContain('device=mobile');
        expect(readProbe()).toContain('mobile=true');
        expect(DEFAULT_VIEWPORT).toBe('mobile');
    });

    it('resolves to a DESKTOP after setViewport("desktop")', () => {
        // Break: answering every `min-width` query with one boolean, or
        // dropping the 1024px band, silently reverts every
        // `setViewport('desktop')` call site in the suite to a phone.
        setViewport('desktop');
        render(<DeviceProbe />);
        expect(readProbe()).toContain('device=desktop');
        expect(readProbe()).toContain('desktop=true');
        expect(readProbe()).toContain('mobile=false');
    });

    it('resolves to a TABLET after setViewport("tablet")', () => {
        // The middle band: `min-width: 640px` matches, `1024px` does not.
        // A stub that answers a flat `true` would report a desktop here.
        setViewport('tablet');
        render(<DeviceProbe />);
        expect(readProbe()).toContain('device=tablet');
        expect(readProbe()).toContain('tablet=true');
        expect(readProbe()).toContain('desktop=false');
    });

    it('keeps window.innerWidth consistent with the media query', () => {
        // A component may read `innerWidth` instead of a media query; the
        // two must not disagree.
        setViewport('desktop');
        render(<DeviceProbe />);
        expect(readProbe()).toContain('width=1280');
    });

    it('restoreViewport() puts the phone default back', () => {
        // Break: a suite that sets a desktop without restoring leaks it
        // into every later test in the same file, which is exactly the
        // class of silent branch-swap this module exists to prevent.
        setViewport('desktop');
        restoreViewport();
        render(<DeviceProbe />);
        expect(readProbe()).toContain('device=mobile');
    });
});

// ─── The branch this actually protects ───────────────────────────────

interface Row {
    id: string;
    name: string;
    hidden: string;
}

const DATA: Row[] = [{ id: 'r1', name: 'North 40', hidden: 'not-in-card' }];

const columns = createColumns<Row>([
    {
        accessorKey: 'name',
        header: 'Field',
        cell: ({ row }) => <span>{row.original.name}</span>,
        meta: { mobileCard: { slot: 'title' } },
    },
    {
        // No `mobileCard` meta ⇒ MobileCardList omits the column entirely.
        accessorKey: 'hidden',
        header: 'Ledger ref',
        cell: ({ row }) => <span>{row.original.hidden}</span>,
    },
]);

describe('DataTable mobileFallback="card" — which branch the viewport selects', () => {
    const mount = () =>
        render(
            <DataTable<Row>
                data={DATA}
                columns={columns}
                getRowId={(r) => r.id}
                selectionEnabled={false}
                mobileFallback="card"
            />,
        );

    it('renders CARDS (no <table>, untagged columns dropped) on the default viewport', () => {
        mount();
        expect(document.querySelector('table')).toBeNull();
        expect(document.getElementById('mobile-card-list')).not.toBeNull();
        expect(screen.getByText('North 40')).toBeInTheDocument();
        // The column without `meta.mobileCard` is absent from the card —
        // this is why a table-era assertion cannot simply be assumed to
        // carry over to the phone branch.
        expect(screen.queryByText('not-in-card')).not.toBeInTheDocument();
        expect(screen.queryByText('Ledger ref')).not.toBeInTheDocument();
    });

    it('renders the TABLE (all columns, real column headers) on a desktop', () => {
        setViewport('desktop');
        mount();
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(document.getElementById('mobile-card-list')).toBeNull();
        expect(screen.getByRole('columnheader', { name: 'Ledger ref' })).toBeInTheDocument();
        expect(screen.getByText('not-in-card')).toBeInTheDocument();
    });
});
