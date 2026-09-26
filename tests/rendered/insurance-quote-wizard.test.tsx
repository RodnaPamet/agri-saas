/**
 * @jest-environment jsdom
 *
 * The insurance calculator, end to end (#1120).
 *
 * The figures asserted here are the reference calculator's, recomputed from the
 * engine's rules rather than copied from a screenshot: 1,000 dca at €100,000
 * cover on a 10 % tariff is a €10,000.00 premium, €10.00 per dca, and over three
 * instalments €3,333.34 / €3,333.33 / €3,333.33 — the remainder lands on the
 * FIRST instalment so the parts sum back to the total exactly.
 *
 * Copy comes from the REAL `messages/en.json` through the project-wide
 * next-intl mock, so a wording change that breaks a farmer's screen breaks this
 * suite too. The Bulgarian half lives in
 * `insurance-quote-wizard-bg.test.tsx`: the setup mock is English-only and one
 * jest module registry cannot hold two catalogues.
 *
 * The default jsdom viewport is a PHONE (see ./viewport), which is the primary
 * case for a farmer standing in a field; the last block repeats the flow on a
 * desktop so the two do not silently diverge.
 */
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ success: toastSuccess, info: jest.fn(), warning: jest.fn(), error: jest.fn() }),
}));

let online = true;
jest.mock('@/components/ui/async-state', () => ({
    ...jest.requireActual('@/components/ui/async-state'),
    useIsOnline: () => online,
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AskInsuranceModal } from '@/app/t/[tenantSlug]/(app)/farm-risk/AskInsuranceModal';

const ASK = enMessages.ag.risk.ask;
const QUOTE = enMessages.ag.risk.quote;
const PRODUCTS = enMessages.insurance.products;
const RISK = { overall: 'MEDIUM', ndvi: 0.42, ndmi: 0.31 };

type Overrides = Partial<{
    cropType: string | null;
    areaHa: number | null;
    risk: typeof RISK | null;
    locationName: string | null;
    locationParcels: readonly { cropType?: string | null; areaHa?: number | null }[];
}>;

function mount(overrides: Overrides = {}) {
    const onRequested = jest.fn();
    const utils = render(
        <TooltipProvider delayDuration={0}>
            <AskInsuranceModal
                parcelId="parcel-1"
                locationId="loc-1"
                parcelName="North Block"
                risk={'risk' in overrides ? overrides.risk! : RISK}
                cropType={'cropType' in overrides ? overrides.cropType : 'Winter Wheat'}
                areaHa={'areaHa' in overrides ? overrides.areaHa : 100}
                locationName={'locationName' in overrides ? overrides.locationName : 'Polje Sever'}
                locationParcels={overrides.locationParcels}
                hasRequested={false}
                onRequested={onRequested}
            />
        </TooltipProvider>,
    );
    return { ...utils, onRequested };
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const areaInput = () => el('insurance-quote-area') as HTMLInputElement;
const sumInput = () => el('insurance-quote-sum') as HTMLInputElement;
const nextBtn = () => screen.getByTestId('wizard-next');
const finishBtn = () => screen.getByTestId('wizard-finish');

/** Open the calculator and walk to step 2. */
async function openToCover(overrides: Overrides = {}) {
    const m = mount(overrides);
    await userEvent.click(screen.getByRole('button', { name: ASK.open }));
    await screen.findByText(QUOTE.step1Title);
    await userEvent.click(nextBtn());
    await screen.findByText(QUOTE.step2Title);
    return m;
}

beforeEach(() => {
    online = true;
    apiPost.mockReset().mockResolvedValue({ id: 'lead-1', status: 'PENDING' });
    toastSuccess.mockReset();
});

afterEach(() => {
    restoreViewport();
    cleanup();
    jest.clearAllMocks();
});

describe('step 1 — the product', () => {
    it('opens on step 1 in ONE click, with the crop preselected', async () => {
        mount();
        await userEvent.click(screen.getByRole('button', { name: ASK.open }));

        expect(await screen.findByText(QUOTE.step1Title)).toBeInTheDocument();
        // "Winter Wheat" is free text from seed data — normalisation is what
        // makes this preselect work at all.
        expect(el('insurance-quote-product-wheat')).toHaveAttribute('data-state', 'checked');
        // …and Next is therefore already available.
        expect(nextBtn()).toBeEnabled();
    });

    it('preselects nothing for an unmapped crop, and holds Next until a pick', async () => {
        mount({ cropType: 'Grass' });
        await userEvent.click(screen.getByRole('button', { name: ASK.open }));
        await screen.findByText(QUOTE.step1Title);

        expect(el('insurance-quote-product-wheat')).toHaveAttribute('data-state', 'unchecked');
        expect(nextBtn()).toBeDisabled();

        await userEvent.click(el('insurance-quote-product-barley'));
        await waitFor(() => expect(nextBtn()).toBeEnabled());
    });

    it('swaps the product list when the cover type changes', async () => {
        mount({ cropType: null });
        await userEvent.click(screen.getByRole('button', { name: ASK.open }));
        await screen.findByText(QUOTE.step1Title);

        expect(screen.getByText(PRODUCTS.wheat.name)).toBeInTheDocument();
        await userEvent.click(el('insurance-quote-kind-peril'));

        expect(await screen.findByText(PRODUCTS.hail.name)).toBeInTheDocument();
        expect(screen.queryByText(PRODUCTS.wheat.name)).not.toBeInTheDocument();
    });
});

describe('step 2 — cover and the live premium', () => {
    it('prefills the area in DECARES from hectares', async () => {
        await openToCover();
        // 100 ha is 1,000 dca. Hectares are converted on prefill and never shown.
        expect(areaInput()).toHaveValue('1000');
    });

    it('prices "100 000" as one hundred thousand, and shows the per-dca figure', async () => {
        await openToCover();
        await userEvent.type(sumInput(), '100 000');

        const line = await screen.findByText(
            QUOTE.premiumLine.replace('{premium}', '€10,000.00').replace('{perDca}', '€10.00'),
        );
        expect(line).toBeInTheDocument();
    });

    it('reaches the SAME premium through per-dca mode', async () => {
        await openToCover();
        await userEvent.click(el('insurance-quote-sum-mode-per-dca'));
        await userEvent.type(sumInput(), '100');

        expect(
            await screen.findByText(
                QUOTE.premiumLine.replace('{premium}', '€10,000.00').replace('{perDca}', '€10.00'),
            ),
        ).toBeInTheDocument();
    });

    it('echoes the other form of the sum, which is what catches a typo', async () => {
        await openToCover();
        await userEvent.type(sumInput(), '100 000');
        // Entered as a total, echoed per decare.
        expect(
            await screen.findByText(QUOTE.sumEchoPerDca.replace('{amount}', '€100.00')),
        ).toBeInTheDocument();
    });

    it('refuses an area of 0 on the AREA field and holds Next', async () => {
        await openToCover();
        await userEvent.clear(areaInput());
        await userEvent.type(areaInput(), '0');
        await userEvent.type(sumInput(), '100 000');

        expect(await screen.findByText(QUOTE.refusalArea)).toBeInTheDocument();
        expect(nextBtn()).toBeDisabled();
    });
});

describe('step 3 — schedule, and sending', () => {
    async function openToPayment(overrides = {}) {
        const m = await openToCover(overrides);
        await userEvent.type(sumInput(), '100 000');
        await waitFor(() => expect(nextBtn()).toBeEnabled());
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step3Title);
        return m;
    }

    it('splits three instalments so they sum back to the total exactly', async () => {
        await openToPayment();
        await userEvent.click(el('insurance-quote-instalments-3'));

        // The remainder goes on the FIRST instalment: 3,333.34 + 3,333.33 +
        // 3,333.33 = 10,000.00. Two equal thirds and a short one would not.
        expect(await screen.findByText('€3,333.34')).toBeInTheDocument();
        expect(screen.getAllByText('€3,333.33')).toHaveLength(2);
    });

    it('sends the exact body with BOTH headers', async () => {
        const { onRequested } = await openToPayment();
        await userEvent.click(finishBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const [url, body, , init] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/insurance/leads');
        expect(body).toEqual({
            parcelId: 'parcel-1',
            locationId: 'loc-1',
            risk: RISK,
            quote: {
                productKey: 'wheat',
                areaDca: 1000,
                sumInsuredCents: 10_000_000,
                instalments: 1,
                // The prefilled area was left alone, so the scope derives as
                // 'parcel' and carries no parcel count (#1121).
                areaScope: 'parcel',
            },
            // No note typed, so the field is absent rather than "".
            message: undefined,
        });
        // `apiPost` spreads init AFTER its own headers, so naming only
        // Idempotency-Key would DROP Content-Type.
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(onRequested).toHaveBeenCalledTimes(1);
    });

    it('sends no premium or tariff — the server recomputes the price', async () => {
        await openToPayment();
        await userEvent.click(finishBtn());
        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

        const quote = apiPost.mock.calls[0][1].quote;
        expect(quote).not.toHaveProperty('premiumCents');
        expect(quote).not.toHaveProperty('tariffBp');
        expect(quote).not.toHaveProperty('instalmentsCents');
    });

    it('reports the SERVER premium when it differs from the preview', async () => {
        // A cached PWA bundle against a newer tariff is a real situation.
        apiPost.mockResolvedValueOnce({
            id: 'lead-1',
            status: 'PENDING',
            quote: { premiumCents: 1_200_000, instalmentsCents: [1_200_000], tariffBp: 1200, engineVersion: 1 },
        });
        await openToPayment();
        await userEvent.click(finishBtn());

        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith(
                QUOTE.serverPremium.replace('{premium}', '€12,000.00'),
            ),
        );
    });

    it('keeps the wizard open on failure and REUSES the key on retry', async () => {
        apiPost.mockRejectedValueOnce(new Error('Network unreachable'));
        await openToPayment();
        await userEvent.click(finishBtn());

        // Still on step 3, reason shown, inputs intact.
        expect(await screen.findByTestId('wizard-error')).toHaveTextContent('Network unreachable');
        expect(screen.getByText(QUOTE.step3Title)).toBeInTheDocument();
        const firstKey = apiPost.mock.calls[0][3].headers['Idempotency-Key'];

        await waitFor(() => expect(finishBtn()).toBeEnabled());
        await userEvent.click(finishBtn());
        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));

        // The four quote inputs are unchanged, so this is the SAME request —
        // replaying it must return the original lead, not make a second one.
        expect(apiPost.mock.calls[1][3].headers['Idempotency-Key']).toBe(firstKey);
    });

    it('mints a NEW key when an input changes after a failure', async () => {
        apiPost.mockRejectedValueOnce(new Error('Network unreachable'));
        await openToPayment();
        await userEvent.click(finishBtn());
        await screen.findByTestId('wizard-error');
        const firstKey = apiPost.mock.calls[0][3].headers['Idempotency-Key'];

        // Go back and correct the area. Reusing the key here would replay the
        // OLD lead, and the farmer would believe the new figures went out.
        await userEvent.click(screen.getByTestId('wizard-back'));
        await screen.findByText(QUOTE.step2Title);
        await userEvent.clear(areaInput());
        await userEvent.type(areaInput(), '2000');
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step3Title);
        await userEvent.click(finishBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
        expect(apiPost.mock.calls[1][3].headers['Idempotency-Key']).not.toBe(firstKey);
        expect(apiPost.mock.calls[1][1].quote.areaDca).toBe(2000);
    });

    it('disables Send when offline, but still shows the premium', async () => {
        online = false;
        await openToPayment();

        expect(finishBtn()).toBeDisabled();
        expect(screen.getByText(QUOTE.offline)).toBeInTheDocument();
        // Calculating works offline; only sending needs a connection. Target the
        // KPI by id: with ONE instalment the schedule row shows the same figure.
        expect(el('insurance-quote-premium')).toHaveTextContent('€10,000.00');
        expect(apiPost).not.toHaveBeenCalled();
    });

    it('sends the note when one is typed', async () => {
        await openToPayment();
        await userEvent.type(el('insurance-quote-note'), 'Hail cover please');
        await userEvent.click(finishBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(apiPost.mock.calls[0][1].message).toBe('Hail cover please');
    });
});

describe('the crop-aggregate chip', () => {
    // 3 wheat parcels: this one (100 ha = 1,000 dca) plus two more.
    const THREE_WHEAT = [
        { cropType: 'Winter Wheat', areaHa: 100 },
        { cropType: 'Wheat', areaHa: 20 },
        { cropType: 'пшеница', areaHa: 4 },
    ];
    const chip = () => el('insurance-quote-crop-chip');

    it('offers the whole crop at the location, with the count', async () => {
        await openToCover({ locationParcels: THREE_WHEAT });
        // 124 ha over three parcels = 1,240 dca.
        expect(chip()).toHaveTextContent('1240');
        expect(chip()).toHaveTextContent('3 parcels');
        expect(chip()).toHaveTextContent(PRODUCTS.wheat.name);
        expect(chip()).toHaveTextContent('Polje Sever');
    });

    it('fills the area when tapped, and the premium follows', async () => {
        await openToCover({ locationParcels: THREE_WHEAT });
        await userEvent.click(chip());

        expect(areaInput()).toHaveValue('1240');
        await userEvent.type(sumInput(), '124 000');
        // 1,240 dca at €124,000 on a 10% tariff: €12,400.00, still €10.00/dca.
        expect(
            await screen.findByText(
                QUOTE.premiumLine.replace('{premium}', '€12,400.00').replace('{perDca}', '€10.00'),
            ),
        ).toBeInTheDocument();
    });

    it('is hidden when the location has only this one wheat parcel', async () => {
        await openToCover({ locationParcels: [{ cropType: 'Winter Wheat', areaHa: 100 }] });
        expect(chip()).toBeNull();
    });

    it('is hidden for a peril product, which aggregates no crop', async () => {
        const m = mount({ cropType: null, locationParcels: THREE_WHEAT });
        await userEvent.click(screen.getByRole('button', { name: ASK.open }));
        await screen.findByText(QUOTE.step1Title);
        await userEvent.click(el('insurance-quote-kind-peril'));
        await userEvent.click(await screen.findByText(PRODUCTS.hail.name));
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);

        expect(chip()).toBeNull();
        expect(m).toBeTruthy();
    });

    it('is hidden when the aggregate equals this parcel\'s own area', async () => {
        // One other parcel, but of a different crop — so the wheat total is
        // just this parcel and the chip would offer what the field already has.
        await openToCover({
            locationParcels: [
                { cropType: 'Winter Wheat', areaHa: 100 },
                { cropType: 'Maize', areaHa: 50 },
            ],
        });
        expect(chip()).toBeNull();
    });

    it('posts areaScope crop-at-location WITH the parcel count', async () => {
        await openToCover({ locationParcels: THREE_WHEAT });
        await userEvent.click(chip());
        await userEvent.type(sumInput(), '124 000');
        await waitFor(() => expect(nextBtn()).toBeEnabled());
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step3Title);
        await userEvent.click(finishBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(apiPost.mock.calls[0][1].quote).toMatchObject({
            areaDca: 1240,
            areaScope: 'crop-at-location',
            coveredParcelCount: 3,
        });
    });

    it('derives custom after a hand edit, and drops the count', async () => {
        // The scope is derived from the VALUE at send time, so editing after
        // tapping cannot leave the lead claiming "all your wheat".
        await openToCover({ locationParcels: THREE_WHEAT });
        await userEvent.click(chip());
        await userEvent.clear(areaInput());
        await userEvent.type(areaInput(), '900');
        await userEvent.type(sumInput(), '124 000');
        await waitFor(() => expect(nextBtn()).toBeEnabled());
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step3Title);
        await userEvent.click(finishBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const quote = apiPost.mock.calls[0][1].quote;
        expect(quote.areaScope).toBe('custom');
        expect(quote).not.toHaveProperty('coveredParcelCount');
    });

    it('derives parcel scope when the prefilled area is left alone', async () => {
        await openToCover({ locationParcels: THREE_WHEAT });
        await userEvent.type(sumInput(), '100 000');
        await waitFor(() => expect(nextBtn()).toBeEnabled());
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step3Title);
        await userEvent.click(finishBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(apiPost.mock.calls[0][1].quote.areaScope).toBe('parcel');
    });
});

describe('on a desktop', () => {
    it('runs the same flow to the same premium', async () => {
        setViewport('desktop');
        mount();
        await userEvent.click(screen.getByRole('button', { name: ASK.open }));
        await screen.findByText(QUOTE.step1Title);
        await userEvent.click(nextBtn());
        await screen.findByText(QUOTE.step2Title);
        await userEvent.type(sumInput(), '100 000');
        await waitFor(() => expect(nextBtn()).toBeEnabled());
        await userEvent.click(nextBtn());

        expect(await screen.findByText(QUOTE.step3Title)).toBeInTheDocument();
        expect(el('insurance-quote-premium')).toHaveTextContent('€10,000.00');
    });
});
