/**
 * Grain calculator — the report must SAY what it left out and WHICH
 * cost it is reporting.
 *
 * `GRAIN_NET_WORTH` is the fourth cost definition this product ships
 * and the only one that charges land rent and payroll. Two failure
 * modes are therefore specific to this page, and both look like a
 * perfectly healthy render:
 *
 *   1. an unnamed money figure — a farmer comparing this page with
 *      /grain/costs sees two different totals and no way to tell which
 *      question each answers;
 *   2. silently-dropped records — plantings with no yield estimate,
 *      lots in a unit that isn't a weight, leases whose rent could not
 *      be read. The usecase returns every one of them as a NAMED count
 *      precisely so the page can show them; a page that ignores that
 *      payload reports a confident, smaller number.
 *
 * So these tests assert VISIBILITY, not "it rendered": the metric name
 * is on screen, the exclusion total is on screen, each non-empty
 * exclusion class is named with its own count, and an empty class is
 * absent rather than printed as a zero row.
 *
 * ── Which viewport each test means ──────────────────────────────────
 *
 * `tests/rendered/setup.ts` answers `matches: false` to every media
 * query, so the jsdom default is a PHONE. That is the operator's real
 * device on this product, so most of the file pins `setViewport('mobile')`
 * DELIBERATELY rather than inheriting it — the two value panels stack
 * there and everything below must still be reachable.
 *
 * The per-commodity `<DataTable>` is `mobileFallback="scroll"`, so it
 * renders the real `<table>` at BOTH viewports (there is no
 * `MobileCardList` branch to miss here). The table assertions still pin
 * `setViewport('desktop')` and say so, because that is the viewport
 * whose column layout they describe.
 */

import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import enMessages from '../../messages/en.json';
import { formatDate, formatDateTime } from '@/lib/format-date';

import { restoreViewport, setViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/grain/calculator',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    // The tenant CONTEXT is what needs stubbing here (there is no provider
    // in this render); the money FORMATTER does not. Binding the mock hook
    // to the real `formatExactCurrency` keeps the string assertions below
    // ('€18,750') anchored to production behaviour — a hand-reproduced
    // formatter in the mock would let the two drift and quietly turn every
    // money assertion in this file into a test of the mock.
    const { formatExactCurrency } = jest.requireActual('@/lib/format-currency');
    return {
        useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
        useTenantCurrencySymbol: () => '€',
        // EXACT, not compact: the compact hook would round €18,750 to €19K.
        useExactMoneyFormatter: () => (v: number | null | undefined) =>
            formatExactCurrency(v, '€'),
        useTenantContext: () => ({
            tenantName: 'Acme Farms',
            tenantSlug: 'acme',
            currencySymbol: '€',
        }),
    };
});

import {
    CalculatorClient,
    type CalculatorData,
    type CalculatorExclusions,
    type CalculatorRow,
} from '@/app/t/[tenantSlug]/(app)/grain/calculator/CalculatorClient';

const COPY = enMessages.grain.calculator;

function emptyExclusions(): CalculatorExclusions {
    return {
        plantingsMissingYieldEstimate: [],
        plantingsUnknownCommodity: [],
        lotsUnresolvedUnit: [],
        lotsUnknownCommodity: [],
        commoditiesWithNoPrice: [],
        leasesUnresolvedRent: [],
        leasesUnattributed: [],
        leasesProduceRentUnpriced: [],
        payrollUnattributable: [],
    };
}

/**
 * Wheat, fully priced and fully certified: one currency on both sides,
 * so the usecase would have computed `netWorth`.
 *
 *   standing  60 t × €250   = €15,000
 *   on hand   40 t × €250   = €10,000
 *   grain rent 3,000 kg      =    €750  (priced, so subtracted)
 *   cash cost 4,000 + 1,500  =  €5,500
 *   net worth 24,250 − 5,500 = €18,750
 */
function wheatRow(over: Partial<CalculatorRow> = {}): CalculatorRow {
    return {
        commodity: 'wheat',
        pricePerTonne: 250,
        priceCurrency: 'EUR',
        // DATE-ONLY, matching production: trends.ts builds observedAt as
        // `latest.date.toISOString().slice(0, 10)`. An earlier fixture used a
        // full ISO timestamp, which made a formatDateTime render look correct
        // in the test while fabricating a 00:00 observation time in the app.
        priceObservedAt: '2026-08-01',
        priceSource: 'sofia-exchange',

        standingCropAreaHa: 12.5,
        standingCropExpectedKg: 60_000,
        standingCropPlantingIds: ['planting-w1'],
        standingCropValue: 15_000,

        grainOnHandTonnes: 40,
        grainOnHandLotIds: ['lot-w1'],
        grainOnHandValue: 10_000,

        attributedCropCost: 4_000,
        attributedCropCostCurrencies: ['EUR'],
        attributedCropCostCurrencyMixed: false,

        rentCostMoneyAmount: 0,
        rentCostProduceKg: 3_000,
        rentCostProduceValue: 750,

        payrollCost: 1_500,
        payrollCostCurrencies: ['EUR'],
        payrollCostCurrencyMixed: false,
        payrollAllocated: true,

        cashCostTotal: 5_500,
        cashCostCurrencies: ['EUR'],
        cashCostCurrencyMixed: false,

        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,

        netAssetPosition: 24_250,
        netWorth: 18_750,
        netWorthUnavailableReason: null,
        ...over,
    };
}

/** Maize with no market price — the usecase's stated refusal. */
function maizeRow(over: Partial<CalculatorRow> = {}): CalculatorRow {
    return {
        commodity: 'maize',
        pricePerTonne: null,
        priceCurrency: null,
        priceObservedAt: null,
        priceSource: null,

        standingCropAreaHa: 8,
        standingCropExpectedKg: 32_000,
        standingCropPlantingIds: ['planting-m1'],
        standingCropValue: null,

        grainOnHandTonnes: 0,
        grainOnHandLotIds: [],
        grainOnHandValue: null,

        attributedCropCost: 900,
        attributedCropCostCurrencies: ['EUR'],
        attributedCropCostCurrencyMixed: false,

        rentCostMoneyAmount: 0,
        rentCostProduceKg: 0,
        rentCostProduceValue: 0,

        payrollCost: 0,
        payrollCostCurrencies: [],
        payrollCostCurrencyMixed: false,
        payrollAllocated: false,

        cashCostTotal: 900,
        cashCostCurrencies: ['EUR'],
        cashCostCurrencyMixed: false,

        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,

        netAssetPosition: null,
        netWorth: null,
        netWorthUnavailableReason: 'No market price is available for maize.',
        ...over,
    };
}

function data(over: Partial<CalculatorData> = {}): CalculatorData {
    return {
        generatedAt: '2026-08-11T06:00:00.000Z',
        seasonId: null,
        rows: [wheatRow(), maizeRow()],
        exclusions: {
            ...emptyExclusions(),
            plantingsMissingYieldEstimate: ['planting-a', 'planting-b'],
            lotsUnresolvedUnit: [{ lotId: 'lot-1', unitKey: 'bag' }],
            leasesUnresolvedRent: [
                { leaseId: 'lease-1', reason: 'rent unit not recognised' },
            ],
            commoditiesWithNoPrice: ['maize'],
        },
        unvalued: { noUnitCost: 0, unitMismatch: 0 },
        cashOut: [],
        truncated: false,
        ...over,
    };
}

function renderPage(payload: CalculatorData = data()) {
    return render(<CalculatorClient tenantSlug="acme" data={payload} />);
}

afterEach(restoreViewport);

// ─────────────────────────────────────────────────────────────────────
// PHONE — the operator's real device. Panels stack; everything below
// the fold still has to be present in the DOM and readable.
// ─────────────────────────────────────────────────────────────────────

describe('grain calculator — on a PHONE (setViewport("mobile"))', () => {
    it('names the cost metric on screen', () => {
        setViewport('mobile');
        renderPage();

        // COST_METRIC_LABEL_KEYS[GRAIN_NET_WORTH] → grain.calculator.metricGrainNetWorth
        expect(screen.getByText(COPY.metricGrainNetWorth)).toBeVisible();
    });

    it('explains WHY its total differs from the costs page', () => {
        setViewport('mobile');
        renderPage();

        expect(
            screen.getByText(/its cost total is meant to be larger than the one shown there/),
        ).toBeVisible();
    });

    it('shows the exclusion TOTAL as a visible count', () => {
        setViewport('mobile');
        renderPage();

        // 2 plantings + 1 lot + 1 lease + 1 unpriced commodity = 5.
        expect(screen.getByText('5 records excluded')).toBeVisible();
    });

    it('names every non-empty exclusion class with its own count', () => {
        setViewport('mobile');
        renderPage();

        expect(
            screen.getByText(`${COPY.exclPlantingsMissingYieldEstimate} (2)`),
        ).toBeVisible();
        expect(screen.getByText(`${COPY.exclLotsUnresolvedUnit} (1)`)).toBeVisible();
        expect(screen.getByText(`${COPY.exclLeasesUnresolvedRent} (1)`)).toBeVisible();
        expect(screen.getByText(`${COPY.exclCommoditiesWithNoPrice} (1)`)).toBeVisible();
    });

    it('omits an empty exclusion class rather than printing a zero row', () => {
        setViewport('mobile');
        renderPage();

        expect(
            screen.queryByText(new RegExp(COPY.exclPayrollUnattributable)),
        ).not.toBeInTheDocument();
    });

    it('still states the count when nothing was excluded', () => {
        setViewport('mobile');
        renderPage(data({ exclusions: emptyExclusions() }));

        expect(screen.getByText('0 records excluded')).toBeVisible();
        expect(screen.getByText(COPY.exclusionsNone)).toBeVisible();
    });

    it('renders both value panels — expected beside actual', () => {
        setViewport('mobile');
        renderPage();

        // Queried by ROLE: "Standing crop" is also a column header in the
        // per-commodity table below, and a plain text query cannot tell
        // the panel from the column.
        expect(
            screen.getByRole('heading', { name: COPY.panelStandingTitle }),
        ).toBeVisible();
        expect(
            screen.getByRole('heading', { name: COPY.panelOnHandTitle }),
        ).toBeVisible();
        expect(screen.getByText(COPY.panelStandingSubtitle)).toBeVisible();
        expect(screen.getByText(COPY.panelOnHandSubtitle)).toBeVisible();
    });

    it('displays the standing-crop area in DECARES (storage stays hectares)', () => {
        setViewport('mobile');
        renderPage();

        // 12.5 ha × DCA_PER_HA = 125 dca.
        expect(screen.getByText(`125 ${COPY.areaUnit}`)).toBeVisible();
    });

    it('says that a payroll figure is an allocation, not a measurement', () => {
        setViewport('mobile');
        renderPage();

        // Both panels carry the badge — the same allocated cost is
        // charged in each, which is exactly what sharedCostNote warns
        // about.
        expect(screen.getAllByText(COPY.payrollAllocatedBadge).length).toBeGreaterThan(0);
        expect(screen.getAllByText(COPY.payrollAllocatedNote).length).toBeGreaterThan(0);
        expect(screen.getByText(COPY.sharedCostNote)).toBeVisible();
    });

    it('shows the certified net worth and both per-panel nets', () => {
        setViewport('mobile');
        renderPage();

        // The headline figure appears twice by design — the summary card
        // and the table row must agree.
        const netWorth = screen.getAllByText('€18,750'); // 24,250 − 5,500
        expect(netWorth.length).toBeGreaterThan(0);
        netWorth.forEach((node) => expect(node).toBeVisible());

        expect(screen.getByText('€9,500')).toBeVisible(); // standing 15,000 − 5,500
        expect(screen.getByText('€4,500')).toBeVisible(); // on hand 10,000 − 5,500
    });

    it('stamps WHEN the report was priced, and when the price was observed', () => {
        setViewport('mobile');
        renderPage();

        // Two stamps at two different SCOPES, and the gap between them is
        // the point: a valuation generated on 11 Aug off a quote observed
        // on 1 Aug is arithmetically correct and ten days stale. A reader
        // can only see that if BOTH dates are on screen.
        //
        // Expected strings are built with the real formatters rather than
        // hardcoded, so this asserts the WIRING (right value, right slot) and
        // not the shared formatter's output format — but the two fixture
        // dates differ, so swapping the slots still fails.
        //
        // Note the two use DIFFERENT helpers, deliberately: generatedAt is a
        // real instant (formatDateTime), priceObservedAt is date-only
        // (formatDate). Asserting formatDateTime on the observation would
        // pass while the app printed a midnight nobody observed.
        expect(
            screen.getByText(`Priced ${formatDateTime('2026-08-11T06:00:00.000Z')}`),
        ).toBeVisible();
        expect(screen.getByText(`Observed ${formatDate('2026-08-01')}`)).toBeVisible();
        expect(screen.queryByText(/Observed .*00:00/)).not.toBeInTheDocument();
    });

    it('omits the observation stamp when the price carries no date', () => {
        setViewport('mobile');
        // Maize has priceObservedAt: null — an absent date must not render
        // as "Observed —", which reads like a recorded value of nothing.
        renderPage(data({ rows: [maizeRow()] }));

        expect(screen.queryByText(/^Observed /)).not.toBeInTheDocument();
        // The report stamp is report-level, so it survives the row change.
        expect(
            screen.getByText(`Priced ${formatDateTime('2026-08-11T06:00:00.000Z')}`),
        ).toBeVisible();
    });

    it('never prints an unlabelled money figure in the cost breakdown', () => {
        setViewport('mobile');
        renderPage();

        // <StatusBreakdown>'s count slot prints `item.value` verbatim — no
        // symbol, no separator — and it defaults to ON. Left at the default
        // this page rendered "4000" directly above "Total farm cost €5,500":
        // the unnamed-money-figure failure the whole surface exists to avoid.
        //
        // Asserted as ABSENCE of the raw string plus PRESENCE of the
        // formatted one, because turning showCount back on would restore the
        // raw string while every other assertion in this file stayed green.
        expect(screen.queryByText('4000')).not.toBeInTheDocument();
        expect(screen.queryByText('1500')).not.toBeInTheDocument();
        expect(
            screen.getAllByText(`${COPY.costFieldLabel} · €4,000`).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByText(`${COPY.costPayrollLabel} · €1,500`).length,
        ).toBeGreaterThan(0);
    });

    it('never shows the internal UNKNOWN rent-currency sentinel', () => {
        setViewport('mobile');
        // Money rent present ⇒ the usecase pushes UNKNOWN_RENT_CURRENCY into
        // cashCostCurrencies. Joining that array verbatim printed a farmer
        // "Costs in EUR, UNKNOWN".
        renderPage(
            data({
                rows: [
                    wheatRow({
                        rentCostMoneyAmount: 300,
                        cashCostCurrencies: ['EUR', 'UNKNOWN'],
                    }),
                ],
            }),
        );

        expect(screen.queryByText(/UNKNOWN/)).not.toBeInTheDocument();
        expect(screen.getByText('Costs in EUR')).toBeVisible();
        expect(screen.getByText(COPY.currencyRentUnrecorded)).toBeVisible();
    });

    it('states an absent currency as a sentence, not inside a preposition slot', () => {
        setViewport('mobile');
        // The fallback used to be the clause "not recorded" substituted into
        // "Price in {currency}", yielding "Price in not recorded" — and in
        // Bulgarian a preposition followed by a finite verb.
        renderPage(
            data({
                rows: [wheatRow({ priceCurrency: null, cashCostCurrencies: [] })],
            }),
        );

        expect(screen.getByText(COPY.currencyPriceUnrecorded)).toBeVisible();
        expect(screen.getByText(COPY.currencyCostsUnrecorded)).toBeVisible();
        expect(screen.queryByText(/in not recorded/)).not.toBeInTheDocument();
    });

    it('states the refusal verbatim when net worth was withheld', () => {
        setViewport('mobile');
        // Maize first, so it is the selected commodity on mount.
        renderPage(data({ rows: [maizeRow()] }));

        expect(
            screen.getByText('No market price is available for maize.'),
        ).toBeVisible();
        // …and never a zero in its place.
        expect(screen.queryByText('€0')).not.toBeInTheDocument();
    });
});

// ─────────────────────────────────────────────────────────────────────
// DESKTOP — the per-commodity table. `mobileFallback="scroll"` means the
// real <table> renders at both viewports, but these assertions describe
// the desktop column layout, so the viewport is pinned and named.
// ─────────────────────────────────────────────────────────────────────

describe('grain calculator — per-commodity table on a DESKTOP (setViewport("desktop"))', () => {
    it('renders a real <table> with the money columns side by side', () => {
        setViewport('desktop');
        renderPage();

        const table = screen.getByRole('table');
        expect(within(table).getByText(COPY.colCommodity)).toBeVisible();
        expect(within(table).getByText(COPY.colStandingValue)).toBeVisible();
        expect(within(table).getByText(COPY.colOnHandValue)).toBeVisible();
        expect(within(table).getByText(COPY.colCashCost)).toBeVisible();
        expect(within(table).getByText(COPY.colNetWorth)).toBeVisible();
    });

    it('prints the refusal wording in a withheld net-worth cell, never a zero', () => {
        setViewport('desktop');
        renderPage();

        const table = screen.getByRole('table');
        expect(
            within(table).getByText(COPY.netWorthUnavailableTitle),
        ).toBeVisible();
        expect(within(table).getByText('€18,750')).toBeVisible();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Unvalued consumptions.
//
// A consumption the usecase could not price leaves `cashCostTotal` SHORT,
// which pushes net worth UP — the one direction a farmer must not take on
// trust. The page renders a floor and has to say so.
//
// Deliberately NOT in the exclusions accordion: nothing was excluded. The
// stock moved and the planting is counted; only the money is missing. So
// these assertions check the caveat is beside the COST, and that the
// exclusion count is unchanged by it.
// ─────────────────────────────────────────────────────────────────────

describe('grain calculator — unvalued consumptions (setViewport("mobile"))', () => {
    const withUnvalued = () =>
        data({
            rows: [wheatRow({ unvaluedNoUnitCost: 2, unvaluedUnitMismatch: 1 })],
            unvalued: { noUnitCost: 2, unitMismatch: 1 },
        });

    it('says the cost is a floor, and splits the reasons', () => {
        setViewport('mobile');
        renderPage(withUnvalued());

        // Both panels charge the same cost, so both carry the caveat.
        expect(
            screen.getAllByText(/3 consumptions could not be valued/).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByText(COPY.unvaluedReasonNoUnitCost.replace('{count}', '2')).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByText(COPY.unvaluedReasonUnitMismatch.replace('{count}', '1')).length,
        ).toBeGreaterThan(0);
    });

    it('states the farm-wide count in the header, before any toggling', () => {
        setViewport('mobile');
        renderPage(withUnvalued());

        expect(screen.getByText('3 unvalued consumptions farm-wide')).toBeVisible();
    });

    it('renders NOTHING when every consumption was valued', () => {
        setViewport('mobile');
        renderPage();

        // Absence, not a zero row — "0 unvalued" would be noise on the
        // overwhelmingly common healthy case, unlike the exclusion count
        // which is deliberately stated at zero.
        expect(screen.queryByText(/could not be valued/)).not.toBeInTheDocument();
        expect(screen.queryByText(/farm-wide/)).not.toBeInTheDocument();
    });

    it('omits a reason line whose count is zero', () => {
        setViewport('mobile');
        renderPage(
            data({
                rows: [wheatRow({ unvaluedNoUnitCost: 4, unvaluedUnitMismatch: 0 })],
                unvalued: { noUnitCost: 4, unitMismatch: 0 },
            }),
        );

        expect(
            screen.getAllByText(COPY.unvaluedReasonNoUnitCost.replace('{count}', '4')).length,
        ).toBeGreaterThan(0);
        expect(screen.queryByText(/unit differs from/)).not.toBeInTheDocument();
    });

    it('does NOT fold into the exclusion count — different kind of thing', () => {
        setViewport('mobile');
        renderPage(withUnvalued());

        // The fixture's five exclusions stay five: an unvalued consumption
        // was not excluded from anything.
        expect(screen.getByText('5 records excluded')).toBeVisible();
    });

    it('shows the farm-wide count even when it disagrees with the panel', () => {
        setViewport('mobile');
        // One transaction attributed to two commodities: 1 farm-wide,
        // 1 on each row. The two figures differ BY DESIGN, and the page
        // must not "reconcile" them by summing the rows.
        renderPage(
            data({
                rows: [
                    wheatRow({ unvaluedNoUnitCost: 1, unvaluedUnitMismatch: 0 }),
                    maizeRow({ unvaluedNoUnitCost: 1, unvaluedUnitMismatch: 0 }),
                ],
                unvalued: { noUnitCost: 1, unitMismatch: 0 },
            }),
        );

        expect(screen.getByText('1 unvalued consumption farm-wide')).toBeVisible();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Cash out — a DIFFERENT question, kept visibly apart.
//
// Everything else on this page answers "what is the grain worth after
// what it cost". This answers "what left the bank". They must never be
// added: crop cost is CONSUMPTION-based and rent cost is a lease-terms
// accrual, so a fertiliser purchase or a rent payment folded into either
// would bill the same money twice.
// ─────────────────────────────────────────────────────────────────────

describe('grain calculator — cash out (setViewport("mobile"))', () => {
    it('names the metric and states why it is kept apart', () => {
        setViewport('mobile');
        renderPage(
            data({ cashOut: [{ currency: 'BGN', amount: 1250, categories: ['FUEL'] }] }),
        );

        expect(screen.getByText(COPY.metricGrainCashOut)).toBeVisible();
        // The note is the whole point of the card's separateness.
        expect(screen.getByText(/would charge the same money twice/)).toBeVisible();
    });

    it('reports ONE ROW PER CURRENCY, never a blended total', () => {
        setViewport('mobile');
        renderPage(
            data({
                cashOut: [
                    { currency: 'BGN', amount: 1250, categories: ['FUEL', 'SEED'] },
                    { currency: 'EUR', amount: 400, categories: ['PESTICIDE'] },
                ],
            }),
        );

        // There is no FX table in this product, so a single figure would
        // reconcile against nothing.
        expect(screen.getByText('1,250 BGN')).toBeVisible();
        expect(screen.getByText('400 EUR')).toBeVisible();
        expect(screen.queryByText('1,650')).not.toBeInTheDocument();
    });

    it('is ABSENT when the farm entered no costs', () => {
        setViewport('mobile');
        renderPage();
        expect(screen.queryByText(COPY.metricGrainCashOut)).not.toBeInTheDocument();
    });

    it('does not move the net worth', () => {
        setViewport('mobile');
        // Cash out is a disclosure beside the answer, not part of it.
        renderPage(
            data({ cashOut: [{ currency: 'BGN', amount: 99_999, categories: ['FUEL'] }] }),
        );
        expect(screen.getAllByText('€18,750').length).toBeGreaterThan(0);
    });
});
