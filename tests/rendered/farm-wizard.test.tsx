/**
 * The six-step farm wizard (P3.8).
 *
 * These assert the things the API contracts FORCE, because those are the ones
 * a future edit would break without noticing:
 *
 *   * the ЕИК check is a POST — a GET would put a possible ЕГН in a URL that
 *     iOS CFNetwork logs unsuppressably;
 *   * a valid-looking ЕГН blocks the step rather than warning and allowing;
 *   * step 6 never implies the ЕИК was ACCEPTED, because
 *     `identityVerification: 'pending_review'` is returned unconditionally and
 *     a colliding claim is invisible at creation;
 *   * the slug comes from the RESPONSE, since it carries a uniqueness suffix.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush }),
}));

/**
 * `useTranslations` returns the KEY, plus any params, so a test can assert on
 * interpolation (`eikValidNamed` carrying the registry name) and not just on
 * which key was chosen.
 *
 * `useLocale` is included deliberately: `next-intl` is a barrel, and a partial
 * mock turns the first component to reach a missing export into
 * "x is not a function" — the hazard this repo has hit across ~55 suites.
 */
jest.mock('next-intl', () => ({
    useLocale: () => 'bg',
    useTranslations: () => (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
}));

const mockSignIn = jest.fn(async () => ({ error: undefined }));
jest.mock('next-auth/react', () => ({
    signIn: (...a: unknown[]) => mockSignIn(...(a as [])),
}));

/** The widget is covered by its own suite; here it must simply not render. */
jest.mock('@/components/auth/TurnstileWidget', () => ({
    TurnstileWidget: () => null,
}));

import { FarmWizard } from '@/app/start/FarmWizard';

/** Queue of responses, matched by URL substring. */
let routes: Record<string, { ok: boolean; body: unknown }>;

function mockFetch() {
    global.fetch = jest.fn(async (url: unknown, init?: unknown) => {
        const u = String(url);
        const hit = Object.keys(routes).find((k) => u.includes(k));
        const r = hit ? routes[hit] : { ok: true, body: {} };
        calls.push({ url: u, init: init as { method?: string; body?: string } | undefined });
        return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body };
    }) as unknown as typeof fetch;
}

let calls: { url: string; init?: { method?: string; body?: string } }[];

/** Walk from the farm-type step to the ЕИК step. */
function chooseCompany() {
    fireEvent.click(screen.getByText('typeCompany'));
}

beforeEach(() => {
    jest.clearAllMocks();
    calls = [];
    routes = {
        '/api/auth/ui-config': { ok: true, body: { turnstileSitekey: null } },
        '/api/public/eik-check': { ok: true, body: { valid: true, looksLikeEgn: false, registryName: 'ЗК ПОБЕДА' } },
        '/api/me/farms': {
            ok: true,
            body: { farm: { id: 'f1', slug: 'zk-pobeda-mg3k1x', name: 'ЗК ПОБЕДА' }, identityVerification: 'pending_review' },
        },
    };
    mockFetch();
});

describe('the ЕИК check travels in a BODY, never a query string', () => {
    it('calls eik-check with POST and the value in the body', async () => {
        render(<FarmWizard startAtFarmType />);
        chooseCompany();

        fireEvent.change(screen.getByLabelText('eikLabel'), { target: { value: '831641791' } });
        await act(async () => {
            jest.advanceTimersByTime?.(500);
            await new Promise((r) => setTimeout(r, 500));
        });

        const check = calls.find((c) => c.url.includes('/api/public/eik-check'));
        expect(check).toBeDefined();
        // The whole point. A GET would put a value that may be an ЕГН into a
        // URL — logged by iOS CFNetwork unsuppressably, plus browser history
        // and Referer. P3.10 added the POST form for this caller.
        expect(check!.init?.method).toBe('POST');
        expect(check!.url).not.toContain('?');
        expect(check!.url).not.toContain('831641791');
        expect(JSON.parse(check!.init!.body as string)).toEqual({ eik: '831641791' });
    });

    it('prefills the farm name from the registry', async () => {
        render(<FarmWizard startAtFarmType />);
        chooseCompany();
        fireEvent.change(screen.getByLabelText('eikLabel'), { target: { value: '831641791' } });
        await waitFor(() =>
            expect(screen.getByText(/eikValidNamed/)).toBeInTheDocument(),
        );
        // The interpolated name, so the «Валиден ЕИК — ЗК ПОБЕДА» copy is
        // actually carrying the registry's answer.
        expect(screen.getByText(/ЗК ПОБЕДА/)).toBeInTheDocument();
    });
});

describe('an ЕГН stops the step dead', () => {
    it('shows the ЕГН warning and leaves the primary action disabled', async () => {
        routes['/api/public/eik-check'] = {
            ok: true,
            body: { valid: false, looksLikeEgn: true, registryName: null },
        };
        render(<FarmWizard startAtFarmType />);
        chooseCompany();

        fireEvent.change(screen.getByLabelText('eikLabel'), { target: { value: '7523169263' } });
        await waitFor(() => expect(screen.getByText('eikLooksLikeEgn')).toBeInTheDocument());

        // Warning AND refusal. Allowing it would file a personal identity
        // number as the farm's ЕИК, where it reaches the ДНЕВНИК PDF and the
        // БАБХ register export.
        // `getByRole`, not `getByText`: the latter returns the text node
        // INSIDE the button, which is never disabled — so the assertion
        // passed in both polarities. The control below was passing
        // vacuously until this was fixed, which is exactly what a control
        // is supposed to make impossible.
        expect(screen.getByRole('button', { name: 'eikYesMine' })).toBeDisabled();
    });

    it('an INVALID number is also refused', async () => {
        routes['/api/public/eik-check'] = {
            ok: true,
            body: { valid: false, looksLikeEgn: false, registryName: null },
        };
        render(<FarmWizard startAtFarmType />);
        chooseCompany();
        fireEvent.change(screen.getByLabelText('eikLabel'), { target: { value: '123456789' } });
        await waitFor(() => expect(screen.getByText('eikInvalid')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'eikYesMine' })).toBeDisabled();
    });

    it('…and a VALID one is allowed — the control', async () => {
        // Without this, a step that disabled the button unconditionally would
        // satisfy both assertions above while breaking the feature.
        render(<FarmWizard startAtFarmType />);
        chooseCompany();
        fireEvent.change(screen.getByLabelText('eikLabel'), { target: { value: '831641791' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'eikYesMine' })).not.toBeDisabled(),
        );
    });
});

describe('step 6 never implies the ЕИК was accepted', () => {
    async function finishAs(identityVerification: string) {
        routes['/api/me/farms'] = {
            ok: true,
            body: {
                farm: { id: 'f1', slug: 'zk-pobeda-mg3k1x', name: 'ЗК ПОБЕДА' },
                identityVerification,
            },
        };
        render(<FarmWizard startAtFarmType />);
        fireEvent.click(screen.getByText('typeIndividual'));
        fireEvent.change(screen.getByLabelText('farmNameLabel'), { target: { value: 'Ферма' } });
        fireEvent.click(screen.getByText('finish'));
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());
    }

    it.each([
        ['pending_review', 'doneIdentityPending'],
        ['deferred', 'doneIdentityDeferred'],
        ['not_requested', 'doneIdentityNone'],
    ])('%s renders %s', async (given, expected) => {
        await finishAs(given);
        expect(screen.getByText(expected)).toBeInTheDocument();
    });

    it('the headline and the identity line are SEPARATE elements', async () => {
        // «Стопанството Ви е онлайн» is true of the farm. Merged into one
        // sentence with a just-submitted ЕИК it would read as "your number
        // was accepted", which is not known and may be false.
        await finishAs('pending_review');
        const headline = screen.getByText('doneTitle');
        const identity = screen.getByText('doneIdentityPending');
        expect(headline).not.toBe(identity);
        expect(headline.textContent).not.toContain('doneIdentityPending');
    });
});

describe('the slug comes from the response', () => {
    it('navigates to the server-generated slug, not a derived one', async () => {
        routes['/api/me/farms'] = {
            ok: true,
            body: {
                // Deliberately NOT the transliteration of the typed name: the
                // server appends a uniqueness suffix, so a client-side guess
                // would 404.
                farm: { id: 'f1', slug: 'ferma-slantse-9xk2', name: 'Ферма Слънце' },
                identityVerification: 'not_requested',
            },
        };
        render(<FarmWizard startAtFarmType />);
        fireEvent.click(screen.getByText('typeIndividual'));
        fireEvent.change(screen.getByLabelText('farmNameLabel'), { target: { value: 'Ферма Слънце' } });
        fireEvent.click(screen.getByText('finish'));
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());

        fireEvent.click(screen.getByText('doneOpen'));
        expect(mockPush).toHaveBeenCalledWith('/t/ferma-slantse-9xk2');
    });
});

describe('the step counter reflects the path actually taken', () => {
    it('the физическо лице path is shorter than the ЕИК path', () => {
        const { unmount } = render(<FarmWizard startAtFarmType />);
        fireEvent.click(screen.getByText('typeIndividual'));
        // type → name → done. A fixed "of 6" would promise a step that never
        // arrives on this branch.
        expect(screen.getByText(/"total":3/)).toBeInTheDocument();
        unmount();

        render(<FarmWizard startAtFarmType />);
        fireEvent.click(screen.getByText('typeCompany'));
        // type → eik → name → done
        expect(screen.getByText(/"total":4/)).toBeInTheDocument();
    });

    it('an unauthenticated visitor walks the registration steps too', () => {
        render(<FarmWizard startAtFarmType={false} />);
        expect(screen.getByText('accountTitle')).toBeInTheDocument();
        // account → code → type → (eik) → name → done
        expect(screen.getByText(/"total":6/)).toBeInTheDocument();
    });
});

describe('a signed-in visitor is adding a farm, not registering', () => {
    it('starts at the farm-type step', () => {
        render(<FarmWizard startAtFarmType />);
        expect(screen.getByText('typeTitle')).toBeInTheDocument();
        expect(screen.queryByText('accountTitle')).not.toBeInTheDocument();
    });

    it('and does not sign in again', async () => {
        render(<FarmWizard startAtFarmType />);
        fireEvent.click(screen.getByText('typeIndividual'));
        fireEvent.change(screen.getByLabelText('farmNameLabel'), { target: { value: 'Ферма' } });
        fireEvent.click(screen.getByText('finish'));
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());
        expect(mockSignIn).not.toHaveBeenCalled();
    });
});
