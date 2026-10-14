/**
 * The per-treatment ДНЕВНИК is offered on the folded row, and only there
 * (#1740).
 *
 * Three properties, each a decision rather than an implementation detail:
 *
 *   1. A row that stands for a treatment carries the button. A free-hand entry
 *      does NOT — the route answers 404 `TREATMENT_NOT_FOUND` for a treatment
 *      with no lines, so a button there would be a button that fails.
 *   2. It fetches by the row's `treatmentGroupId`. That handle is what the
 *      write returns, what the fold groups on, and what agrent-ios #321 reads
 *      from this same row, so getting it from anywhere else is wrong twice.
 *   3. The filename comes from `Content-Disposition`, preferring RFC 5987's
 *      `filename*` over the ASCII half. #1343 made ten routes carry a
 *      Cyrillic name; a client that reads only `filename=` throws that away
 *      (#1833), and the ONE assertion that can tell those apart is a header
 *      carrying both halves with different values.
 *
 * ## Desktop viewport, deliberately
 *
 * Rendered tests answer `matches: false` to every media query, so the app is
 * a PHONE by default and `<DataTable mobileFallback="card">` renders cards
 * instead of the table this asserts on. Same reason as
 * `journal-folded-row-title.test.tsx`.
 */
import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
        blockNames: ['Блок А'],
    },
};

/** A free-hand entry: `treatment` is PRESENT with parcelCount 0, which is how
 *  the API actually shapes it — the object is never absent. */
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

/**
 * The filename the download was offered under, captured AT CLICK TIME.
 *
 * jsdom implements neither `URL.createObjectURL` nor a real navigation, so
 * both are stubbed — but the `download` attribute is the thing under test,
 * and it lives on an element the code creates and immediately removes, so it
 * cannot be found through the DOM afterwards. `createElement` is wrapped to
 * read the value inside the anchor's own `click`; see the note there for why
 * holding the element instead does not work.
 */
let downloadedAs: string | null = null;
let createdUrls = 0;
let revokedUrls = 0;
const realCreateElement = document.createElement.bind(document);

beforeEach(() => {
    setViewport('desktop');
    downloadedAs = null;
    createdUrls = 0;
    revokedUrls = 0;
    jest.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const el = realCreateElement(tag);
        if (tag === 'a') {
            // Read at CLICK time, not from a held reference.
            //
            // The first version of this file held the most recently created
            // anchor and asserted on it after the promise settled, and read
            // `''` — because React creates its own anchors through
            // `document.createElement` (every `<TableTitleCell>` link is
            // one), so the reference had been overwritten by an element that
            // never had a `download`. The click is the moment the value is
            // live. A real click would also be a navigation jsdom cannot
            // perform and reports as "Not implemented" noise.
            (el as HTMLAnchorElement).click = jest.fn(() => {
                downloadedAs = (el as HTMLAnchorElement).download;
            });
        }
        return el;
    }) as typeof document.createElement);
    Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: () => { createdUrls += 1; return 'blob:stub'; },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: () => { revokedUrls += 1; },
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    restoreViewport();
});

/** A 200 carrying a PDF and whichever disposition the case needs. */
function pdfResponse(disposition: string | null) {
    return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h === 'Content-Disposition' ? disposition : null) },
        blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    };
}

/**
 * A fetch double that answers BY URL.
 *
 * This matters more than it looks: the page's own SWR revalidation of
 * `/journal?limit=50` goes through the same `global.fetch`, so a single
 * blanket mock makes the LIST request the first recorded call and hands it a
 * PDF to parse as JSON. The first version asserted `calls[0][0]` and read
 * `/api/t/acme/journal?limit=50` — a test that would have passed only by
 * accident of ordering.
 */
function fetchDouble(pdf: unknown) {
    return jest.fn((input: unknown) => {
        const url = String(input);
        if (url.includes('/farm-record')) return Promise.resolve(pdf);
        // Everything else REJECTS, which is deliberate and was learned the
        // hard way. The first version answered the page's own
        // `/journal?limit=50` revalidation with an empty page — whereupon
        // SWR's data replaced the seeded fallback, the content signature
        // changed, `reloadPagination([], null)` ran, and the row under test
        // was removed from the DOM. The failure read as "the button is
        // missing" when the row itself had gone.
        //
        // A rejection leaves SWR on its fallback data, which is exactly the
        // state the tests that need no fetch at all already run in — so the
        // list behaves identically across this file.
        return Promise.reject(new Error('only /farm-record is doubled here'));
    });
}

/** The PDF request among the page's other traffic. */
function pdfCallOf(mock: jest.Mock): unknown[] | undefined {
    return mock.mock.calls.find((c) => String(c[0]).includes('/farm-record'));
}

describe('the per-treatment ДНЕВНИК button', () => {
    it('is offered on a folded treatment row', async () => {
        mount([folded]);
        await waitFor(() =>
            expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument(),
        );
        // Named for a screen reader, since the control itself is an icon.
        expect(screen.getByTestId('treatment-pdf-handle-1')).toHaveAttribute(
            'aria-label',
            'Download diary (PDF)',
        );
    });

    it('is NOT offered on a free-hand entry, whose route would 404', async () => {
        mount([freehand]);
        // The row is there…
        await waitFor(() =>
            expect(screen.getByText('Ръчно наблюдение')).toBeInTheDocument(),
        );
        // …and carries no document button. The load-bearing negative: the
        // entry HAS a `treatment` object, so a truthiness test on it rather
        // than on `parcelCount` would have offered the button here.
        expect(screen.queryByTestId('treatment-pdf-entry-manual')).toBeNull();
    });

    it('fetches the document by the row’s own treatmentGroupId', async () => {
        const fetchMock = fetchDouble(pdfResponse('attachment; filename="dnevnik-handle-1.pdf"'));
        global.fetch = fetchMock as unknown as typeof fetch;

        mount([folded]);
        await waitFor(() => expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('treatment-pdf-handle-1'));

        await waitFor(() => expect(pdfCallOf(fetchMock)).toBeDefined());
        expect(pdfCallOf(fetchMock)?.[0]).toBe(
            '/api/t/acme/journal/treatments/handle-1/farm-record',
        );
        // The blob URL is released rather than leaked for the life of the tab.
        await waitFor(() => expect(revokedUrls).toBe(createdUrls));
        expect(createdUrls).toBe(1);
    });

    it('prefers filename* over the ASCII half, so a Cyrillic name survives', async () => {
        // BOTH halves, with DIFFERENT values — the only header that can tell
        // the two implementations apart. `contentDisposition()` emits exactly
        // this shape for a name it cannot put in the quoted form.
        const fetchMock = fetchDouble(
            pdfResponse(
                `attachment; filename="dnevnik-blok-a.pdf"; filename*=UTF-8''${encodeURIComponent('Дневник-Блок А.pdf')}`,
            ),
        );
        global.fetch = fetchMock as unknown as typeof fetch;

        mount([folded]);
        await waitFor(() => expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('treatment-pdf-handle-1'));

        await waitFor(() => expect(downloadedAs).toBeTruthy());
        expect(downloadedAs).toBe('Дневник-Блок А.pdf');
        // And not the transliteration, which is what reading only `filename=`
        // yields and what #1343 did the server-side work to avoid.
        expect(downloadedAs).not.toBe('dnevnik-blok-a.pdf');
    });

    it('falls back to a handle-named file when the header is absent', async () => {
        const fetchMock = fetchDouble(pdfResponse(null));
        global.fetch = fetchMock as unknown as typeof fetch;

        mount([folded]);
        await waitFor(() => expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('treatment-pdf-handle-1'));

        await waitFor(() => expect(downloadedAs).toBeTruthy());
        expect(downloadedAs).toBe('dnevnik-handle-1.pdf');
    });

    it('does not offer a download when the request fails', async () => {
        const fetchMock = fetchDouble({ ok: false, status: 404 });
        global.fetch = fetchMock as unknown as typeof fetch;

        mount([folded]);
        await waitFor(() => expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument());
        fireEvent.click(screen.getByTestId('treatment-pdf-handle-1'));

        await waitFor(() => expect(pdfCallOf(fetchMock)).toBeDefined());
        // No download, no blob URL — a 404 must not hand the farmer a file
        // containing an error body. This is the assertion that fails if the
        // `res.ok` check is dropped.
        expect(createdUrls).toBe(0);
        expect(downloadedAs).toBeNull();
    });
});
