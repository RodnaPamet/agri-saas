/**
 * The public-profile editor, rendered — P6.6 (#1884).
 *
 * The feature was API-only until this form existed: four endpoints with zero
 * UI callers. So the assertions that matter are the ones a farmer would
 * notice — that the draft they already have appears, that consent cannot be
 * recorded by accident, and that a taken address offers alternatives rather
 * than just refusing.
 *
 * `useTranslations` is mocked to return the KEY, so the expectations below
 * read as keys. That keeps the suite independent of the catalogue's wording,
 * which is being reviewed separately — and means a copy edit cannot break it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => href,
        useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: 'лв.' }),
    };
});

jest.mock('next-intl', () => {
    // ONE `t`, hoisted to module scope, because the real `useTranslations`
    // returns a `useMemo` and this component lists `t` in the deps of the
    // callback its mount effect runs.
    //
    // A fresh `t` per call makes that callback unstable, the effect re-runs on
    // every render, and the draft is refetched in a loop — which silently
    // consumed the queued mock responses so a later assertion failed with no
    // error visible anywhere. Same reasoning the tenant-context mock above
    // gives for hoisting its url builders.
    const t = (key: string) => key;
    t.has = () => true;
    t.rich = (k: string) => k;
    t.markup = (k: string) => k;
    t.raw = (k: string) => k;
    return { useLocale: () => 'bg', useTranslations: () => t };
});

import { PublicProfileClient } from '@/app/t/[tenantSlug]/(app)/admin/public-profile/PublicProfileClient';

const BASE = 'https://app.agrent.bg';

const DRAFT = {
    handle: 'pobeda',
    displayName: 'Стопанство Победа',
    tagline: 'Зърно от Добруджа',
    about: 'Семейно стопанство.',
    oblast: 'Добрич',
    crops: ['пшеница', 'слънчоглед'],
    published: false,
    publishedAt: null,
    consentedAt: null,
    consentTextVersion: null,
    indexable: false,
};

function mockFetch(responses: Array<{ ok: boolean; body: unknown; status?: number }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let i = 0;
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const r = responses[Math.min(i++, responses.length - 1)];
        return {
            ok: r.ok,
            status: r.status ?? (r.ok ? 200 : 400),
            json: async () => r.body,
        } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

afterEach(() => {
    jest.restoreAllMocks();
});

/**
 * The visibility switch, addressed by its own label rather than by position.
 *
 * There are TWO switches on this form — visibility and search indexing — and
 * an index would silently start asserting about the other one the moment the
 * order changes. The consent tick is a `checkbox`, a different role, so it is
 * never confused with either.
 */
const visibilitySwitch = () => screen.findByRole('switch', { name: /visibilityLabel/ });

describe('the public-profile editor', () => {
    it('shows the draft the farm already has', async () => {
        // The reason this form exists: before it, nothing could display what
        // was stored, so an owner would have opened a blank page over their
        // own content.
        mockFetch([{ ok: true, body: DRAFT }]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await waitFor(() => {
            expect(screen.getByDisplayValue('Стопанство Победа')).toBeInTheDocument();
        });
        expect(screen.getByDisplayValue('Зърно от Добруджа')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Добрич')).toBeInTheDocument();
        // Crops are stored as an array and edited as one comma-separated
        // field, so the join is part of what the form has to get right.
        expect(screen.getByDisplayValue('пшеница, слънчоглед')).toBeInTheDocument();
        expect(screen.getByDisplayValue('pobeda')).toBeInTheDocument();
    });

    it('starts with the page private, and does not publish when switched on', async () => {
        // The owner's ruling: visibility is OFF by default and turning it ON
        // raises the consent rather than publishing. Both halves asserted
        // together, because a switch that was off but published on the first
        // click would satisfy neither.
        const calls = mockFetch([{ ok: true, body: DRAFT }]);
        render(<PublicProfileClient baseUrl={BASE} />);

        const visibility = await visibilitySwitch();
        expect(visibility).not.toBeChecked();
        // Nothing is on screen to agree to until it is asked for.
        expect(screen.queryByText('consentBody')).not.toBeInTheDocument();

        await userEvent.click(visibility);

        // The consent text appears...
        expect(await screen.findByText('consentBody')).toBeInTheDocument();
        // ...and NOTHING was published. This is the assertion the ruling is
        // about: the switch asks, it does not act.
        expect(calls.filter((c) => c.url.endsWith('/farm-brand/publication'))).toHaveLength(0);
    });

    it('will not record consent until the box is checked', async () => {
        // The legally meaningful control. Consent records that a person was
        // shown a text and agreed; a confirm button that worked without the
        // checkbox would let that record be created by a stray click.
        mockFetch([{ ok: true, body: DRAFT }]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await userEvent.click(await visibilitySwitch());

        const confirm = await screen.findByRole('button', { name: 'consentConfirm' });
        expect(confirm).toBeDisabled();

        await userEvent.click(screen.getByRole('checkbox'));
        expect(confirm).toBeEnabled();
    });

    it('records the consent BEFORE it publishes', async () => {
        // The order is the safe one on the failure path: consent recorded and
        // publication refused leaves a true statement about what was agreed
        // to and a private page. The reverse would publish first and record
        // afterwards, so a failure between them would leave a public page
        // with no record.
        const calls = mockFetch([
            { ok: true, body: DRAFT },
            { ok: true, body: { consentedAt: '2026-10-15T00:00:00Z', textVersion: 'v1' } },
            { ok: true, body: { handle: 'pobeda', withdrawn: false, removedHandle: null } },
            {
                ok: true,
                body: {
                    ...DRAFT,
                    published: true,
                    publishedAt: '2026-10-15T00:00:00Z',
                    consentedAt: '2026-10-15T00:00:00Z',
                    consentTextVersion: 'v1',
                },
            },
        ]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await userEvent.click(await visibilitySwitch());
        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.click(screen.getByRole('button', { name: 'consentConfirm' }));

        await waitFor(() => {
            expect(calls.some((c) => c.url.endsWith('/farm-brand/publication'))).toBe(true);
        });
        const consentAt = calls.findIndex((c) => c.url.endsWith('/farm-brand/consent'));
        const publishAt = calls.findIndex((c) => c.url.endsWith('/farm-brand/publication'));
        expect(consentAt).toBeGreaterThanOrEqual(0);
        expect(consentAt).toBeLessThan(publishAt);
        // And the recorded version is the one this build rendered, not a
        // hard-coded string that could drift from the text on screen.
        expect(String(calls[consentAt].init?.body)).toContain('v1');
    });

    it('cancelling leaves the page private and sends nothing', async () => {
        const calls = mockFetch([{ ok: true, body: DRAFT }]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await userEvent.click(await visibilitySwitch());
        await userEvent.click(await screen.findByRole('button', { name: 'consentCancel' }));

        expect(screen.queryByText('consentBody')).not.toBeInTheDocument();
        expect(await visibilitySwitch()).not.toBeChecked();
        expect(calls).toHaveLength(1); // the initial draft load, and nothing else
    });

    it('never asks for consent to take a page DOWN', async () => {
        // A farm must always be able to withdraw. The usecase makes the same
        // choice — the publication preconditions apply only to `true` — and
        // asking somebody to agree to something in order to STOP publishing
        // would be absurd.
        const published = {
            ...DRAFT,
            published: true,
            publishedAt: '2026-10-15T00:00:00Z',
            consentedAt: '2026-10-15T00:00:00Z',
            consentTextVersion: 'v1',
        };
        const calls = mockFetch([
            { ok: true, body: published },
            { ok: true, body: { handle: null, withdrawn: true, removedHandle: 'pobeda' } },
            { ok: true, body: DRAFT },
        ]);
        render(<PublicProfileClient baseUrl={BASE} />);

        const visibility = await visibilitySwitch();
        await waitFor(() => expect(visibility).toBeChecked());
        await userEvent.click(visibility);

        await waitFor(() => {
            expect(calls.some((c) => c.url.endsWith('/farm-brand/publication'))).toBe(true);
        });
        expect(calls.some((c) => c.url.endsWith('/farm-brand/consent'))).toBe(false);
        expect(screen.queryByText('consentBody')).not.toBeInTheDocument();
    });

    it('publishes straight away when the recorded consent is current', async () => {
        // The control for the two tests above: a farm that already agreed to
        // THIS text is not asked again, or the switch would be a nuisance
        // rather than a safeguard.
        const consented = {
            ...DRAFT,
            consentedAt: '2026-10-15T00:00:00Z',
            consentTextVersion: 'v1',
        };
        const calls = mockFetch([
            { ok: true, body: consented },
            { ok: true, body: { handle: 'pobeda', withdrawn: false, removedHandle: null } },
            { ok: true, body: { ...consented, published: true, publishedAt: '2026-10-15T00:00:00Z' } },
        ]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await userEvent.click(await visibilitySwitch());

        await waitFor(() => {
            expect(calls.some((c) => c.url.endsWith('/farm-brand/publication'))).toBe(true);
        });
        expect(screen.queryByText('consentBody')).not.toBeInTheDocument();
    });

    it('re-asks when the text changed since the farm agreed', async () => {
        // What `consentTextVersion` is FOR. A farm that agreed to v0 has not
        // agreed to v1, and a timestamp alone cannot tell the difference — so
        // a stale version must re-ask rather than inherit the older answer.
        const stale = {
            ...DRAFT,
            consentedAt: '2026-10-01T00:00:00Z',
            consentTextVersion: 'v0',
        };
        const calls = mockFetch([{ ok: true, body: stale }]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await userEvent.click(await visibilitySwitch());

        expect(await screen.findByText('consentBody')).toBeInTheDocument();
        // Named as stale rather than presented as a first-time agreement.
        expect(screen.getByText('consentStale')).toBeInTheDocument();
        expect(calls.filter((c) => c.url.endsWith('/farm-brand/publication'))).toHaveLength(0);
    });

    it('renders the consent text itself, not a summary of it', async () => {
        // A consent record names a text VERSION, so the text has to be on
        // screen for that record to mean anything.
        mockFetch([{ ok: true, body: DRAFT }]);
        render(<PublicProfileClient baseUrl={BASE} />);
        await userEvent.click(await visibilitySwitch());
        expect(await screen.findByText('consentBody')).toBeInTheDocument();
    });

    it('offers the suggestions when an address is taken', async () => {
        // `FARM_HANDLE_TAKEN` carries derived alternatives. Rendering them as
        // BUTTONS is the point — retyping a suggestion is how an owner ends
        // up with a typo of it.
        const calls = mockFetch([
            { ok: true, body: DRAFT },
            {
                ok: false,
                status: 400,
                // The REAL envelope shape — `ErrorResponse` in the spec.
                // Writing it flat here is what let the client's flat read
                // look correct; this is the shape the route actually sends.
                body: {
                    error: {
                        code: 'FARM_HANDLE_TAKEN',
                        message: 'taken',
                        details: { suggestions: ['pobeda-dobrich', 'zp-pobeda'] },
                    },
                },
            },
            { ok: true, body: { handle: 'pobeda-dobrich', normalised: false, reprojected: false } },
            { ok: true, body: DRAFT },
        ]);
        render(<PublicProfileClient baseUrl={BASE} />);

        await userEvent.click(await screen.findByRole('button', { name: 'addressClaim' }));

        const suggestion = await screen.findByRole('button', { name: 'pobeda-dobrich' });
        expect(screen.getByRole('button', { name: 'zp-pobeda' })).toBeInTheDocument();

        await userEvent.click(suggestion);
        await waitFor(() => {
            expect(
                calls.some(
                    (c) =>
                        c.url.endsWith('/farm-brand/handle') &&
                        String(c.init?.body).includes('pobeda-dobrich'),
                ),
            ).toBe(true);
        });
    });

    it('shows the QR only once the page is published', async () => {
        // A QR for an unpublished page encodes a 404, and it is the one
        // artefact an owner might print before noticing.
        mockFetch([{ ok: true, body: DRAFT }]);
        const { unmount } = render(<PublicProfileClient baseUrl={BASE} />);
        await visibilitySwitch();
        expect(screen.queryByLabelText('QR code')).not.toBeInTheDocument();
        unmount();

        mockFetch([
            { ok: true, body: { ...DRAFT, published: true, publishedAt: '2026-10-15T00:00:00Z' } },
        ]);
        render(<PublicProfileClient baseUrl={BASE} />);
        await waitFor(() => {
            expect(screen.getByLabelText('QR code')).toBeInTheDocument();
        });
    });

    it.each([
        ['mobile', 390],
        ['desktop', 1280],
    ])('renders at %s width', async (_label, width) => {
        // The roadmap's standing rule. The form is a single column at both,
        // so this is a smoke test that nothing throws under either viewport
        // rather than a layout assertion.
        Object.defineProperty(window, 'innerWidth', { writable: true, value: width });
        window.dispatchEvent(new Event('resize'));
        mockFetch([{ ok: true, body: DRAFT }]);
        render(<PublicProfileClient baseUrl={BASE} />);
        expect(await screen.findByText('heading')).toBeInTheDocument();
    });
});
