/**
 * A folded ДНЕВНИК row is titled by its PRODUCT, not by one of its parcels
 * (#1740).
 *
 * The folded row IS the treatment group's representative entry, and an
 * `INPUT_APPLICATION` title is `journal.autoTitle.inputApplication` —
 * `'{product} — {parcel}'`, written per line. So a treatment over three
 * parcels rendered as «Препарат — Парцел 1»: one parcel's record, with
 * nothing on the row saying it covered the other two. Found by agrent-ios,
 * which titles its own rows by the product and shows the counts beneath, so
 * only the web was exposed.
 *
 * ## Why the fix is here and not in the fold
 *
 * The row is documented as an honest copy of a real entry — its `id` opens
 * that entry — so overriding `title` server-side would make the list disagree
 * with the detail page you reach by tapping it. And composing
 * "3 парцела · 20 дка" on the server would be server-authored Bulgarian copy,
 * which `no-server-authored-user-copy` ratchets down and which the message
 * catalogues exist to hold.
 *
 * ## Desktop viewport, deliberately
 *
 * Rendered tests answer `matches: false` to every media query, so the app is
 * a PHONE by default and `<DataTable mobileFallback="card">` renders cards.
 * This asserts the TABLE cell, so it sets the viewport rather than inheriting
 * it — the 2026-07-30 audit found three suites green about a branch they had
 * never executed.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/journal',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme Farms', tenantSlug: 'acme', currencySymbol: '€' }),
}));

import { JournalClient } from '@/app/t/[tenantSlug]/(app)/journal/JournalClient';
import { TooltipProvider } from '@/components/ui/tooltip';

const PERMS = { canWrite: true, canAdmin: false } as never;

/** A treatment over three parcels, whose entry title names only one. */
const folded = {
    id: 'entry-folded',
    type: 'INPUT_APPLICATION',
    title: 'Тестов препарат — Парцел 1',
    status: 'DONE',
    occurredAt: '2026-03-09T00:00:00.000Z',
    treatment: {
        treatmentGroupId: 'handle-1',
        productName: 'Тестов препарат',
        parcelCount: 3,
        totalAreaHa: 2,
        blockNames: ['Блок А', 'Блок Б'],
    },
};

/** A free-hand entry: folds to itself, so its own title stands. */
const freehand = {
    id: 'entry-manual',
    type: 'OBSERVATION',
    title: 'Ръчно наблюдение',
    status: 'DONE',
    occurredAt: '2026-03-07T00:00:00.000Z',
    treatment: {
        treatmentGroupId: 'entry-manual',
        productName: null,
        parcelCount: 0,
        totalAreaHa: 0,
        blockNames: [],
    },
};

function mount(entries: unknown[]) {
    return render(
        <TooltipProvider>
            <JournalClient
                initialEntries={entries as never}
                initialNextCursor={null}
                initialFilters={{} as never}
                tenantSlug="acme"
                permissions={PERMS}
                grainEnabled={false}
            />
        </TooltipProvider>,
    );
}

beforeEach(() => setViewport('desktop'));
afterEach(() => restoreViewport());

describe('a folded ДНЕВНИК row', () => {
    // Assertions RE-QUERY inside `waitFor` rather than holding a node.
    // `DataTable`'s `useMediaQuery` starts at `device = null` and resolves on
    // the mount effect, so the first paint's DOM is replaced — a reference
    // found with `findByText` is detached by the time it is asserted on, and
    // the failure reads as "element could not be found" rather than as a
    // re-render.
    //
    // The harness formats `messages/en.json` through ICU (see
    // `tests/rendered/setup.ts`), so these are the ENGLISH strings; the
    // Bulgarian ones are held by key parity and the untranslated check.

    it('is titled by the product, not by one of its parcels', async () => {
        mount([folded]);

        await waitFor(() => expect(screen.getByText('Тестов препарат')).toBeInTheDocument());
        // The load-bearing negative: the per-line title named Парцел 1, and a
        // treatment over three parcels must not read as that parcel's record.
        expect(screen.queryByText('Тестов препарат — Парцел 1')).not.toBeInTheDocument();
    });

    it('says how many parcels and how much area it stands for', async () => {
        mount([folded]);

        // 2 ha on the wire, decares on the screen — the conversion belongs
        // where the number is displayed. 3 parcels takes the plural form,
        // which is why the count goes through ICU rather than a bare number.
        await waitFor(() => expect(screen.getByText(/20 daa/)).toBeInTheDocument());
        const summary = screen.getByText(/20 daa/);
        expect(summary.textContent).toMatch(/3 parcels/);
        expect(summary.textContent).toMatch(/Блок А, Блок Б/);
    });

    it('leaves a free-hand entry titled by its own title', async () => {
        mount([freehand]);

        await waitFor(() => expect(screen.getByText('Ръчно наблюдение')).toBeInTheDocument());
        // And carries no treatment summary, because there is no treatment.
        expect(screen.queryByText(/parcels/)).not.toBeInTheDocument();
        expect(screen.queryByText(/daa/)).not.toBeInTheDocument();
    });
});
