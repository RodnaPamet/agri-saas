/**
 * The Google Drive export is offered only where it can succeed, and each
 * refusal says something different (#2019).
 *
 * ## The gate is mirrored, so the control is ABSENT rather than refusing
 *
 * The route needs BOTH halves: `canAdmin` (the owner's ruling, 2026-10-26 —
 * admin only, matching the credential the export resolves) and the
 * `integrations.google` runtime flag, which is default-OFF. Each half alone
 * produces a button that fails: the flag alone offers a 403 to every writer,
 * admin alone offers a 404 to every tenant without the integration, which is
 * most of them.
 *
 * So three of these cases assert an ABSENCE, and they are the point. The same
 * rule the journal row's own `mayDelete` follows: an offered control that
 * refuses is worse than one that is not there.
 *
 * ## The refusal copy is the SERVER's, and these cases pin that
 *
 * The owner's #1677 ruling: the server resolves the locale and sends
 * `message` already translated, so neither client keeps a code catalogue.
 * `localizeErrorPayload` runs on every coded error in `withApiErrorHandling`.
 *
 * So what is worth asserting here is PASS-THROUGH, not a mapping: whatever
 * sentence the server sends is what the farmer reads, two different sentences
 * stay two, and the ONE local string is the fallback for when there was no
 * response to carry a message. The first version of this file asserted a
 * local code→copy map, which was a second catalogue; the cases below are what
 * remained once that was deleted.
 *
 * The success and label strings ARE asserted as copy, against the real
 * English catalogue `tests/rendered/setup.ts` loads — so a missing key fails
 * here rather than rendering blank in production.
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

/** Flipped per test — it is the flag half of the gate. */
let flagOn = true;

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantName: 'Acme Farms',
        tenantSlug: 'acme',
        currencySymbol: '€',
        googleIntegrationEnabled: flagOn,
    }),
}));

const toasts: Array<{ kind: 'error' | 'success'; message: string }> = [];

/**
 * ONE object, returned by every `useToast()` call.
 *
 * `toast` sits in the dependency array of the row callbacks, which feed the
 * columns `useMemo`, so a factory returning a fresh object per call would give
 * it a new identity on every render. Stable by construction rather than by
 * luck.
 *
 * Worth recording what this did NOT cause, because I blamed it for a while:
 * the whole file failed with the row's text present and every
 * `findByTestId` timing out, and an unmocked-toast control rendered fine — so
 * the mock looked guilty. It was not. The cause was the 1 s default timeout on
 * `findByTestId`, which this list exceeds on a loaded machine; the control
 * happened to wait for the row text first, which is what made it pass. See
 * `mountWithRow`.
 */
const toastApi = {
    error: (m: string) => toasts.push({ kind: 'error' as const, message: m }),
    success: (m: string) => toasts.push({ kind: 'success' as const, message: m }),
    info: (m: string) => toasts.push({ kind: 'success' as const, message: m }),
    warning: (m: string) => toasts.push({ kind: 'error' as const, message: m }),
};
jest.mock('@/components/ui/hooks/use-toast', () => ({
    __esModule: true,
    useToast: () => toastApi,
}));

import { JournalClient } from '@/app/t/[tenantSlug]/(app)/journal/JournalClient';
import { TooltipProvider } from '@/components/ui/tooltip';

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

/** A free-hand entry: `treatment` is present with parcelCount 0. */
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

/**
 * Mount, then WAIT FOR THE ROW before any assertion about a button.
 *
 * `findByTestId` defaults to a 1 s timeout and this list takes longer than
 * that to paint under load — measured at ~1.4 s here, and the whole file
 * failed that way while each case passed when run alone. Waiting for the row's
 * own text first is both the fix and the honest assertion order: "is the
 * button on the row" presupposes the row.
 *
 * It also separates two failures that otherwise look identical — a row that
 * never rendered, and a row that rendered without the button. Only the second
 * is about the gate.
 */
async function mountWithRow(entries: unknown[], canAdmin: boolean, rowText: RegExp) {
    const r = mount(entries, canAdmin);
    await waitFor(() => expect(screen.getByText(rowText)).toBeInTheDocument());
    return r;
}

function mount(entries: unknown[], canAdmin: boolean) {
    return render(
        <TooltipProvider>
            <JournalClient
                initialEntries={entries as never}
                initialNextCursor={null}
                initialFilters={{} as never}
                tenantSlug="acme"
                permissions={{ canWrite: true, canAdmin } as never}
                grainEnabled={false}
            />
        </TooltipProvider>,
    );
}

/**
 * A fetch double that answers the export URL and REJECTS everything else.
 *
 * The rejection is load-bearing, and the sibling
 * `journal-treatment-pdf-action.test.tsx` paid for the lesson: the page's own
 * SWR revalidation of `/journal?limit=50` goes through this same
 * `global.fetch`, and answering it with an empty page makes SWR replace the
 * seeded fallback, change the content signature, run
 * `reloadPagination([], null)` — and REMOVE the row under test from the DOM.
 * The failure then reads as "the button is missing" when the row itself has
 * gone. I wrote that empty page first and got exactly that.
 *
 * A rejection leaves SWR on its fallback data, which is the state the
 * no-fetch cases already run in, so the list behaves identically across the
 * file.
 */
function fetchDouble(driveAnswer: unknown) {
    // `init` is declared even though the double ignores it: the POST case
    // asserts on it, and a one-parameter mock has no element at index 1 in its
    // recorded-call tuple type.
    return jest.fn((input: unknown, init?: unknown) => {
        void init;
        if (String(input).includes('/farm-record/drive')) return Promise.resolve(driveAnswer);
        return Promise.reject(new Error('only /farm-record/drive is doubled here'));
    });
}

/**
 * The export answered with a refusal the SERVER has already localised.
 *
 * `message` is what the client shows; `code` rides along because the envelope
 * carries it and the client must ignore it.
 */
function refusal(status: number, opts?: { code?: string; message?: string }) {
    return {
        ok: false,
        status,
        json: async () =>
            opts ? { code: opts.code ?? 'SOMETHING', message: opts.message } : null,
    } as unknown as Response;
}

/** The export answered successfully. */
const EXPORTED = {
    ok: true,
    status: 200,
    json: async () => ({
        fileId: 'f1',
        fileName: 'dnevnik-handle-1-2026-10-27.pdf',
        webViewLink: 'https://drive/f1',
        folderCreated: true,
    }),
} as unknown as Response;

beforeEach(() => {
    setViewport('desktop');
    flagOn = true;
    toasts.length = 0;
    // Even the presence cases need this: without a double the page's own list
    // revalidation reaches the real fetch, and what it answers decides whether
    // the row survives to carry a button.
    global.fetch = fetchDouble(EXPORTED) as unknown as typeof fetch;
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterEach(() => {
    restoreViewport();
});

describe('the Drive export button is offered only where it can work (#2019)', () => {
    it('is offered to an admin when the integration flag is on', async () => {
        await mountWithRow([folded], true, /Тестов препарат/);
        expect(screen.getByTestId('treatment-drive-handle-1')).toBeInTheDocument();
        // The download sits beside it and is offered to everyone.
        expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument();
    });

    it('is ABSENT when the flag is off, even for an admin', async () => {
        // The flag is default-OFF, so this is the common case. The route would
        // answer 404 — `assertFeatureEnabled` hides the feature rather than
        // refusing it — and a button that 404s is worse than no button.
        flagOn = false;
        await mountWithRow([folded], true, /Тестов препарат/);
        // The download is still there, which is what makes this an assertion
        // about the gate rather than about the row failing to render.
        expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument();
        expect(screen.queryByTestId('treatment-drive-handle-1')).not.toBeInTheDocument();
    });

    it('is ABSENT for a writer who is not an admin', async () => {
        // The accepted cost of the owner's ruling, made visible: the person who
        // recorded the treatment can download the document and cannot export
        // it. Better an absent control than one that 403s on a document they
        // just produced.
        await mountWithRow([folded], false, /Тестов препарат/);
        expect(screen.getByTestId('treatment-pdf-handle-1')).toBeInTheDocument();
        expect(screen.queryByTestId('treatment-drive-handle-1')).not.toBeInTheDocument();
    });

    it('is ABSENT on a free-hand entry, which has no treatment to export', async () => {
        await mountWithRow([freehand], true, /Ръчно наблюдение/);
        expect(screen.queryByTestId('treatment-drive-entry-manual')).not.toBeInTheDocument();
        expect(screen.queryByTestId('treatment-pdf-entry-manual')).not.toBeInTheDocument();
    });
});

describe('the Drive export posts to the treatment it sits on (#2019)', () => {
    it('POSTs to that row’s own handle', async () => {
        const fetchMock = fetchDouble(EXPORTED);
        global.fetch = fetchMock as unknown as typeof fetch;

        await mountWithRow([folded], true, /Тестов препарат/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));

        await waitFor(() => {
            // Found BY URL among the page's other traffic, not by call index:
            // the list revalidation shares this mock and is usually first.
            const call = fetchMock.mock.calls.find((c) =>
                String(c[0]).includes('/farm-record/drive'),
            );
            expect(call?.[0]).toBe('/api/t/acme/journal/treatments/handle-1/farm-record/drive');
            expect(call?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
        });
        await waitFor(() => {
            expect(toasts).toEqual([
                { kind: 'success', message: 'The diary was sent to Google Drive.' },
            ]);
        });
    });
});

describe('the refusal a farmer reads is the server\u2019s own sentence (#2019)', () => {
    it.each([
        ['\u041d\u044f\u043c\u0430 \u0441\u0432\u044a\u0440\u0437\u0430\u043d \u0430\u043a\u0430\u0443\u043d\u0442 \u0432 Google.'],
        ['Google \u043e\u0442\u043a\u0430\u0437\u0430 \u043a\u0430\u0447\u0432\u0430\u043d\u0435\u0442\u043e.'],
        ['\u041d\u044f\u043c\u0430 \u0437\u0430\u043f\u0438\u0441\u0438 \u0437\u0430 \u0442\u043e\u0437\u0438 \u043f\u0435\u0440\u0438\u043e\u0434.'],
    ])('shows %s verbatim, without translating it again', async (message) => {
        global.fetch = fetchDouble(refusal(400, { message })) as unknown as typeof fetch;
        await mountWithRow([folded], true, /\u0422\u0435\u0441\u0442\u043e\u0432 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));
        await waitFor(() => {
            expect(toasts).toEqual([{ kind: 'error', message }]);
        });
    });

    it('two different server sentences stay two different sentences', async () => {
        // The property that used to need a local map. `GOOGLE_DRIVE_NOT_GRANTED`
        // and `GOOGLE_DRIVE_REFUSED` both arrive as a 403 from Google and must
        // not collapse — telling a farmer to reconnect when their Drive is
        // simply full is wrong advice confidently given. Pass-through gets that
        // for free, and this case is what proves the client does not flatten
        // them on the way past.
        global.fetch = fetchDouble(
            refusal(400, { code: 'GOOGLE_DRIVE_NOT_GRANTED', message: 'Reconnect and grant Drive.' }),
        ) as unknown as typeof fetch;
        const first = await mountWithRow([folded], true, /\u0422\u0435\u0441\u0442\u043e\u0432 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));
        await waitFor(() => expect(toasts).toHaveLength(1));
        const notGranted = toasts[0].message;
        first.unmount();

        toasts.length = 0;
        global.fetch = fetchDouble(
            refusal(400, { code: 'GOOGLE_DRIVE_REFUSED', message: 'Check the Drive storage.' }),
        ) as unknown as typeof fetch;
        await mountWithRow([folded], true, /\u0422\u0435\u0441\u0442\u043e\u0432 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));
        await waitFor(() => expect(toasts).toHaveLength(1));

        expect(toasts[0].message).not.toBe(notGranted);
    });

    it('a refusal carrying NO message falls back to the one local sentence', async () => {
        // A code the catalogue has no entry for keeps its English prose, so a
        // message is almost always present. Almost is why this exists.
        global.fetch = fetchDouble(refusal(500, { code: 'SOMETHING_NEW' })) as unknown as typeof fetch;
        await mountWithRow([folded], true, /\u0422\u0435\u0441\u0442\u043e\u0432 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));
        await waitFor(() => {
            expect(toasts).toEqual([
                { kind: 'error', message: 'The export to Google Drive failed.' },
            ]);
        });
    });

    it('an unparseable envelope falls back too, rather than showing nothing', async () => {
        // The body is read leniently on purpose: a failure to parse it must not
        // become a second, less useful failure — or an empty toast.
        global.fetch = fetchDouble(refusal(502)) as unknown as typeof fetch;
        await mountWithRow([folded], true, /\u0422\u0435\u0441\u0442\u043e\u0432 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));
        await waitFor(() => {
            expect(toasts).toEqual([
                { kind: 'error', message: 'The export to Google Drive failed.' },
            ]);
        });
    });

    it('a blank server message is treated as absent, not shown as empty', async () => {
        // `.trim() ||` rather than `?? ` — a whitespace message would otherwise
        // render as a toast with no text in it.
        global.fetch = fetchDouble(refusal(400, { message: '   ' })) as unknown as typeof fetch;
        await mountWithRow([folded], true, /\u0422\u0435\u0441\u0442\u043e\u0432 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442/);
        fireEvent.click(screen.getByTestId('treatment-drive-handle-1'));
        await waitFor(() => {
            expect(toasts).toEqual([
                { kind: 'error', message: 'The export to Google Drive failed.' },
            ]);
        });
    });
});

describe('the Drive export at mobile width (#2019)', () => {
    it('keeps parity with the download it sits beside', async () => {
        // Rendered tests answer `matches: false` to every media query, so the
        // app is a PHONE by default and `<DataTable mobileFallback="card">`
        // renders cards rather than the table the action column lives in.
        //
        // So the assertion that means something here is PARITY: whatever the
        // card surface does with the per-row download, it does with the
        // export. Asserting a presence would pin the card layout, which this
        // change does not touch, and asserting an absence alone could pass
        // because the whole row failed to render.
        setViewport('mobile');
        await mountWithRow([folded], true, /Тестов препарат/);

        const pdf = screen.queryByTestId('treatment-pdf-handle-1');
        const drive = screen.queryByTestId('treatment-drive-handle-1');
        expect(drive === null).toBe(pdf === null);
    });
});
