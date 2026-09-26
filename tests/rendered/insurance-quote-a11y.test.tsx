/**
 * @jest-environment jsdom
 *
 * The calculator, for someone not using a mouse (#1122).
 *
 * Run on the PHONE default (see ./viewport), which is the real device: a farmer
 * standing in a field. axe covers each of the three steps separately, because a
 * wizard renders one step at a time and a sweep of step 1 says nothing about
 * step 3.
 *
 * One thing deliberately NOT asserted here: the 44px coarse-pointer tap target.
 * `pointer: coarse` is a media query and jsdom answers `false` to every query,
 * so that branch is unreachable in a rendered test — it is checked as source
 * text in `tests/guards/button-touch-target-floor.test.ts`, which is also where
 * the ToggleGroup gap this step found is now pinned.
 */
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import enMessages from '../../messages/en.json';
import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/farm-risk',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
    useTenantCurrencySymbol: () => '€',
}));
const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ success: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AskInsuranceModal } from '@/app/t/[tenantSlug]/(app)/farm-risk/AskInsuranceModal';

const ASK = enMessages.ag.risk.ask;
const QUOTE = enMessages.ag.risk.quote;
const MODAL = enMessages.ui.modal;
const el = (id: string) => document.getElementById(id) as HTMLElement;
const nextBtn = () => screen.getByTestId('wizard-next');

function mount() {
    return render(
        <TooltipProvider delayDuration={0}>
            <AskInsuranceModal
                parcelId="p1"
                locationId="l1"
                parcelName="North Block"
                risk={null}
                cropType="Winter Wheat"
                areaHa={100}
                hasRequested={false}
                onRequested={jest.fn()}
            />
        </TooltipProvider>,
    );
}

const trigger = () => screen.getByRole('button', { name: ASK.open });

async function openWizard() {
    mount();
    await userEvent.click(trigger());
    await screen.findByText(QUOTE.step1Title);
}

/** Walk to step 2 with the sum filled, so step 3 is reachable. */
async function reachStep3() {
    await openWizard();
    await userEvent.click(nextBtn());
    await screen.findByText(QUOTE.step2Title);
    await userEvent.type(el('insurance-quote-sum'), '100 000');
    await waitFor(() => expect(nextBtn()).toBeEnabled());
    await userEvent.click(nextBtn());
    await screen.findByText(QUOTE.step3Title);
}

beforeEach(() => {
    apiPost.mockReset().mockResolvedValue({ id: 'lead-1', status: 'PENDING' });
});
afterEach(() => {
    restoreViewport();
    cleanup();
    jest.clearAllMocks();
});

describe('axe finds no violations on any step', () => {
    it('step 1 — product', async () => {
        const { container } = render(
            <TooltipProvider delayDuration={0}>
                <AskInsuranceModal
                    parcelId="p1" locationId="l1" parcelName="North Block" risk={null}
                    cropType="Winter Wheat" areaHa={100} hasRequested={false} onRequested={jest.fn()}
                />
            </TooltipProvider>,
        );
        await userEvent.click(trigger());
        await screen.findByText(QUOTE.step1Title);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('step 2 — cover, with a live premium on screen', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        await userEvent.type(el('insurance-quote-sum'), '100 000');
        await screen.findByText(
            QUOTE.premiumLine.replace('{premium}', '€10,000.00').replace('{perDca}', '€10.00'),
        );
        expect(await axe(document.body)).toHaveNoViolations();
    });

    it('step 3 — payment, schedule and the note field', async () => {
        await reachStep3();
        expect(await axe(document.body)).toHaveNoViolations();
    });
});

describe('the flow works from the keyboard alone', () => {
    it('advances on Enter pressed in a FIELD, which is what a phone keyboard sends', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        await userEvent.type(el('insurance-quote-sum'), '100 000');
        await waitFor(() => expect(nextBtn()).toBeEnabled());

        // The wizard owns the <form>, so Enter inside a field submits it — the
        // enterKeyHint="next" path. Step 1 has no text input, hence step 2.
        await userEvent.type(el('insurance-quote-sum'), '{Enter}');
        expect(await screen.findByText(QUOTE.step3Title)).toBeInTheDocument();
    });

    it('moves focus to the new step heading, so a screen reader follows', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await waitFor(() => {
            expect(document.activeElement?.textContent).toBe(QUOTE.step2Title);
        });
    });

    it('reaches every control on step 2 by Tab, in visual order', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);

        const tabbables = Array.from(
            document.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
        );
        const areaIdx = tabbables.indexOf(el('insurance-quote-area'));
        const sumIdx = tabbables.indexOf(el('insurance-quote-sum'));
        expect(areaIdx).toBeGreaterThan(-1);
        expect(sumIdx).toBeGreaterThan(areaIdx);
    });
});

/**
 * Escape and focus-return, on DESKTOP.
 *
 * On the phone default `Modal` renders the Vaul drawer, whose dismissal jsdom
 * cannot drive — Escape simply does nothing there. Asserting "the wizard is
 * still open after Escape" on a phone therefore passes whether or not the
 * confirm exists, which is a vacuous green; forcing the Radix path is what makes
 * these assertions mean anything. Same family as the coarse-pointer hazard.
 */
describe('dismissal, on the Radix path jsdom can actually drive', () => {
    beforeEach(() => setViewport('desktop'));

    it('asks before discarding a started quote', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        // Correcting ONLY the area counts as started. This is the case the old
        // `isDirty` missed — it watched the sum and the note, so an edited area
        // would have been discarded silently.
        await userEvent.clear(el('insurance-quote-area'));
        await userEvent.type(el('insurance-quote-area'), '900');

        await act(async () => {
            await userEvent.keyboard('{Escape}');
        });

        // POSITIVE evidence: the confirm is on screen. "Still open" alone would
        // also be true if Escape had done nothing at all.
        // findAll: the confirm renders its title as a heading AND as the
        // dialog's accessible name, so a single-match query is too narrow.
        expect((await screen.findAllByText(MODAL.discardChanges)).length).toBeGreaterThan(0);
        expect(screen.getByText(MODAL.keepEditing)).toBeInTheDocument();
        expect(screen.getByText(QUOTE.step2Title)).toBeInTheDocument();
    });

    it('lets an UNSTARTED quote close on Escape without nagging', async () => {
        // A confirm on every close trains people to dismiss it, which is how a
        // real warning stops being read.
        await openWizard();
        await act(async () => {
            await userEvent.keyboard('{Escape}');
        });
        await waitFor(() => expect(screen.queryByText(QUOTE.step1Title)).not.toBeInTheDocument());
        expect(screen.queryAllByText(MODAL.discardChanges)).toHaveLength(0);
    });

    it('really discards the draft, rather than only saying so', async () => {
        // The confirm says "your unsaved changes will be lost". They have to
        // actually be gone: `QuoteWizard` stays mounted while closed, so its
        // reducer state outlived the drawer until the wizard was keyed per
        // opening (#1122). Reopening showed the old sum insured, under a message
        // that had just promised otherwise.
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        await userEvent.type(el('insurance-quote-sum'), '55 555');
        expect(el('insurance-quote-sum')).toHaveValue('55 555');

        await act(async () => {
            await userEvent.keyboard('{Escape}');
        });
        await userEvent.click(await screen.findByText(MODAL.discard));

        await userEvent.click(trigger());
        await screen.findByText(QUOTE.step1Title);
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        expect(el('insurance-quote-sum')).toHaveValue('');
        // …and the prefill is back, not blanked along with it.
        expect(el('insurance-quote-area')).toHaveValue('1000');
    });

    it('returns focus to the trigger when the wizard closes', async () => {
        await openWizard();
        await act(async () => {
            await userEvent.keyboard('{Escape}');
        });
        await waitFor(() => expect(screen.queryByText(QUOTE.step1Title)).not.toBeInTheDocument());
        // Otherwise focus lands on <body> and a keyboard user restarts from the
        // top of the page.
        await waitFor(() => expect(trigger()).toHaveFocus());
    });
});

describe('the live premium is announced politely, not per keystroke', () => {
    it('announces through a polite status region', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);

        const live = document.querySelector('[aria-live]');
        expect(live).not.toBeNull();
        expect(live).toHaveAttribute('aria-live', 'polite');
        // assertive would interrupt the screen reader mid-sentence on every
        // recalculation, which happens on every keystroke.
        expect(live).not.toHaveAttribute('aria-live', 'assertive');
    });

    it('keeps the visible figure out of the live region, so it is not read twice', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        await userEvent.type(el('insurance-quote-sum'), '100 000');

        const visible = el('insurance-quote-premium');
        expect(visible).toHaveAttribute('aria-hidden', 'true');
    });

    it('the announcement lags the visible figure — it is debounced', async () => {
        await openWizard();
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        await userEvent.type(el('insurance-quote-sum'), '100 000');

        const expected = QUOTE.premiumLine
            .replace('{premium}', '€10,000.00')
            .replace('{perDca}', '€10.00');
        // Visible immediately…
        expect(el('insurance-quote-premium')).toHaveTextContent(expected);
        // …and the live region catches up only after the debounce window.
        const live = document.querySelector('[aria-live]') as HTMLElement;
        expect(live.textContent).not.toBe(expected);
        await waitFor(() => expect(live.textContent).toBe(expected), { timeout: 3000 });
    });
});
