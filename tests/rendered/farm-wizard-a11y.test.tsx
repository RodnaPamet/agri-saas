/**
 * @jest-environment jsdom
 *
 * The farm wizard, for someone not using a mouse (P3.10).
 *
 * Run on the PHONE default (see ./viewport), which is the device this flow is
 * actually walked on. axe covers each step SEPARATELY, because a wizard renders
 * one step at a time and a sweep of step 1 says nothing about step 5 — and the
 * two ЕИК refusal states are swept too, since an error state is where an
 * accessible name usually goes missing.
 *
 * Real English copy, not key echoes: `tests/rendered/setup.ts` mocks `next-intl`
 * project-wide and resolves `messages/en.json` through ICU, so what axe reads is
 * what production renders. The sibling `farm-wizard.test.tsx` overrides that
 * with a key-echo mock on purpose — it asserts WHICH key was chosen, which is a
 * different question. This file must not override it, or it would be sweeping
 * placeholder strings.
 *
 * Step 1 also carries the consent checkbox and its two links to `/terms` and
 * `/privacy` (P3.1), so the account sweep covers the label/control association
 * that a `htmlFor`/`id` slip would break.
 *
 * ── what is deliberately NOT asserted ──
 *
 * The 44px coarse-pointer tap target. `pointer: coarse` is a media query and
 * jsdom answers `false` to every query, so that branch is unreachable here; it
 * is checked as source text in `tests/guards/button-touch-target-floor.test.ts`.
 *
 * The Turnstile widget's own markup. It is mocked to render nothing, because it
 * injects a third-party iframe whose accessibility is not ours to assert and
 * which does not exist at all while the sitekey is absent (which is every
 * environment today — P3.5c shipped it dormant).
 *
 * ── why there is a control at the bottom ──
 *
 * `toHaveNoViolations` passes on an empty container. So every sweep below first
 * asserts the step's own heading is on screen, and the last test injects a known
 * violation to prove axe can still fail in this harness. Without that, a mount
 * that silently threw would read as a clean accessibility report.
 */
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';

import enMessages from '../../messages/en.json';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('next-auth/react', () => ({
    signIn: jest.fn(async () => ({ error: undefined })),
}));

jest.mock('@/components/auth/TurnstileWidget', () => ({
    TurnstileWidget: () => null,
}));

import { FarmWizard } from '@/app/start/FarmWizard';
import { TERMS_VERSION } from '@/lib/legal/terms';

const W = enMessages.farmWizard;

/** Responses keyed by URL substring, so a step can be re-pointed per test. */
let routes: Record<string, { ok: boolean; body: unknown }>;

function baseRoutes() {
    return {
        '/api/auth/ui-config': { ok: true, body: { turnstileSitekey: null } },
        '/api/auth/register/start': { ok: true, body: {} },
        '/api/auth/register/verify': { ok: true, body: {} },
        '/api/public/eik-check': {
            ok: true,
            body: { valid: true, looksLikeEgn: false, registryName: 'ЗК ПОБЕДА' },
        },
        '/api/me/farms': {
            ok: true,
            body: {
                farm: { id: 'f1', slug: 'zk-pobeda-mg3k1x', name: 'ЗК ПОБЕДА' },
                identityVerification: 'pending_review',
            },
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    routes = baseRoutes();
    global.fetch = jest.fn(async (url: unknown) => {
        const u = String(url);
        const hit = Object.keys(routes).find((k) => u.includes(k));
        const r = hit ? routes[hit] : { ok: true, body: {} };
        return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body };
    }) as unknown as typeof fetch;
});

afterEach(cleanup);

/** Sweep the whole mounted tree, having first proved there is a tree. */
async function sweep(container: HTMLElement, headingText: string) {
    expect(screen.getByRole('heading', { level: 1, name: headingText })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
}

async function settle() {
    // The ЕИК check is debounced at 400ms and `ui-config` resolves on mount.
    await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
    });
}

describe('every step of the wizard is clean under axe', () => {
    it('1 — account', async () => {
        const { container } = render(<FarmWizard startAtFarmType={false} termsVersion={TERMS_VERSION} />);
        await settle();
        await sweep(container, W.accountTitle);
    });

    it('2 — code', async () => {
        const { container } = render(<FarmWizard startAtFarmType={false} termsVersion={TERMS_VERSION} />);
        await settle();

        fireEvent.change(screen.getByLabelText(W.name), { target: { value: 'Иван Петров' } });
        fireEvent.change(screen.getByLabelText(W.email), { target: { value: 'ivan@example.bg' } });
        fireEvent.change(screen.getByLabelText(W.password), { target: { value: 'a-long-enough-pw' } });
        // Consent (P3.1) gates the primary action. Without this the click is a
        // no-op on a disabled button and the walk to step 2 never happens —
        // which would leave this test sweeping step 1 twice under step 2's
        // name, a green result about the wrong screen.
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: W.accountSubmit }));

        await waitFor(() =>
            expect(screen.getByRole('heading', { level: 1, name: W.codeTitle })).toBeInTheDocument(),
        );
        await sweep(container, W.codeTitle);
    });

    it('3 — farm type', async () => {
        const { container } = render(<FarmWizard startAtFarmType termsVersion={TERMS_VERSION} />);
        await settle();
        await sweep(container, W.typeTitle);
    });

    it('4 — ЕИК, with a valid number accepted', async () => {
        const { container } = render(<FarmWizard startAtFarmType termsVersion={TERMS_VERSION} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: W.typeCompany }));
        fireEvent.change(screen.getByLabelText(W.eikLabel), { target: { value: '831641791' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: W.eikYesMine })).not.toBeDisabled(),
        );
        await sweep(container, W.eikTitle);
    });

    it('5 — farm name', async () => {
        const { container } = render(<FarmWizard startAtFarmType termsVersion={TERMS_VERSION} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: W.typeIndividual }));
        await sweep(container, W.farmNameTitle);
    });

    it('6 — done', async () => {
        const { container } = render(<FarmWizard startAtFarmType termsVersion={TERMS_VERSION} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: W.typeIndividual }));
        fireEvent.change(screen.getByLabelText(W.farmNameLabel), { target: { value: 'Ферма Слънце' } });
        fireEvent.click(screen.getByRole('button', { name: W.finish }));

        await waitFor(() =>
            expect(screen.getByRole('heading', { level: 1, name: W.doneTitle })).toBeInTheDocument(),
        );
        await sweep(container, W.doneTitle);
    });
});

describe('the ЕИК refusal states are clean too', () => {
    // These are the states a farmer is most likely to be stuck on, and the only
    // ones that render an InlineNotice. A notice that is invisible to a screen
    // reader leaves the step refusing with no stated reason.
    it.each([
        ['an ЕГН-shaped number', { valid: false, looksLikeEgn: true, registryName: null }],
        ['an invalid number', { valid: false, looksLikeEgn: false, registryName: null }],
    ])('%s', async (_label, body) => {
        routes['/api/public/eik-check'] = { ok: true, body };
        const { container } = render(<FarmWizard startAtFarmType termsVersion={TERMS_VERSION} />);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: W.typeCompany }));
        fireEvent.change(screen.getByLabelText(W.eikLabel), { target: { value: '7523169263' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: W.eikYesMine })).toBeDisabled(),
        );
        await sweep(container, W.eikTitle);
    });
});

describe('the control', () => {
    it('axe reports a violation in this harness when there is one', async () => {
        // Without this, every assertion above is also satisfied by a harness
        // where axe never runs, or runs over nothing. The violation chosen is
        // the one this wizard would most plausibly regress into: an input with
        // no accessible name, which is exactly what dropping a `htmlFor`/`id`
        // pair from any of the five fields above would produce.
        const { container } = render(
            <div>
                <input type="text" />
            </div>,
        );
        const result = await axe(container);
        expect(result.violations.length).toBeGreaterThan(0);
        expect(result.violations.map((v) => v.id)).toContain('label');
    });
});
