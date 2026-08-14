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
import { fireEvent, render, screen, within } from '@testing-library/react';
import enMessages from '../../messages/en.json';
import { formatDate, formatDateTime } from '@/lib/format-date';

import { foldFarmTotals } from '@/lib/grain/farm-total';
import { computePerArea } from '@/lib/grain/per-area';
import { computeBreakEven } from '@/lib/grain/break-even';
import { costUncertainty, netWorthUncertainty } from '@/lib/grain/uncertainty';
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
    EXCLUSION_CLASS_DESTINATIONS,
    type CalculatorData,
    type CalculatorExclusions,
    type CalculatorRow,
} from '@/app/t/[tenantSlug]/(app)/grain/calculator/CalculatorClient';

const COPY = enMessages.grain.calculator;

/**
 * Applies the SAME derivations `calculator/page.tsx` applies.
 *
 * Those three fields moved server-side, so a fixture that hardcoded them
 * would let a test set `unvaluedNoUnitCost: 2` and still assert against an
 * EXACT headline — passing while production showed a bound. Deriving them
 * here keeps the fixture a model of the server rather than a wish about
 * it. An explicit override still wins, for the cases that mean to pin a
 * state directly.
 */
function withServerDerived(
    row: Omit<
        CalculatorRow,
        'netUncertainty' | 'costUncertainty' | 'showProduceRent' | 'perArea' | 'breakEven'
    > &
        Partial<
            Pick<
                CalculatorRow,
                | 'netUncertainty'
                | 'costUncertainty'
                | 'showProduceRent'
                | 'perArea'
                | 'breakEven'
            >
        >,
): CalculatorRow {
    return {
        ...row,
        // Folded with the SAME function the usecase calls. Hardcoding it
        // would let a fixture claim a margin its own numerator and
        // denominator do not produce.
        breakEven:
            row.breakEven ??
            computeBreakEven({
                standingCropExpectedKg: row.standingCropExpectedKg,
                attributableCost: row.cashCostTotal,
                pricePerTonne: row.pricePerTonne,
                priceCurrency: row.priceCurrency,
                standingCropExcludedCount: 0,
                unvaluedNoUnitCost: row.unvaluedNoUnitCost,
                unvaluedUnitMismatch: row.unvaluedUnitMismatch,
                payrollAllocated: row.payrollAllocated,
            }),
        perArea:
            row.perArea ??
            computePerArea({
                standingCropAreaHa: row.standingCropAreaHa,
                standingCropValue: row.standingCropValue,
                attributableCost: row.cashCostTotal,
                standingCropExcludedCount: 0,
                unvaluedNoUnitCost: row.unvaluedNoUnitCost,
                unvaluedUnitMismatch: row.unvaluedUnitMismatch,
                payrollAllocated: row.payrollAllocated,
            }),
        netUncertainty: row.netUncertainty ?? netWorthUncertainty(row),
        costUncertainty: row.costUncertainty ?? costUncertainty(row),
        showProduceRent: row.showProduceRent ?? row.rentCostProduceKg > 0,
    };
}

/** An excluded record as the usecase now returns it: id + human label. */
function ex(id: string, label?: string) {
    return { id, label: label ?? id };
}

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
    return withServerDerived({
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
        standingCropValue: 15_000,

        grainOnHandTonnes: 40,
        grainOnHandValue: 10_000,

        costBreakdown: [
            { id: 'field', labelKey: 'costFieldLabel', value: 4_000, variant: 'brand' },
            { id: 'rent', labelKey: 'costRentLabel', value: 0, variant: 'warning' },
            { id: 'payroll', labelKey: 'costPayrollLabel', value: 1_500, variant: 'info' },
        ],

        rentCostProduceKg: 3_000,
        rentCostProduceValue: 750,

        payrollAllocated: true,

        cashCostTotal: 5_500,

        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,
        netWorth: 18_750,
        netWorthUnavailableReason: null,
        netWorthUnavailableCode: null,
        netWorthUnavailableParams: null,

        costCurrencyCodes: ['EUR'],
        rentCurrencyUnknown: false,
        ...over,
    });
}

/** Maize with no market price — the usecase's stated refusal. */
function maizeRow(over: Partial<CalculatorRow> = {}): CalculatorRow {
    return withServerDerived({
        commodity: 'maize',
        pricePerTonne: null,
        priceCurrency: null,
        priceObservedAt: null,
        priceSource: null,

        standingCropAreaHa: 8,
        standingCropExpectedKg: 32_000,
        standingCropValue: null,

        grainOnHandTonnes: 0,
        grainOnHandValue: null,

        costBreakdown: [
            { id: 'field', labelKey: 'costFieldLabel', value: 900, variant: 'brand' },
            { id: 'rent', labelKey: 'costRentLabel', value: 0, variant: 'warning' },
            { id: 'payroll', labelKey: 'costPayrollLabel', value: 0, variant: 'info' },
        ],

        rentCostProduceKg: 0,
        rentCostProduceValue: 0,

        payrollAllocated: false,

        cashCostTotal: 900,

        unvaluedNoUnitCost: 0,
        unvaluedUnitMismatch: 0,
        netWorth: null,
        netWorthUnavailableReason: 'No market price is available for maize.',
        netWorthUnavailableCode: 'NO_MARKET_PRICE',
        netWorthUnavailableParams: { commodity: 'maize' },

        costCurrencyCodes: ['EUR'],
        rentCurrencyUnknown: false,
        ...over,
    });
}

function data(over: Partial<CalculatorData> = {}): CalculatorData {
    // `farm` is FOLDED from the rows, exactly as the usecase folds it.
    // Hardcoding it would let a fixture claim a farm total that its own
    // rows do not add up to — the fixture would pass while production
    // disagreed with itself. Same reason `withServerDerived` exists above.
    const rows = over.rows ?? [wheatRow(), maizeRow()];
    return {
        generatedAt: '2026-08-11T06:00:00.000Z',
        seasonId: null,
        rows,
        farm: {
            totals: foldFarmTotals(rows),
            refusedWithoutCurrency: rows
                .filter((r) => r.netWorth == null && r.priceCurrency == null)
                .map((r) => r.commodity)
                .sort(),
        },
        exclusions: {
            ...emptyExclusions(),
            plantingsMissingYieldEstimate: [
                ex('planting-a', 'Нива 3 · Пшеница'),
                ex('planting-b', 'Нива 4 · Пшеница'),
            ],
            lotsUnresolvedUnit: [ex('lot-1', 'Пшеница, реколта 2026 (bag)')],
            leasesUnresolvedRent: [ex('lease-1', 'Иван Петров · Нива 7')],
            commoditiesWithNoPrice: [ex('maize')],
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

    it('states both asset terms — expected and actual — inside the one sum', () => {
        setViewport('mobile');
        renderPage();

        // Still both named. What changed is that they are TERMS in one
        // arithmetic, not two panels each ending in their own total.
        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(within(sum).getByText(COPY.panelStandingTitle)).toBeVisible();
        expect(within(sum).getByText(COPY.panelOnHandTitle)).toBeVisible();
        expect(within(sum).getByText(COPY.panelStandingSubtitle)).toBeVisible();
        expect(within(sum).getByText(COPY.panelOnHandSubtitle)).toBeVisible();
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

        // ONCE now. There is one cost line, so there is one place to say
        // the payroll inside it was apportioned rather than measured.
        expect(screen.getByText(COPY.payrollAllocatedBadge)).toBeVisible();
        expect(screen.getByText(COPY.payrollAllocatedNote)).toBeVisible();
    });

    it('shows the certified net worth once, and no per-panel nets', () => {
        setViewport('mobile');
        renderPage();

        // The headline figure appears in the sum and again in the table
        // row — those must agree, and the table is an appendix listing
        // every commodity, not a second answer to the same question.
        const netWorth = screen.getAllByText('€18,750'); // 24,250 − 5,500
        expect(netWorth.length).toBeGreaterThan(0);
        netWorth.forEach((node) => expect(node).toBeVisible());

        // THE DEFECT THIS PAGE SHIPPED WITH. Two panels each ending in a
        // net line is the universal idiom for "these sum" — and they did
        // not: both charged the same cashCostTotal, so 9,500 and 4,500
        // were each the whole farm cost taken off one asset. Neither is a
        // quantity anyone can act on, and their sum is meaningless.
        expect(screen.queryByText('€9,500')).not.toBeInTheDocument();
        expect(screen.queryByText('€4,500')).not.toBeInTheDocument();
    });

    // ─────────────────────────────────────────────────────────────────
    // ONE ANSWER. The page previously rendered two ValuePanels side by
    // side, each ending in a net line, plus a sentence explaining that
    // the two nets could not be added. Side-by-side panels each ending
    // in a total is the universal idiom for "these sum"; a prose
    // disclaimer cannot beat a layout.
    // ─────────────────────────────────────────────────────────────────

    it('states exactly ONE net figure', () => {
        setViewport('mobile');
        renderPage();

        // The net label is the page's answer, and it is claimed once.
        // Still scoped to the sum. The appendix table that used to carry
        // a second "Net worth" is gone, but the scoping is what makes the
        // assertion mean "claimed once HERE" rather than "appears once on
        // the page" — the weaker claim would start passing the day a
        // second surface repeats the figure.
        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(within(sum).getAllByText(COPY.netWorthLabel)).toHaveLength(1);

        // And the retired idiom is gone in both its parts — the per-asset
        // net line, and the note that existed only to disclaim it. Their
        // i18n keys are deleted, so the retired COPY is spelled out here:
        // the assertion is that this wording never returns, and a key
        // reference could not express that once the key is gone.
        expect(screen.queryByText('Net after cost')).not.toBeInTheDocument();
        expect(
            screen.queryByText(/the two nets cannot be added/i),
        ).not.toBeInTheDocument();
    });

    it('puts every money figure in the sum on one signed column', () => {
        setViewport('mobile');
        renderPage();

        // No two figures sit in a layout implying summation UNLESS they
        // genuinely sum. Here they do, so each is signed and the reader
        // can add them down the column:
        //   +15,000  standing
        //   +10,000  on hand
        //     −750   rent paid in grain
        //   −5,500   farm cost
        //   =18,750  net worth
        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(within(sum).getByText('+€15,000')).toBeVisible();
        expect(within(sum).getByText('+€10,000')).toBeVisible();
        expect(within(sum).getByText('−€750')).toBeVisible();
        expect(within(sum).getByText('−€5,500')).toBeVisible();
        expect(within(sum).getByText('€18,750')).toBeVisible();
    });

    it('subtracts rent-paid-in-grain visibly, not as a footnote', () => {
        // netAssetPosition = standing + onHand − rentCostProduceValue, so
        // this 750 is already inside the headline. It used to appear only
        // as a note under a panel's cost breakdown, which put a term of
        // the arithmetic somewhere the arithmetic could not be read.
        setViewport('mobile');
        renderPage();

        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(within(sum).getByText(COPY.produceRentLabel)).toBeVisible();
        expect(within(sum).getByText('−€750')).toBeVisible();
    });

    it('omits the rent term entirely when no rent is paid in grain', () => {
        // A line reading "− €0" is ceremony: it states a term that is not
        // part of this farm's arithmetic.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow({ rentCostProduceKg: 0, rentCostProduceValue: 0 })] }));

        expect(screen.queryByText(COPY.produceRentLabel)).not.toBeInTheDocument();
    });

    // ─────────────────────────────────────────────────────────────────
    // ONE UNCERTAINTY VOCABULARY. The page spoke four dialects for "this
    // number is not what it appears" — an em-dash plus English for a
    // refusal, a badge for an allocation, a count for exclusions, a
    // header takeover for truncation. And the hero could be an UPPER
    // BOUND while printing as a definite figure, with the caveat two
    // surfaces below it.
    // ─────────────────────────────────────────────────────────────────

    it('changes the HERO’s claim when the cost is a floor, not just a footnote', () => {
        // THE DEFECT. `unvaluedNoUnitCost` makes cashCostTotal a floor,
        // which makes net worth a MAXIMUM. The old page printed €18,750
        // flat and put the explanation under a panel's cost line — a
        // qualifier on a different surface from the number it qualifies
        // is not a qualifier.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow({ unvaluedNoUnitCost: 2 })] }));

        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(
            within(sum).getByText(
                COPY.uncertaintyAtMost.replace('{value}', '€18,750'),
            ),
        ).toBeVisible();
        // The bare figure is NOT on screen as the headline claim.
        expect(within(sum).queryByText('€18,750')).not.toBeInTheDocument();
    });

    it('bounds the COST the other way — a floor is "at least"', () => {
        // Same cause, opposite direction: cost ≥ X ⇒ net ≤ assets − X.
        // Calling the floor "at most" would be plainly wrong.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow({ unvaluedUnitMismatch: 1 })] }));

        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(
            within(sum).getByText(
                COPY.uncertaintyAtLeast.replace('{value}', '−€5,500'),
            ),
        ).toBeVisible();
    });

    it('leaves an exact figure unqualified', () => {
        // The vocabulary has to be able to say nothing. If every figure
        // wore a hedge, none of them would carry information.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow()] }));

        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(within(sum).getByText('€18,750')).toBeVisible();
        expect(
            within(sum).queryByText(
                COPY.uncertaintyAtMost.replace('{value}', '€18,750'),
            ),
        ).not.toBeInTheDocument();
    });

    it('renders PARTIAL in its one treatment, and keeps the count at zero', () => {
        // Folded into the vocabulary, not replaced by it. The badge is the
        // shared PARTIAL marker; the count stays because "0 records
        // excluded" is a statement and an absent line is not.
        setViewport('mobile');
        const { unmount } = renderPage();
        expect(screen.getByText(COPY.uncertaintyPartialBadge)).toBeVisible();
        unmount();

        // Nothing excluded: no PARTIAL marker, but the count still states
        // itself — asserted in full by "still states the count when
        // nothing was excluded" above.
        renderPage(data({ exclusions: emptyExclusions() }));
        expect(screen.queryByText(COPY.uncertaintyPartialBadge)).not.toBeInTheDocument();
        expect(screen.getByText('0 records excluded')).toBeVisible();
    });

    it('renders ALLOCATED in its one treatment — badge plus sentence', () => {
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow({ payrollAllocated: true })] }));

        expect(screen.getByText(COPY.payrollAllocatedBadge)).toBeVisible();
        expect(screen.getByText(COPY.payrollAllocatedNote)).toBeVisible();
    });

    it('renders REFUSED in its one treatment — em-dash, named, explained', () => {
        setViewport('mobile');
        renderPage(data({ rows: [maizeRow()] }));

        const sum = screen.getByRole('group', { name: COPY.waterfallAria });
        // The RESULT's em-dash specifically. The two asset terms also show
        // one — maize has no price, so neither is valued — and that is
        // correct, which is why this cannot be a bare text query.
        expect(sum.querySelector('[data-metric-value="true"]')).toHaveTextContent('—');
        // Scoped for the same reason: the refusal wording is shared
        // vocabulary and any surface may legitimately repeat it, so the
        // assertion has to name which one it is about.
        expect(within(sum).getByText(COPY.netWorthUnavailableTitle)).toBeVisible();
        // TRANSLATED from the code, not the server's English.
        expect(
            screen.getByText(
                COPY.refusal.NO_MARKET_PRICE.replace('{commodity}', 'maize'),
            ),
        ).toBeVisible();
    });

    it('explains a refusal whose code this client has never heard of', () => {
        // The fallback, end to end. A newer server emits a code this
        // bundle does not know; the page must still say WHY rather than
        // show a bare em-dash. Unit-proven in
        // tests/unit/grain/uncertainty-vocabulary.test.ts; asserted here
        // through the render that actually depends on it.
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    maizeRow({
                        netWorthUnavailableCode: 'SOME_FUTURE_REASON',
                        netWorthUnavailableParams: null,
                        netWorthUnavailableReason:
                            'A reason this client cannot translate yet.',
                    }),
                ],
            }),
        );

        expect(
            screen.getByText('A reason this client cannot translate yet.'),
        ).toBeVisible();
    });

    // ─────────────────────────────────────────────────────────────────
    // THE FARM ANSWER. The page's docblock claims it answers "what is the
    // grain worth, after everything it cost me?" — and answered it per
    // COMMODITY, so a three-crop farm got three figures behind a toggle
    // and had to add them in its head.
    // ─────────────────────────────────────────────────────────────────

    it('answers for the whole FARM without touching the toggle', () => {
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow(),
                    wheatRow({ commodity: 'barley', netWorth: 5_000, cashCostTotal: 1_000 }),
                    wheatRow({ commodity: 'sunflower', netWorth: 3_250, cashCostTotal: 900 }),
                ],
            }),
        );

        // 18,750 + 5,000 + 3,250 = 27,000. Present on first paint, no
        // interaction — which is the whole complaint.
        expect(screen.getByText(COPY.farmTotalTitle)).toBeVisible();
        expect(screen.getByText('27,000 EUR')).toBeVisible();
    });

    it('shows no farm card for a single-crop farm', () => {
        // It would restate the commodity sum below it exactly. An
        // affordance that says nothing must not occupy space on a simple
        // farm — the same instinct the toggle already had.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow()] }));
        expect(screen.queryByText(COPY.farmTotalTitle)).not.toBeInTheDocument();
    });

    it('keeps currencies apart and says why, never summing them', () => {
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow(),
                    wheatRow({ commodity: 'barley', priceCurrency: 'BGN', netWorth: 4_000 }),
                ],
            }),
        );

        // Scoped to the farm card: the per-crop strip below legitimately
        // shows the same figures — with one crop per currency, each total
        // IS its crop's net — and that agreement is the point, not a
        // duplicate to assert around.
        const farmCard = screen.getByText(COPY.farmTotalTitle).closest('section')!;
        expect(within(farmCard).getByText('18,750 EUR')).toBeVisible();
        expect(within(farmCard).getByText('4,000 BGN')).toBeVisible();
        // No blended figure anywhere — 22,750 would reconcile against
        // nothing, since this product applies no exchange rate.
        expect(screen.queryByText(/22750/)).not.toBeInTheDocument();
        expect(screen.getByText(COPY.farmCurrencyNote)).toBeVisible();
    });

    it('names the commodities missing from the total, never going silently short', () => {
        // maize is REFUSED (no market price). Its standing crop is real,
        // but its cost cannot be subtracted, so folding its value in would
        // overstate the farm — and dropping it silently would report a
        // smaller number with nothing saying it is not the whole farm.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow(), maizeRow(), wheatRow({ commodity: 'barley', netWorth: 5_000 })] }));

        // One element, matched whole: "maize" alone also appears in the
        // comparison strip, which is a different claim on a different
        // surface.
        expect(
            screen.getByText(/1 commodity is not in this total:.*maize/i),
        ).toBeVisible();
    });

    it('bounds the FARM total when any contributing cost is a floor', () => {
        // Composed, not invented: one crop's unpriced consumption makes
        // the farm net a ceiling too.
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow({ unvaluedNoUnitCost: 2 }),
                    wheatRow({ commodity: 'barley', netWorth: 5_000 }),
                ],
            }),
        );

        expect(
            screen.getByText(COPY.uncertaintyAtMost.replace('{value}', '23,750 EUR')),
        ).toBeVisible();
    });

    // ─────────────────────────────────────────────────────────────────
    // DIAGNOSES BECOME DESTINATIONS. The only href in the whole feature
    // was the dashboard breadcrumb: nine named classes of excluded record
    // and no way to reach one. Knowing what is wrong never became fixing
    // it, which is the gap between an honest report and a tool.
    // ─────────────────────────────────────────────────────────────────

    it('gives EVERY exclusion class with entries somewhere to go', () => {
        // DERIVED from the class table, not nine hand-listed cases — a
        // tenth class added later without a destination must fail here,
        // and a hand-written list would simply not mention it.
        setViewport('mobile');
        renderPage(
            data({
                exclusions: {
                    plantingsMissingYieldEstimate: [ex('p-1')],
                    plantingsUnknownCommodity: [ex('p-2')],
                    lotsUnresolvedUnit: [ex('lot-1')],
                    lotsUnknownCommodity: [ex('lot-2')],
                    commoditiesWithNoPrice: [ex('maize')],
                    leasesUnresolvedRent: [ex('l-1')],
                    leasesUnattributed: [ex('l-2')],
                    leasesProduceRentUnpriced: [ex('l-3')],
                    payrollUnattributable: [ex('c-1')],
                },
            }),
        );

        // The accordion is `type="single"`, so only the OPEN item's content
        // is mounted — the destination lives with the entries it relates to,
        // which means opening each class in turn is what a farmer does and
        // what this asserts.
        const triggers = screen.getAllByRole('button', { name: /\(\d+\)$/ });
        expect(triggers.length).toBe(9); // every class has entries in this fixture

        const seen = new Set<string>();
        for (const trigger of triggers) {
            fireEvent.click(trigger);
            for (const a of Array.from(document.querySelectorAll('a[href^="/t/acme"]'))) {
                seen.add(a.getAttribute('href')!);
            }
        }

        // Every destination the TABLE declares was reachable. Derived, so a
        // tenth class added without one fails here.
        for (const path of EXCLUSION_CLASS_DESTINATIONS) {
            expect(seen).toContain(`/t/acme${path}`);
        }
        // Non-trivial — a table that lost its destinations would make the
        // loop above vacuously true.
        expect(EXCLUSION_CLASS_DESTINATIONS.length).toBeGreaterThanOrEqual(4);
    });

    it('deep-links a LOT to its own detail, the one entry type that supports it', () => {
        // /inventory?lotId opens that lot's modal — an affordance built for
        // QR codes. /rent takes a locationId and /planning a cropPlanId,
        // neither of which these entries carry, so those stay class-level.
        setViewport('mobile');
        renderPage(
            data({
                exclusions: {
                    ...emptyExclusions(),
                    lotsUnresolvedUnit: [ex('lot-42', 'Ечемик, склад 2 (bag)')],
                },
            }),
        );

        fireEvent.click(screen.getByRole('button', { name: /\(1\)$/ }));
        expect(
            document.querySelector('a[href="/t/acme/inventory?lotId=lot-42"]'),
        ).not.toBeNull();
    });

    it('offers a way out of the empty state, not just a precondition', () => {
        setViewport('mobile');
        renderPage(data({ rows: [] }));

        const action = screen.getByText(COPY.emptyAction);
        expect(action).toBeVisible();
        expect(action.closest('a')).toHaveAttribute('href', '/t/acme/planning');
    });

    it('links a FIXABLE refusal, and leaves an unfixable one explanatory', () => {
        setViewport('mobile');
        // NO_MARKET_PRICE is fixable — prices live on /trends.
        renderPage(data({ rows: [maizeRow()] }));
        expect(
            document.querySelector('a[href="/t/acme/trends"]'),
        ).not.toBeNull();

        // A mixed cost currency is NOT: it needs an FX rate this product
        // deliberately does not have. Offering a destination that cannot
        // resolve the cause would be worse than the plain explanation.
        renderPage(
            data({
                rows: [
                    maizeRow({
                        netWorthUnavailableCode: 'MIXED_COST_CURRENCY',
                        netWorthUnavailableParams: null,
                        netWorthUnavailableReason: 'Costs in more than one currency.',
                    }),
                ],
            }),
        );
        expect(screen.getAllByText(COPY.refusal.MIXED_COST_CURRENCY).length).toBeGreaterThan(0);
    });

    it('shows NAMES in the accordion, never a raw database id', () => {
        // Open "3 plantings missing a yield estimate" and you used to get
        // three cuids in a monospace list — no parcel, no crop, nothing a
        // person can recognise. The count was honest; the detail was
        // decoration.
        setViewport('mobile');
        renderPage();

        // The accordion is `type="single"`, so only the item just clicked
        // is mounted — the text has to be gathered as each opens, not read
        // once at the end when eight of the nine have closed again.
        let seen = '';
        for (const trigger of screen.getAllByRole('button', { name: /\(\d+\)$/ })) {
            fireEvent.click(trigger);
            seen += document.body.textContent ?? '';
        }

        // A cuid is 25 lowercase alphanumerics starting `c`. None should
        // reach the page for records that resolved to a name.
        expect(seen).not.toMatch(/\bc[a-z0-9]{24}\b/);
        expect(seen).toContain('Нива 3 · Пшеница');
        expect(seen).toContain('Иван Петров · Нива 7');
    });

    it('falls back to the id rather than an empty bullet', () => {
        // A record deleted between the read and the label, or beyond a
        // TAKE cap. A blank bullet loses even the count.
        setViewport('mobile');
        renderPage(
            data({
                exclusions: {
                    ...emptyExclusions(),
                    plantingsMissingYieldEstimate: [ex('cmslvwqsj0000j44se0pwtxns')],
                },
            }),
        );

        fireEvent.click(screen.getByRole('button', { name: /\(1\)$/ }));
        expect(screen.getByText('cmslvwqsj0000j44se0pwtxns')).toBeVisible();
    });

    it('renders entries as prose, not as machine identifiers', () => {
        // Monospace signals "this is an id". These have stopped being ids.
        setViewport('mobile');
        const { container } = renderPage();
        fireEvent.click(screen.getAllByRole('button', { name: /\(\d+\)$/ })[0]);
        expect(container.querySelector('.font-mono')).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────
    // THE SHAPE OF THE FARM. commodityOptions fed a ToggleGroup, so a
    // five-crop farm saw ONE crop at a time and could not answer "which
    // crop is carrying this farm?" without stepping through them.
    // ─────────────────────────────────────────────────────────────────

    const threeCrops = () =>
        data({
            rows: [
                wheatRow(),
                wheatRow({ commodity: 'barley', netWorth: 5_000 }),
                wheatRow({ commodity: 'sunflower', netWorth: 30_000 }),
            ],
        });

    it.each(['mobile', 'desktop'] as const)(
        'compares every crop without interacting — %s',
        (viewport) => {
            // BOTH viewports, named. jsdom answers matches:false to every
            // query so the default is a phone; the desktop case has to be
            // asked for or it is never executed.
            setViewport(viewport);
            renderPage(threeCrops());

            const strip = screen.getByLabelText(COPY.comparisonAria);
            // All three present on first paint, no clicks.
            expect(within(strip).getAllByRole('button')).toHaveLength(3);
            expect(within(strip).getByText('30,000 EUR')).toBeVisible();
            expect(within(strip).getByText('18,750 EUR')).toBeVisible();
            expect(within(strip).getByText('5,000 EUR')).toBeVisible();
        },
    );

    it('orders by contribution, biggest first, and says so', () => {
        setViewport('desktop');
        renderPage(threeCrops());

        const strip = screen.getByLabelText(COPY.comparisonAria);
        const amounts = within(strip)
            .getAllByRole('button')
            .map((b) => b.textContent);
        expect(amounts[0]).toContain('30,000');
        expect(amounts[1]).toContain('18,750');
        expect(amounts[2]).toContain('5,000');
        expect(screen.getByText(COPY.comparisonOrderNote)).toBeVisible();
    });

    it('gives a single-crop farm neither toggle nor comparison furniture', () => {
        // A simpler farm should see a simpler page, not the same page with
        // empty affordances — the instinct the ToggleGroup already had.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow()] }));

        expect(screen.queryByLabelText(COPY.comparisonAria)).not.toBeInTheDocument();
        expect(screen.queryByText(COPY.comparisonTitle)).not.toBeInTheDocument();
    });

    it('carries uncertainty into the compact view, where it most easily lies', () => {
        // A refused net and a bounded net rendered as bare figures sit in
        // the same column as exact ones and invite exactly the comparison
        // they cannot support.
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow({ unvaluedNoUnitCost: 2 }),
                    maizeRow(),
                    wheatRow({ commodity: 'barley', netWorth: 5_000 }),
                ],
            }),
        );

        const strip = screen.getByLabelText(COPY.comparisonAria);
        // AT_MOST rides the value, exactly as it does on the headline.
        expect(
            within(strip).getByText(COPY.uncertaintyAtMost.replace('{value}', '18,750 EUR')),
        ).toBeVisible();
        // REFUSED shows the em-dash, never a bare number that looks
        // comparable — and sorts last, having no figure to rank.
        const rows_ = within(strip).getAllByRole('button');
        expect(rows_[rows_.length - 1].textContent).toContain('—');
    });

    it('selecting a crop expands it below', () => {
        setViewport('mobile');
        renderPage(threeCrops());

        const strip = screen.getByLabelText(COPY.comparisonAria);
        const barley = within(strip)
            .getAllByRole('button')
            .find((b) => /barley/i.test(b.textContent ?? ''))!;
        fireEvent.click(barley);
        expect(barley).toHaveAttribute('aria-pressed', 'true');
    });

    // ─────────────────────────────────────────────────────────────────
    // PER DECARE — the unit a Bulgarian farmer plans in.
    // ─────────────────────────────────────────────────────────────────

    it('states the standing-crop margin per dca', () => {
        setViewport('mobile');
        // 12.5 ha = 125 dca; (15,000 − 5,500) / 125 = 76.
        renderPage(data({ rows: [wheatRow()] }));

        expect(screen.getByText(COPY.marginPerDcaLabel)).toBeVisible();
        expect(
            screen.getByText(COPY.marginPerDcaValue.replace('{value}', '76 EUR')),
        ).toBeVisible();
    });

    it('never presents it as net worth per dca', () => {
        // netWorth/area would be 18,750/125 = 150. That number must not
        // appear: net worth carries grain in store, which has no area.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow()] }));
        expect(screen.queryByText(/150 EUR \/ dca/)).not.toBeInTheDocument();
        expect(screen.getByText(COPY.marginPerDcaHint)).toBeVisible();
    });

    it('carries AT_MOST into the per-dca figure when the cost is a floor', () => {
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow({ unvaluedNoUnitCost: 2 })] }));

        expect(
            screen.getByText(
                COPY.uncertaintyAtMost.replace(
                    '{value}',
                    COPY.marginPerDcaValue.replace('{value}', '76 EUR'),
                ),
            ),
        ).toBeVisible();
    });

    it('states WHICH denominator was missing rather than printing a dash', () => {
        // A commodity only in store: real value, no standing-crop area.
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow({
                        standingCropAreaHa: 0,
                        standingCropExpectedKg: 0,
                        standingCropValue: 0,
                    }),
                ],
            }),
        );

        // Scoped to the answer card: the margin comparison below now names
        // the same refusal for the same crop, which is the point of it —
        // an undrawable crop is listed there rather than vanishing. Two
        // surfaces stating one refusal is agreement, not duplication.
        const answer = screen.getByRole('group', { name: COPY.waterfallAria });
        expect(within(answer).getByText(COPY.perAreaNoArea)).toBeVisible();
    });

    // ─────────────────────────────────────────────────────────────────
    // BREAK-EVEN COVER. ProgressBar per the platform decision table — a
    // single value advancing toward a max, where the max is the price
    // that clears cost. The appendix table was deleted to pay for it, so
    // the text beside each bar is now the ONLY text equivalent.
    // ─────────────────────────────────────────────────────────────────

    /** The cover bars only — not the cost-breakdown bars beside them. */
    const coverBars = () => screen.queryAllByRole('progressbar', { name: /of break-even/ });

    const mixedCrops = () =>
        data({
            rows: [
                // 60 t, cost 5,500 ⇒ break-even 91.67; market 250 ⇒ 273%
                wheatRow(),
                // 60 t, cost 30,000 ⇒ break-even 500; market 250 ⇒ 50%
                wheatRow({ commodity: 'barley', cashCostTotal: 30_000, netWorth: -5_000 }),
            ],
        });

    it('shows the cover for a SINGLE-crop farm, which has nothing to compare', () => {
        // The comparison strip is suppressed below two crops. The cover is
        // not a comparison — for a monoculture it is the whole question.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow()] }));
        expect(coverBars()).toHaveLength(1);
        expect(screen.getByText(/273% — covers cost/)).toBeVisible();
    });

    it('shows cover as a bar AND as text, so the visual is not the only reading', () => {
        setViewport('mobile');
        renderPage(mixedCrops());

        // A real ProgressBar per crop. Queried BY NAME, not by role alone:
        // the cost-breakdown bars are progressbars too, and a bare role
        // query would count them and pass for the wrong reason.
        expect(coverBars()).toHaveLength(2);

        // The text equivalent: percentage, verdict and both prices. This
        // is what a screen reader gets, and since the appendix table is
        // gone it is the only thing that conveys the ranking.
        expect(screen.getByText(/273% — covers cost/)).toBeVisible();
        expect(screen.getByText(/50% — short of cost/)).toBeVisible();
    });

    it('distinguishes a covered crop from one short of cost', () => {
        setViewport('mobile');
        renderPage(mixedCrops());
        expect(screen.getByText(/covers cost/)).toBeVisible();
        expect(screen.getByText(/short of cost/)).toBeVisible();
    });

    it('marks an AT_LEAST crop as bounded, in the text as well as the bar', () => {
        // An unpriced consumption understates the cost, so it understates
        // the price needed to clear it — the true cover is this or LOWER.
        // Note the bound does NOT invert here, unlike the per-dca margin.
        setViewport('mobile');
        renderPage(
            data({
                rows: [wheatRow({ unvaluedNoUnitCost: 2 }), wheatRow({ commodity: 'barley' })],
            }),
        );
        expect(screen.getByText(/at least 273%/)).toBeVisible();
    });

    it('gives a REFUSED crop no bar at all, and names why', () => {
        // Not a zero-length bar — that would sit in the comparison looking
        // like a crop that covers nothing, which is a different claim from
        // "we could not work it out".
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow(), maizeRow()] }));

        // maize has no market price.
        expect(screen.getByText(COPY.breakEvenNoPrice)).toBeVisible();
        // One cover bar, for wheat — not two.
        expect(coverBars()).toHaveLength(1);
    });

    it('puts no currency on the shared scale', () => {
        // The bar plots a RATIO, which is dimensionless — both sides of
        // market/break-even are in the same currency by construction. So a
        // EUR crop and a BGN crop are comparable without blending, and the
        // money beside each carries its OWN code.
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow(),
                    wheatRow({ commodity: 'barley', priceCurrency: 'BGN', netWorth: 4_000 }),
                ],
            }),
        );

        expect(screen.getByText(/250 EUR market/)).toBeVisible();
        expect(screen.getByText(/250 BGN market/)).toBeVisible();
        // Both cover bars are on the same 0-100 percent scale, carrying no
        // currency at all — so nothing is blended by putting them side by
        // side. The true figure survives the clamp in `aria-valuetext`.
        const bars = coverBars();
        expect(bars).toHaveLength(2);
        for (const bar of bars) {
            expect(bar.getAttribute('aria-valuemax')).toBe('100');
        }
    });

    // ─────────────────────────────────────────────────────────────────
    // MARGIN PER DECARE. The second visual, kept BESIDE cover rather than
    // replacing it: cover ranks by return on the money spent, this by
    // return on the land used, and on a farm where land is the scarce
    // input they are two real answers that can disagree.
    //
    // wheatRow: 125 dca, value 15,000, cost 5,500 ⇒ +76/dca.
    // ─────────────────────────────────────────────────────────────────

    /** The bars are decorative, so they are NOT in the accessibility tree. */
    const marginBars = () => Array.from(document.querySelectorAll('[role="meter"]'));

    const lossRow = (over: Partial<CalculatorRow> = {}) =>
        // 125 dca, value 1,000, cost 15,000 ⇒ −112/dca.
        wheatRow({
            commodity: 'barley',
            standingCropValue: 1_000,
            cashCostTotal: 15_000,
            netWorth: -4_000,
            ...over,
        });

    it('shows a loss as a loss, signed, and never floored to zero', () => {
        // The defect that forced a new primitive: ProgressBar floors a
        // negative to 0 before it computes anything, so a losing crop
        // would have rendered exactly like one that broke even.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow(), lossRow()] }));

        expect(screen.getByText('+76 EUR/dca')).toBeVisible();
        expect(screen.getByText('\u2212112 EUR/dca')).toBeVisible();

        const signs = marginBars().map((b) => b.getAttribute('data-sign'));
        expect(signs).toContain('positive');
        expect(signs).toContain('negative');
    });

    it('prints the axis, because bar lengths mean nothing without it', () => {
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow(), lossRow()] }));

        // Scale is the largest MAGNITUDE in the group — the 112 loss, not
        // the 76 profit — so the loss sits on-axis instead of past its end.
        expect(screen.getByText('\u2212112 EUR')).toBeVisible();
        expect(screen.getByText('+112 EUR')).toBeVisible();
        expect(screen.getByText(COPY.marginScaleZero)).toBeVisible();
    });

    it('never puts two currencies on one scale', () => {
        setViewport('mobile');
        renderPage(
            data({
                rows: [
                    wheatRow(),
                    lossRow(),
                    // 125 dca, value 40,000, cost 15,000 ⇒ +200 BGN/dca.
                    wheatRow({
                        commodity: 'rapeseed',
                        priceCurrency: 'BGN',
                        standingCropValue: 40_000,
                        cashCostTotal: 15_000,
                        netWorth: 20_000,
                    }),
                    // A second BGN crop, so that group is comparable too and
                    // both axes get drawn. 125 dca, 20,000 − 15,000 ⇒ +40.
                    wheatRow({
                        commodity: 'sunflower',
                        priceCurrency: 'BGN',
                        standingCropValue: 20_000,
                        cashCostTotal: 15_000,
                        netWorth: 5_000,
                    }),
                ],
            }),
        );

        // Two axes, each ending at its OWN group maximum. If the BGN 200
        // had stretched the EUR axis, this EUR end would read 200.
        expect(screen.getByText('+112 EUR')).toBeVisible();
        expect(screen.getByText('+200 BGN')).toBeVisible();
        expect(screen.getByText('+200 BGN/dca')).toBeVisible();
    });

    it('withholds the bars when a single crop would only measure itself', () => {
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow()] }));

        expect(marginBars()).toHaveLength(0);
        expect(screen.getByText(COPY.marginScaleTooFew)).toBeVisible();
        // The figure itself is NOT withheld — only the comparison is.
        expect(screen.getByText('+76 EUR/dca')).toBeVisible();
    });

    it('names a crop that has no currency instead of dropping it', () => {
        // maize has no market price, so there is no axis it could sit on.
        // A comparison that quietly shrinks describes a smaller farm.
        setViewport('mobile');
        renderPage();
        expect(screen.getByText(/Not on any scale, for want of a market price/)).toBeVisible();
    });

    it('marks a bounded margin as a ceiling, not a figure', () => {
        setViewport('mobile');
        renderPage(
            data({ rows: [wheatRow({ unvaluedNoUnitCost: 2 }), lossRow()] }),
        );
        // Cost understated ⇒ margin overstated ⇒ the margin is a ceiling.
        expect(screen.getByText(/at most \+76 EUR\/dca/)).toBeVisible();
    });

    it('states that cover and margin rank crops differently', () => {
        // Two visuals that order the same crops differently must say why,
        // or the page gives two confident answers to one question.
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow(), lossRow()] }));
        expect(screen.getByText(COPY.marginScaleVsCover)).toBeVisible();
    });

    it('announces each crop once — the bar is decorative, the text is the record', () => {
        setViewport('mobile');
        renderPage(data({ rows: [wheatRow(), lossRow()] }));

        // Present in the DOM as a visual...
        expect(marginBars().length).toBeGreaterThan(0);
        // ...and absent from the accessibility tree, because every figure
        // it encodes is already printed as text beside it.
        expect(screen.queryAllByRole('meter')).toHaveLength(0);
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
        //
        // The sentinel no longer reaches this island at all: page.tsx
        // filters it and hands over `costCurrencyCodes` plus a boolean, so
        // the fixture states what the server would state. That IS the fix
        // — the island cannot print a sentinel it is never given — and the
        // assertion stays because the wording it guards is still ours.
        renderPage(
            data({
                rows: [
                    wheatRow({
                        costBreakdown: [
                            { id: 'field', labelKey: 'costFieldLabel', value: 4_000, variant: 'brand' },
                            { id: 'rent', labelKey: 'costRentLabel', value: 300, variant: 'warning' },
                            { id: 'payroll', labelKey: 'costPayrollLabel', value: 1_500, variant: 'info' },
                        ],
                        costCurrencyCodes: ['EUR'],
                        rentCurrencyUnknown: true,
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
                rows: [wheatRow({ priceCurrency: null, costCurrencyCodes: [] })],
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
        // `/unvalued consumption/`, not `/farm-wide/`. The looser matcher
        // was standing in for the `unvaluedFarmWide` string and started
        // catching the per-dca hint, which says "farm-wide overhead" for
        // an unrelated and accurate reason. A matcher broad enough to hit
        // innocent copy tests the copy, not the behaviour.
        expect(screen.queryByText(/unvalued consumption/)).not.toBeInTheDocument();
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
