/**
 * «Прочети брошура» — the console half of the leaflet read (#2664).
 *
 * The read route shipped in #2709 with ZERO client callers: built, gated,
 * AV-scanned, tested and in the spec, and unreachable from the UI. This suite
 * covers the three behaviours that are not obvious from the shapes, each of
 * which the route's own docblock argues for.
 *
 * DESKTOP viewport, stated because it decides which branch renders: the jsdom
 * default is a phone, and `<DataTable mobileFallback="card">` swaps the table
 * for cards there. None of these assertions touch the table — they are about
 * the header control, the proposal modal and the form — but the console is a
 * desktop surface and a test should say which one it means.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { restoreViewport, setViewport } from './viewport';

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
    };
});

jest.mock('next-intl', () => {
    const makeT = () => {
        // Returns the KEY, so these assertions are locale-independent — they
        // pin behaviour, not Bulgarian copy, which the i18n guards own.
        const t = (key: string, opts?: Record<string, unknown>) =>
            opts && 'count' in opts ? `${key}:${opts.count}` : key;
        t.has = () => false;
        t.rich = (k: string) => k;
        t.markup = (k: string) => k;
        t.raw = (k: string) => k;
        return t;
    };
    return {
        useLocale: () => 'en',
        useTranslations: () => makeT(),
        useFormatter: () => ({
            number: (v: unknown) => String(v),
            dateTime: (v: unknown) => String(v),
            relativeTime: (v: unknown) => String(v),
        }),
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/promotions',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string) => ({
        data: path.includes('companies') ? { companies: [] } : { promotions: [] },
        isLoading: false,
        isError: false,
        mutate: jest.fn(),
    }),
}));

import { PromotionsAdminClient } from '@/app/t/[tenantSlug]/(app)/admin/promotions/PromotionsAdminClient';

const SCAN_OK = {
    fileId: 'file-1',
    companyName: 'Агрия',
    offers: [
        { productName: 'Карате Зеон', priceText: 'от 1 200 лв./т', validityText: 'до 30.11', note: null },
        { productName: 'Амониев нитрат', priceText: '-15%', validityText: null, note: 'до изчерпване' },
    ],
    unreadableOfferCount: 2,
};

function renderConsole() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <PromotionsAdminClient tenantSlug="acme" />
        </SWRConfig>,
    );
}

/**
 * ASSIGN `fetch`, do not spy on it: this jsdom config has no global fetch, so
 * `jest.spyOn(global, 'fetch')` fails with "Property `fetch` does not exist in
 * the provided object" BEFORE any assertion runs — three tests failing in 2ms
 * each, which reads like the component breaking rather than the harness.
 */
function stubFetch(response: { ok: boolean; body: unknown }) {
    (global as unknown as { fetch: unknown }).fetch = jest
        .fn()
        .mockResolvedValue({ ok: response.ok, json: async () => response.body } as Response);
}

/** Drive the hidden input the way the operator's file picker does. */
function pickLeaflet() {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File(['%PDF-1.4'], 'leaflet.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
}

describe('«Прочети брошура» in the promotions console (#2664)', () => {
    beforeEach(() => setViewport('desktop'));
    const realFetch = (global as unknown as { fetch?: unknown }).fetch;
    afterEach(() => {
        restoreViewport();
        jest.restoreAllMocks();
        (global as unknown as { fetch?: unknown }).fetch = realFetch;
    });

    it('offers the control at all — the route had no caller before this', () => {
        renderConsole();
        expect(screen.getByText('leafletRead')).toBeInTheDocument();
        expect(document.querySelector('input[type="file"]')).toBeTruthy();
    });

    it('SURFACES the offers it could not read, rather than swallowing them', async () => {
        // The route's docblock: a six-offer leaflet read as four is otherwise
        // indistinguishable from a four-offer leaflet, and the operator is the
        // only one who can open the file and check. So the count must reach
        // the screen — this is the assertion that makes that true.
        stubFetch({ ok: true, body: SCAN_OK });
        renderConsole();
        pickLeaflet();
        expect(await screen.findByText('leafletUnreadable:2')).toBeInTheDocument();
    });

    it('accepting an offer fills the form and leaves ПРЗ EMPTY', async () => {
        // THE COMPLIANCE ASSERTION. `promotion-leaflet-reader` has no
        // `pppRegistrationNo` slot at all — held by
        // `promotion-read-proposes-no-ppp-number` — because a misread
        // registration number would silently reclassify a pesticide as a
        // fertiliser. The console must not reintroduce it by prefilling
        // anything: the reviewer types it, against the register, looking at the
        // leaflet.
        stubFetch({ ok: true, body: SCAN_OK });
        renderConsole();
        pickLeaflet();
        // By ID, not by text: the fixture has TWO offers, so two Accept
        // buttons, and `findByText` refused with "Found multiple elements".
        // Which is the fixture being right — one offer could not catch a
        // positional mix-up between the row clicked and the row applied.
        await waitFor(() => expect(document.querySelector('#accept-offer-0')).toBeTruthy());
        fireEvent.click(document.querySelector('#accept-offer-0') as HTMLElement);

        await waitFor(() => {
            expect((document.querySelector('#promo-title') as HTMLInputElement)?.value).toBe('Карате Зеон');
        });
        const ppp = document.querySelector('#promo-ppp-no') as HTMLInputElement;
        expect(ppp).toBeTruthy();
        expect(ppp.value).toBe('');
    });

    it('shows the SERVER’s refusal, which distinguishes stored-but-unreadable from try-later', async () => {
        // A 415 means the file IS stored and the offers must be typed in; a 503
        // means try later. One local string would collapse them, so the web
        // prints the server's sentence — the same choice `PromotionImageField`
        // makes three components away.
        stubFetch({
            ok: false,
            body: {
                code: 'LEAFLET_MEDIA_UNSUPPORTED',
                error: 'The file is stored, but only a PDF or a photo can be read automatically.',
            },
        });
        renderConsole();
        pickLeaflet();
        expect(
            await screen.findByText(/The file is stored, but only a PDF or a photo/),
        ).toBeInTheDocument();
    });
});
