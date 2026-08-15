'use client';

/**
 * Grain calculator — client island for the `GRAIN_NET_WORTH` report.
 *
 * ── What this page is ───────────────────────────────────────────────
 *
 * The only surface in the product that answers "what is the grain
 * worth, after everything it cost me?". It renders `getGrainNetWorth`'s
 * output verbatim — every figure below arrives pre-computed from
 * `src/app-layer/usecases/grain-net-worth.ts`; this island formats and
 * arranges, it never re-derives a cost, a yield or a price.
 *
 * ── Why the total differs from /grain/costs ─────────────────────────
 *
 * `GRAIN_NET_WORTH` is the FOURTH named cost metric (see
 * `src/lib/grain/cost-metrics.ts`) and the first to include overheads:
 * land rent and payroll, on top of the attributed field/stock cost it
 * reuses verbatim from `ATTRIBUTED_CROP_COST`. So the cost total here
 * is *meant* to be larger than the one on /grain/costs for the same
 * season. The metric is NAMED in the page eyebrow and the divergence is
 * stated in the header description, because a farmer who sees two
 * different cost numbers must be able to tell why without guessing that
 * one of them is broken.
 *
 * ── One sum, read down a column ─────────────────────────────────────
 *
 * The page used to render two side-by-side panels — standing crop
 * (EXPECTED) and grain on hand (ACTUAL) — each ending in its own net
 * line, plus a sentence explaining that the two nets could not be
 * added. They could not, because the usecase attributes cost per
 * COMMODITY rather than per growing-vs-stored, so BOTH panels charged
 * the same `cashCostTotal`: each "net" was the whole farm cost taken off
 * one asset, a quantity nobody can act on.
 *
 * Two panels each ending in a total is the universal idiom for "these
 * sum". A prose disclaimer cannot beat a layout, so the layout changed.
 *
 * What replaced it is the arithmetic the usecase actually performs,
 * written out — because it composes exactly, term for term:
 *
 *     + standing crop value        (expected)
 *     + grain on hand value        (actual)
 *     − rent paid in grain         (netAssetPosition)
 *     − total farm cost
 *     = net worth
 *
 * The third line is the one the old layout lost. `netAssetPosition` is
 * `standing + onHand − rentCostProduceValue`, so grain owed to a
 * landlord is already subtracted inside the headline — yet it appeared
 * only as a footnote under a panel's cost breakdown, which put a term of
 * the sum somewhere the sum could not be read. It is a line now.
 *
 * One cost, stated once. One net, stated once.
 *
 * ── Where the refusals show up ──────────────────────────────────────
 *
 *   • `netWorth === null` → the summary card renders
 *     `netWorthUnavailableReason` (a stated refusal — never a blank or
 *     a zero), and the sum's result line carries the em-dash instead of
 *     a figure.
 *     The reason string is authored server-side and is English today;
 *     it is surfaced verbatim rather than dropped, because a missing
 *     explanation is worse than an untranslated one.
 *   • `payrollAllocated` → an "Allocated" badge plus a sentence, so an
 *     allocation by area share is never read as a measurement.
 *   • Exclusions → a VISIBLE count (rendered even at zero) with an
 *     accordion listing every named class and the ids inside it.
 *   • `truncated` → replaces the header description, because a caveat
 *     nobody reads is not a caveat.
 *
 * ── Areas ───────────────────────────────────────────────────────────
 *
 * Storage stays hectares (`standingCropAreaHa`); DISPLAY is decares via
 * `haToDca`, the unit Bulgarian farmers actually use.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/layout/PageHeader';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Heading, TextLink } from '@/components/ui/typography';
import { StatusBreakdown, type StatusBreakdownItem } from '@/components/ui/status-breakdown';
import { EmptyState } from '@/components/ui/empty-state';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { KPIStat } from '@/components/ui/metric';
import { useTenantHref, useExactMoneyFormatter } from '@/lib/tenant-context-provider';
import {
    COST_METRICS,
    COST_METRIC_LABEL_KEYS,
    UNKNOWN_RENT_CURRENCY,
} from '@/lib/grain/cost-metrics';
import { haToDca } from '@/lib/agro/rate-calc';
import { formatDecimal } from '@/lib/number-format';
import { formatDate, formatDateTime } from '@/lib/format-date';
import {
    UNCERTAINTY,
    explainRefusal,
    type UncertaintyState,
} from '@/lib/grain/uncertainty';
import { GrainSectionNav } from '../GrainSectionNav';
import type { FarmNetWorthTotal } from '@/lib/grain/farm-total';
import type { ExclusionEntry } from '@/lib/grain/exclusion-labels';
import type { PerAreaFigures } from '@/lib/grain/per-area';
import type { BreakEvenFigures } from '@/lib/grain/break-even';
import {
    BreakEvenRow,
    CommodityStrip,
    ExclusionsCard,
    MarginPerDcaCard,
    SumLine,
} from './components';
import { foldMarginScales } from '@/lib/grain/margin-scale';

// ─── Serialised DTOs (mirror the grain-net-worth usecase output) ────

export interface CalculatorRow {
    commodity: string;

    pricePerTonne: number | null;
    priceCurrency: string | null;
    priceObservedAt: string | null;
    priceSource: string | null;

    standingCropAreaHa: number;
    standingCropExpectedKg: number;
    standingCropValue: number | null;
    /** Per-decare figures over the terms that share this area. */
    perArea: PerAreaFigures;
    /** Market price against the price that clears cost. */
    breakEven: BreakEvenFigures;

    grainOnHandTonnes: number;
    grainOnHandValue: number | null;

    rentCostProduceKg: number;
    rentCostProduceValue: number | null;
    payrollAllocated: boolean;
    cashCostTotal: number;

    // Rendered with their COUNTS by UnvaluedNote, so they stay data rather
    // than collapsing into `costUncertainty` — the state says the cost is
    // a floor, these say by how many records and why.
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;

    netWorth: number | null;
    /** English, authored by the usecase — the FALLBACK for an unknown code. */
    netWorthUnavailableReason: string | null;
    /** Machine-readable reason, translated client-side when recognised. */
    netWorthUnavailableCode: string | null;
    netWorthUnavailableParams: Record<string, string> | null;

    // ── Decided server-side (see page.tsx) ──
    //
    // The row used to carry thirty fields shaped by what the USECASE
    // computes, and this island assembled an answer out of them: it
    // filtered the rent sentinel out of a currency list, worked out
    // whether the cost was a floor, worked out whether the rent term
    // belonged on screen. Those are decisions, and they are made where the
    // data is now. What arrives is an answer to FORMAT.

    /** Shared vocabulary — see `@/lib/grain/uncertainty`. */
    netUncertainty: UncertaintyState;
    costUncertainty: UncertaintyState;
    /** Real ISO codes only; the internal rent sentinel is already gone. */
    costCurrencyCodes: string[];
    /** True when rent currency was the sentinel — stated in its own words. */
    rentCurrencyUnknown: boolean;
    /** Whether the rent-in-grain term is part of this farm's arithmetic. */
    showProduceRent: boolean;
    /** The cost's composition — which categories, in what order and tone. */
    costBreakdown: CalculatorCostSlice[];
}

/** One labelled slice of the cost total, decided server-side. */
export interface CalculatorCostSlice {
    id: string;
    /** i18n key under `grain.calculator` — the island resolves it. */
    labelKey: string;
    value: number;
    variant: StatusBreakdownItem['variant'];
}

export type { ExclusionEntry } from '@/lib/grain/exclusion-labels';

/**
 * ONE shape for every class.
 *
 * It used to be three — a bare string, `{lotId, unitKey}`,
 * `{leaseId, reason}` — which forced the renderer to branch on structure
 * to work out what it was holding, and rendered a cuid either way. Each
 * entry now carries the id (the deep links need it) and a label a person
 * recognises, resolved server-side.
 */
export interface CalculatorExclusions {
    plantingsMissingYieldEstimate: ExclusionEntry[];
    plantingsUnknownCommodity: ExclusionEntry[];
    lotsUnresolvedUnit: ExclusionEntry[];
    lotsUnknownCommodity: ExclusionEntry[];
    commoditiesWithNoPrice: ExclusionEntry[];
    leasesUnresolvedRent: ExclusionEntry[];
    leasesUnattributed: ExclusionEntry[];
    leasesProduceRentUnpriced: ExclusionEntry[];
    payrollUnattributable: ExclusionEntry[];
}

/** One currency's worth of money that left the bank. */
export interface CalculatorCashOutLine {
    currency: string;
    amount: number;
    categories: string[];
}

export interface CalculatorData {
    generatedAt: string;
    seasonId: string | null;
    rows: CalculatorRow[];
    /** The farm-level answer — one total per currency. Folded server-side. */
    farm: {
        totals: FarmNetWorthTotal[];
        refusedWithoutCurrency: string[];
    };
    exclusions: CalculatorExclusions;
    /**
     * Farm-wide DISTINCT counts, NOT the sum of the rows'. Deliberately
     * not an exclusion class: nothing here was excluded — the stock moved
     * and the planting is counted, only the money is missing. Exclusions
     * shrink the row set; this understates the cost side.
     */
    unvalued: { noUnitCost: number; unitMismatch: number };
    /**
     * `COST_METRICS.GRAIN_CASH_OUT` — what LEFT THE BANK, per currency.
     *
     * Rendered as its own figure and never added to any cost line. Crop
     * cost is consumption-based and rent cost is a lease-terms accrual, so
     * folding a purchase or a rent payment in would bill the same money
     * twice. The page's job is to show both and say they are different
     * questions.
     */
    cashOut: CalculatorCashOutLine[];
    /**
     * Cost that landed on land carrying no crop — a fallow parcel's share
     * of a spread cost, and money rent on an unplanted parcel.
     *
     * Rendered BECAUSE the rows are short by exactly this. A spread
     * conserves the amount across `rows + this`, so a page printing only
     * the rows would show a cost that shrank when the farmer changed how
     * it spreads — the one thing the allocator promises never happens.
     */
    unallocatedToCrop: {
        amount: number;
        areaHa: number;
        parcelIds: string[];
        currencies: string[];
    };
    /**
     * `COST_METRICS.IMPUTED_LAND_CHARGE` — what the farm's OWN land would
     * fetch as rent, at the rate its own leases establish.
     *
     * Beside the cost side and never inside it: no lev left the bank, and
     * every cost figure on this page is money that did. Refused rather
     * than zeroed when there is no observed rate, because a zero says
     * owned land is free.
     */
    imputedLandCharge: {
        perHa: number | null;
        areaHa: number;
        totalAmount: number | null;
        refusalCode: string | null;
    };
    truncated: boolean;
}

export interface CalculatorClientProps {
    tenantSlug: string;
    data: CalculatorData;
}

/**
 * The nine named exclusion classes, in the order a reader triages them:
 * what was dropped from the ASSET side first, then from the COST side.
 * Every class in `GrainNetWorthExclusions` appears here — the whole
 * point of the usecase returning counts is that the page shows them.
 */
/**
 * Every exclusion class, and WHERE A FARMER FIXES IT.
 *
 * The page diagnosed precisely and then stranded the reader: nine named
 * classes of excluded record and no way to reach one. Knowing what is
 * wrong never became fixing it, which is the difference between an honest
 * report and a tool.
 *
 * `destination` is REQUIRED, not optional. A new class added without one
 * fails to compile, and the rendered test derives its assertions from this
 * table rather than listing nine cases — so a tenth class cannot ship
 * silently linkless.
 *
 * ── What these paths are, and are not ───────────────────────────────
 *
 * Only lots support a per-ENTRY deep link. `/inventory?lotId=` opens that
 * lot's detail modal — an affordance built for QR codes on lots, verified
 * present in InventoryClient. The others are LIST destinations, and that
 * is a finding rather than laziness:
 *
 *   • `/rent` reads `?locationId`, not a lease id; these entries carry
 *     lease ids, so a deep link would silently ignore the parameter.
 *   • `/planning`'s only detail route is `[cropPlanId]` — a crop PLAN.
 *     These entries carry planting ids, which is a different thing.
 *   • `/trends` and `/grain/costs` read no query parameters at all.
 *
 * A link that appears to target a record and lands on an unfiltered list
 * is worse than one that plainly says "Open Rent", so these say that.
 */
const EXCLUSION_CLASSES: ReadonlyArray<{
    key: keyof CalculatorExclusions;
    labelKey: string;
    destination: { path: string; labelKey: string };
}> = [
    { key: 'plantingsMissingYieldEstimate', labelKey: 'exclPlantingsMissingYieldEstimate', destination: { path: '/planning', labelKey: 'exclFixPlanning' } },
    { key: 'plantingsUnknownCommodity', labelKey: 'exclPlantingsUnknownCommodity', destination: { path: '/planning', labelKey: 'exclFixPlanning' } },
    { key: 'lotsUnresolvedUnit', labelKey: 'exclLotsUnresolvedUnit', destination: { path: '/inventory', labelKey: 'exclFixInventory' } },
    { key: 'lotsUnknownCommodity', labelKey: 'exclLotsUnknownCommodity', destination: { path: '/inventory', labelKey: 'exclFixInventory' } },
    { key: 'commoditiesWithNoPrice', labelKey: 'exclCommoditiesWithNoPrice', destination: { path: '/trends', labelKey: 'exclFixTrends' } },
    { key: 'leasesUnresolvedRent', labelKey: 'exclLeasesUnresolvedRent', destination: { path: '/rent', labelKey: 'exclFixRent' } },
    { key: 'leasesUnattributed', labelKey: 'exclLeasesUnattributed', destination: { path: '/rent', labelKey: 'exclFixRent' } },
    // /rent, NOT /trends. The missing PRICE is the proximate cause, but a
    // farmer cannot add one — market prices arrive from EC and the World
    // Bank, and a hand-typed price is a platform-admin action. What they
    // CAN change is the lease: rent recorded in money instead of grain
    // values without a market price at all. The price side is already
    // reachable from commoditiesWithNoPrice above.
    { key: 'leasesProduceRentUnpriced', labelKey: 'exclLeasesProduceRentUnpriced', destination: { path: '/rent', labelKey: 'exclFixRent' } },
    { key: 'payrollUnattributable', labelKey: 'exclPayrollUnattributable', destination: { path: '/grain/costs', labelKey: 'exclFixCosts' } },
];

/**
 * Every DISTINCT destination the exclusion table declares.
 *
 * Exported so a test can derive its assertions from the table instead of
 * restating nine cases — a tenth class added without a destination then
 * fails, where a hand-written list would simply not mention it.
 */
export const EXCLUSION_CLASS_DESTINATIONS: readonly string[] = [
    ...new Set(EXCLUSION_CLASSES.map((c) => c.destination.path)),
];

/**
 * The unvalued-consumption caveat, rendered under a panel's cost total.
 *
 * Deliberately NOT a tenth exclusion class. The accordion below is titled
 * "Excluded from these figures" and counts "records excluded" — and none
 * of these were excluded. The stock moved, the planting is counted; only
 * the money is missing. Filing it there would make the exclusion count
 * mean two different things at once.
 *
 * It also matters WHICH WAY the error runs. Every exclusion class shrinks
 * what is counted. This one leaves the cost side short, so the net worth
 * above reads HIGH — the one direction a farmer must not be allowed to
 * take on trust. Hence "a floor, not a total" rather than a neutral note.
 */
function UnvaluedNote({
    noUnitCost,
    unitMismatch,
}: {
    noUnitCost: number;
    unitMismatch: number;
}) {
    const tc = useTranslations('grain.calculator');
    const total = noUnitCost + unitMismatch;
    if (total === 0) return null;

    return (
        <div className="space-y-tight border-t border-border-subtle pt-2">
            <p className="text-xs text-content-attention">
                {tc('unvaluedPanelNote', { count: total })}
            </p>
            <ul className="space-y-tight text-xs text-content-muted">
                {noUnitCost > 0 && (
                    <li>{tc('unvaluedReasonNoUnitCost', { count: noUnitCost })}</li>
                )}
                {unitMismatch > 0 && (
                    <li>{tc('unvaluedReasonUnitMismatch', { count: unitMismatch })}</li>
                )}
            </ul>
        </div>
    );
}


export function CalculatorClient({ tenantSlug, data }: CalculatorClientProps) {
    const t = useTranslations('grainEnums');
    const tc = useTranslations('grain.calculator');
    const tCommodity = useTranslations('trends.commodities');
    const tenantHref = useTenantHref();

    // EXACT, not compact. Every figure on this page is one a farmer
    // reconciles against an invoice, a lease or a grain ticket, so the
    // cents are load-bearing — `useMoneyFormatter` would round €18,750
    // to €19K. The formatter uses the TENANT's configured symbol because
    // `Tenant.currencySymbol` is a SYMBOL and the recorded currencies are
    // ISO CODES, with no mapping and no FX table anywhere in the product.
    // The codes themselves are surfaced on the currency-basis line, so
    // nothing is hidden — they are simply not pretended to be a symbol.
    const money = useExactMoneyFormatter();

    const commodityLabel = useCallback(
        (slug: string) => (tCommodity.has(slug) ? tCommodity(slug) : slug),
        [tCommodity],
    );

    const rows = data.rows;
    const [selected, setSelected] = useState<string>(rows[0]?.commodity ?? '');
    const row = rows.find((r) => r.commodity === selected) ?? rows[0] ?? null;


    // ── Exclusions: a COUNT, always shown, never a silent zero ──
    const exclusionClasses = useMemo(
        () =>
            EXCLUSION_CLASSES.map((cls) => ({
                ...cls,
                entries: (data.exclusions[cls.key] ?? []) as ExclusionEntry[],
            })).filter((cls) => cls.entries.length > 0),
        [data.exclusions],
    );
    const exclusionCount = useMemo(
        () => exclusionClasses.reduce((sum, cls) => sum + cls.entries.length, 0),
        [exclusionClasses],
    );

    // Farm-wide, and read from `data.unvalued` rather than summed from the
    // rows: the usecase counts TRANSACTIONS here, and one transaction can
    // be attributed to plantings of several commodities. Summing rows
    // would report more unvalued movements than the farm actually has.
    const farmWideUnvalued = data.unvalued.noUnitCost + data.unvalued.unitMismatch;


    const header = (
        <PageHeader
            breadcrumbs={[
                { label: t('dashboard'), href: tenantHref('/dashboard') },
                { label: tc('title') },
            ]}
            // NAME the metric. Four cost definitions ship in this product;
            // an unnamed money figure is the bug this eyebrow prevents.
            eyebrow={tc(COST_METRIC_LABEL_KEYS[COST_METRICS.GRAIN_NET_WORTH])}
            title={tc('title')}
            description={
                data.truncated
                    ? tc('truncatedWarning')
                    : `${tc('description')} ${tc('divergenceNote')}`
            }
            // REPORT-level stamp, so it belongs to the page and not to a
            // commodity: `generatedAt` is identical for every row, whereas
            // `priceObservedAt` below moves with the toggle. Sitting them
            // on one line would show a reader one value changing and one
            // frozen with nothing to explain the difference.
            //
            // "What is my grain worth TODAY" is the whole question, so the
            // moment it was answered cannot be left implicit — a figure
            // recomputed on every request still gets screenshotted, pasted
            // into a message and read back a fortnight later.
            meta={
                <>
                    <span className="text-xs tabular-nums text-content-subtle">
                        {tc('generatedAt', { at: formatDateTime(data.generatedAt) })}
                    </span>
                    {farmWideUnvalued > 0 && (
                        // Farm-wide, so it belongs beside the report stamp
                        // rather than in a panel. It is here so the caveat
                        // is on screen BEFORE the reader starts toggling
                        // commodities — a per-commodity note alone would
                        // let someone read one clean commodity and leave.
                        //
                        // This count and the panel's can legitimately
                        // differ: this one counts TRANSACTIONS, the panel
                        // counts them per commodity, and one transaction
                        // can be attributed to several.
                        <span className="text-xs tabular-nums text-content-attention">
                            {tc('unvaluedFarmWide', { count: farmWideUnvalued })}
                        </span>
                    )}
                </>
            }
        />
    );

    // ── The farm answer ──
    //
    // ABOVE the empty-state early return, with the other top-level hooks:
    // a hook after a conditional return changes React's hook ORDER between
    // an empty farm and a populated one, which is a real defect and not a
    // lint nicety.
    //
    // Shown only for a farm with more than one crop: with one, it would
    // restate the commodity sum below it exactly, and an affordance that
    // says nothing should not occupy space on a simple farm.
    const farm = data.farm;
    const showFarmTotal = rows.length > 1 && farm.totals.length > 0;
    // Every refused commodity, from both places one can hide: inside a
    // currency bucket (a mixed-cost-currency refusal keeps its price
    // currency) and outside every bucket (no market price, so no currency
    // at all).
    const farmRefused = useMemo(
        () =>
            [
                ...farm.totals.flatMap((t) => t.refusedCommodities),
                ...farm.refusedWithoutCurrency,
            ].sort(),
        [farm],
    );
    // CURRENCY CODE, not the tenant symbol — `useExactMoneyFormatter`
    // renders whatever the tenant is configured with, which would print a
    // BGN total with a euro sign. The cash-out card below already does it
    // this way for exactly the same reason.
    // Sorted by CONTRIBUTION, biggest first — CANONICAL_COMMODITIES order
    // is arbitrary to a farmer, and the order is a claim the UI states.
    // A refused crop has no figure to rank, so it sorts last rather than
    // as a zero, which would put it below a loss-making crop that at least
    // has a number.
    const comparisonItems = useMemo(
        () =>
            rows
                .map((r) => ({
                    commodity: r.commodity,
                    label: commodityLabel(r.commodity),
                    netWorth: r.netWorth,
                    currency: r.priceCurrency,
                    uncertainty: r.netUncertainty,
                    breakEven: r.breakEven,
                }))
                .sort((a, b) => {
                    if (a.netWorth == null && b.netWorth == null) return 0;
                    if (a.netWorth == null) return 1;
                    if (b.netWorth == null) return -1;
                    return b.netWorth - a.netWorth;
                }),
        [rows, commodityLabel],
    );

    // Grouped by currency, because margin is MONEY — unlike cover, which is
    // a dimensionless ratio and can share one scale across currencies. The
    // fold is the farm total's rule applied to a second figure.
    const marginScales = useMemo(
        () =>
            foldMarginScales(
                rows.map((r) => ({
                    commodity: r.commodity,
                    marginPerDca: r.perArea.marginPerDca,
                    refusalCode: r.perArea.refusalCode,
                    uncertainty: r.perArea.uncertainty,
                    priceCurrency: r.priceCurrency,
                })),
            ),
        [rows],
    );

    const farmTotalValue = useCallback(
        (total: FarmNetWorthTotal) => {
            const amount = `${formatDecimal(total.netWorth, 2)} ${total.currency}`;
            return total.uncertainty === UNCERTAINTY.AT_MOST
                ? tc('uncertaintyAtMost', { value: amount })
                : amount;
        },
        [tc],
    );


    if (row == null) {
        return (
            <div className="animate-fadeIn space-y-section">
                {header}
                <GrainSectionNav tenantSlug={tenantSlug} active="calculator" />
                {/* The description already names the precondition — "figures
                    appear once a planting carries a yield estimate". Naming a
                    precondition without offering the way to satisfy it is a
                    puzzle, so the way is here. /planning, because a yield
                    estimate on a planting is the first of the two paths and
                    the one a farmer controls directly. */}
                <EmptyState
                    size="sm"
                    variant="no-records"
                    title={tc('emptyTitle')}
                    description={tc('emptyDescription')}
                >
                    {/* A LINK wearing the primary button's clothes —
                        `Button` is not polymorphic, and `buttonVariants` is
                        exported for exactly this (see TenantsTable). */}
                    <Link
                        href={tenantHref('/planning')}
                        className={buttonVariants({ variant: 'primary', size: 'sm' })}
                    >
                        {tc('emptyAction')}
                    </Link>
                </EmptyState>
                <ExclusionsCard count={exclusionCount} classes={exclusionClasses} hrefFor={tenantHref} />
            </div>
        );
    }

    const areaDca = haToDca(row.standingCropAreaHa);
    const expectedTonnes = row.standingCropExpectedKg / 1000;

    // `cashCostCurrencies` mixes real ISO codes with UNKNOWN_RENT_CURRENCY,
    // the sentinel the usecase pushes when money rent is present (ParcelLease
    // has no currency column). Split them: codes are listed, the sentinel is
    // said in words. Printing the array verbatim showed farmers "Costs in
    // UNKNOWN".
    const { costCurrencyCodes, rentCurrencyUnknown } = row;

    // Both panels charge the SAME farm cost — see the module docblock.
    // The subtraction is gated on the usecase having CERTIFIED that the
    // currencies are combinable (`netWorth != null`); when it refused,
    // this page refuses too rather than inventing an exchange rate.
    // The uncertainty vocabulary, resolved once for this row and used the
    // same way wherever it appears — headline, cost line, table cell.
    const netState = row.netUncertainty;
    // Currency CODE, not the tenant symbol — the same reason the farm card
    // and the per-crop strip use it: this figure can be in a currency the
    // tenant is not configured with, and `useExactMoneyFormatter` would put
    // the tenant's sign on it regardless.
    const marginPerDcaText = tc('marginPerDcaValue', {
        value: `${formatDecimal(row.perArea.marginPerDca ?? 0, 2)}${row.priceCurrency ? ` ${row.priceCurrency}` : ''}`,
    });
    const refusalText = explainRefusal(
        row.netWorthUnavailableCode,
        row.netWorthUnavailableParams,
        row.netWorthUnavailableReason,
        (key, values) => tc(key, values),
    );

    // No per-asset net is derived here any more. Both used to subtract the
    // WHOLE farm cost from ONE asset — the arithmetic the removed panels
    // displayed — and neither was a quantity anyone could act on.

    // The money is folded into the LABEL, and `showCount` is turned off at
    // the mount below. Two reasons, both load-bearing:
    //
    //   1. <StatusBreakdown>'s count slot prints `item.value` verbatim — no
    //      symbol, no thousands separator. On a page whose entire thesis is
    //      that a money figure must say what it is, "4000" sitting directly
    //      above "Total farm cost €5,500" is the exact defect the rest of
    //      this file works to avoid.
    //   2. The label must stay a STRING. The primitive only names its
    //      `role="progressbar"` when `typeof item.label === 'string'`, so
    //      passing a ReactNode to get formatted money would silently leave
    //      three progress bars with no accessible name.
    const costItems: StatusBreakdownItem[] = row.costBreakdown.map((slice) => ({
        id: slice.id,
        label: `${tc(slice.labelKey)} · ${money(slice.value)}`,
        value: slice.value,
        variant: slice.variant,
    }));

    return (
        <div className="animate-fadeIn space-y-section">
            {header}
            <GrainSectionNav tenantSlug={tenantSlug} active="calculator" />

            {/* ── The farm answer, when there is more than one crop ──

                The page's docblock claims it answers "what is the grain
                worth, after everything it cost me?". It answered that per
                COMMODITY: three crops meant three figures behind a toggle
                and a farmer adding them in their head — the same defect
                the two-panel layout had, one level up.

                It sits ABOVE the toggle deliberately. The toggle selects
                which crop the detailed sum below expands; it must not look
                like it also selects which farm you are looking at.

                ONE CARD PER CURRENCY, never blended. This product applies
                no exchange rate anywhere — cost-rollup refuses to, prices
                carry their own — so a single figure across two currencies
                would reconcile against nothing. And the amounts print
                their CURRENCY CODE rather than the tenant's symbol, which
                is the same reason the cash-out card does: the tenant
                formatter would render a BGN total with a euro sign. */}
            {showFarmTotal && (
                <Card as="section" density="compact" className="space-y-default border-border-subtle">
                    <Heading level={2}>{tc('farmTotalTitle')}</Heading>
                    <div className="flex flex-wrap gap-section">
                        {farm.totals.map((total) => (
                            <KPIStat
                                key={total.currency}
                                size="md"
                                value={farmTotalValue(total)}
                                label={
                                    farm.totals.length > 1
                                        ? `${tc('farmTotalLabel')} · ${total.currency}`
                                        : tc('farmTotalLabel')
                                }
                                tone={
                                    total.uncertainty === UNCERTAINTY.EXACT
                                        ? 'default'
                                        : 'attention'
                                }
                            />
                        ))}
                    </div>
                    {farm.totals.length > 1 && (
                        <p className="text-xs text-content-subtle">{tc('farmCurrencyNote')}</p>
                    )}
                    {farmRefused.length > 0 && (
                        // NEVER silently short. A total missing a commodity
                        // is a different claim from a complete one, and the
                        // reader cannot tell without being told which.
                        <p className="text-xs text-content-attention">
                            {tc('farmRefusedNote', {
                                count: farmRefused.length,
                                names: farmRefused.map((c) => commodityLabel(c)).join(', '),
                            })}
                        </p>
                    )}
                </Card>
            )}

            {/* Replaces the ToggleGroup, which showed one crop at a time
                and could not answer "which crop is carrying this farm?".
                Same conditional instinct: nothing at all for a single-crop
                farm, which should see a simpler page rather than the same
                page with empty affordances. */}
            {comparisonItems.length > 1 && (
                <CommodityStrip
                    items={comparisonItems}
                    // `row.commodity`, not `selected` — `selected` seeds
                    // from rows[0] and the row lookup falls back to rows[0]
                    // too, so on first paint the strip must mark the crop
                    // actually expanded below rather than an empty string.
                    selected={row.commodity}
                    onSelect={setSelected}
                />
            )}

            {/* Beside the cover bars ON PURPOSE, and this puts the page at
                nine surfaces rather than the eight the budget wanted. The
                two rank crops differently — cover by return on the money
                spent, this by return on the land used — and on a farm where
                land is the scarce input the second ranking is the one that
                decides what to plant. Showing one and calling it "the"
                answer would be the confident half-truth this page exists to
                avoid, so both are shown and the disagreement is stated. */}
            <MarginPerDcaCard scales={marginScales} labelFor={commodityLabel} />

            {/* ── The answer: net worth, or the stated refusal ── */}
            <Card as="section" density="compact" className="space-y-default border-border-subtle">
                {/* This figure IS the page — one question, one answer — so it
                    goes through the Epic-metric platform rather than a raw
                    `text-2xl font-semibold`, which the Polish PR-2 ratchet
                    (tests/guards/metric-typography.test.ts) bans and which had
                    to remember `tabular-nums` by hand.

                    KPIStat at size="md" (~30px), NOT the 72px hero primitive.
                    That larger one is the DASHBOARD MASTHEAD register and
                    tests/guards/heromemtric-canonical-home.test.ts keeps it
                    there on purpose — its docblock warns that spreading the
                    72px dilutes the masthead signal, and a report summary card
                    is exactly the casual spread it describes.

                    Two traps in that ratchet, both hit while writing this
                    file. It matches the JSX tag TEXT, so it does not care
                    which module the symbol came from (the repo has two
                    components by that name — ui/HeroMetric.tsx and the one in
                    ui/metric.tsx), and it reads comments as source, so even
                    NAMING the tag here to disclaim it fails the build. Say
                    "the 72px hero primitive" in prose; do not spell the tag.

                    A refused net worth prints the em-dash — the null marker
                    every formatter here already uses — in `attention` tone,
                    and names the refusal in the description slot. Setting the
                    long refusal sentence AS the value would render it at
                    display size, and a refusal shouted large is not more
                    honest than one stated at 14px. */}
                {/* The sum, read down a column. Grouped so the terms and
                    the result they produce are one thing to a screen
                    reader — and so a test can assert that exactly one net
                    figure is claimed here, separately from the appendix
                    table's "Net worth" column header below. */}
                <div
                    role="group"
                    aria-label={tc('waterfallAria')}
                    className="space-y-default"
                >
                    <dl className="space-y-tight text-sm">
                        <SumLine
                            sign="+"
                            label={tc('panelStandingTitle')}
                            badge={tc('panelStandingSubtitle')}
                            details={[
                                `${formatDecimal(areaDca, 1)} ${tc('areaUnit')}`,
                                `${formatDecimal(expectedTonnes, 2)} ${tc('tonnesUnit')}`,
                            ]}
                            amount={row.standingCropValue}
                        />
                        <SumLine
                            sign="+"
                            label={tc('panelOnHandTitle')}
                            badge={tc('panelOnHandSubtitle')}
                            details={[`${formatDecimal(row.grainOnHandTonnes, 3)} ${tc('tonnesUnit')}`]}
                            amount={row.grainOnHandValue}
                        />
                        {row.showProduceRent && (
                            // A TERM, not a footnote. netAssetPosition already
                            // subtracts it, so grain owed to a landlord is
                            // inside the headline whether or not it is drawn —
                            // and it was not. Omitted entirely at zero: a line
                            // reading "− €0" states a term this farm does not
                            // have.
                            <SumLine
                                sign="−"
                                label={tc('produceRentLabel')}
                                details={[`${formatDecimal(row.rentCostProduceKg, 0)} ${tc('kgUnit')}`]}
                                amount={row.rentCostProduceValue}
                                unavailableText={
                                    row.rentCostProduceValue == null
                                        ? tc('produceRentUnpriced')
                                        : undefined
                                }
                            />
                        )}
                        <SumLine
                            sign="−"
                            label={tc('costTotalLabel')}
                            amount={row.cashCostTotal}
                            // AT_LEAST, not AT_MOST — an unpriced
                            // consumption makes this a FLOOR. The same
                            // cause bounds the net the other way; see
                            // lib/grain/uncertainty.
                            bound={
                                row.costUncertainty === UNCERTAINTY.AT_LEAST
                                    ? 'atLeast'
                                    : undefined
                            }
                        />
                    </dl>

                    {/* The cost's composition sits under the cost line it
                        decomposes — one cost on the page means one place
                        for everything that qualifies it. */}
                    <div className="space-y-tight">
                        <p className="text-xs uppercase tracking-wide text-content-subtle">
                            {tc('costBreakdownLabel')}
                        </p>
                        <StatusBreakdown
                            size="sm"
                            ariaLabel={tc('costBreakdownAria')}
                            items={costItems}
                            // OFF, and deliberately: the count slot renders the
                            // raw number with no currency. The amount is in the
                            // label instead — see the costItems comment.
                            showCount={false}
                            showPercent
                        />
                        {row.payrollAllocated && (
                            // An allocation is not a measurement. Said twice —
                            // badge for the skim, sentence for the reader.
                            <div className="space-y-tight">
                                <Badge variant="warning" size="sm">
                                    {tc('payrollAllocatedBadge')}
                                </Badge>
                                <p className="text-xs text-content-muted">
                                    {tc('payrollAllocatedNote')}
                                </p>
                            </div>
                        )}
                        <UnvaluedNote
                            noUnitCost={row.unvaluedNoUnitCost}
                            unitMismatch={row.unvaluedUnitMismatch}
                        />
                    </div>

                    <div className="border-t border-border-subtle pt-2">
                        {/* THE HEADLINE CARRIES ITS OWN QUALIFIER.
                            When cost is a floor, net worth is a MAXIMUM,
                            and the page used to print it as a definite
                            figure with the caveat two surfaces above,
                            under a panel's cost line. A qualifier that
                            lives on a different surface from the number
                            it qualifies is not a qualifier — so it is in
                            the VALUE. */}
                        {/* PER DECARE — the unit a Bulgarian farmer plans
                            in, and the one the land market quotes rent in.

                            Beside the result, not inside the sum: this is
                            not a TERM of the arithmetic above, it is a
                            different question asked of a SUBSET of the same
                            figures. Only terms sharing the standing crop's
                            own area are in it — grain in store has no area,
                            and farm-wide overhead is not this planting's.
                            Dividing net worth by an area would mix those
                            scopes, and a guard now forbids it.

                            The qualifier rides the value, and a refusal
                            names WHICH denominator was missing rather than
                            printing a dash. */}
                        <div className="flex flex-wrap items-baseline justify-between gap-tight pb-2 text-sm">
                            <span className="text-content-muted">
                                {tc('marginPerDcaLabel')}
                            </span>
                            {row.perArea.marginPerDca == null ? (
                                <span className="text-xs text-content-attention">
                                    {row.perArea.refusalCode === 'NO_STANDING_CROP_AREA'
                                        ? tc('perAreaNoArea')
                                        : tc('perAreaNoValue')}
                                </span>
                            ) : (
                                <span
                                    className={
                                        row.perArea.uncertainty === UNCERTAINTY.EXACT
                                            ? 'font-medium tabular-nums text-content-emphasis'
                                            : 'font-medium tabular-nums text-content-attention'
                                    }
                                >
                                    {row.perArea.uncertainty === UNCERTAINTY.AT_MOST
                                        ? tc('uncertaintyAtMost', { value: marginPerDcaText })
                                        : marginPerDcaText}
                                </span>
                            )}
                        </div>
                        {row.perArea.uncertainty === UNCERTAINTY.PARTIAL && (
                            <p className="pb-2 text-xs text-content-attention">
                                {tc('perAreaPartial')}
                            </p>
                        )}
                        <p className="pb-2 text-xs text-content-subtle">
                            {tc('marginPerDcaHint')}
                        </p>
                        <KPIStat
                            size="md"
                            value={
                                row.netWorth == null
                                    ? '—'
                                    : netState === UNCERTAINTY.AT_MOST
                                      ? tc('uncertaintyAtMost', { value: money(row.netWorth) })
                                      : money(row.netWorth)
                            }
                            label={tc('netWorthLabel')}
                            tone={
                                row.netWorth == null || netState === UNCERTAINTY.AT_MOST
                                    ? 'attention'
                                    : 'default'
                            }
                            description={
                                row.netWorth == null
                                    ? tc('netWorthUnavailableTitle')
                                    : netState === UNCERTAINTY.AT_MOST
                                      ? tc('uncertaintyAtMostWhy')
                                      : undefined
                            }
                        />
                        {/* A single-crop farm has nothing to compare, so the
                            strip above is suppressed — but "does this clear
                            its cost?" is still the question, and for a
                            monoculture it is the ONLY one. The comparison is
                            what one crop makes meaningless; the cover is not.
                            Same component, no extra card. */}
                        {comparisonItems.length === 1 && (
                            <BreakEvenRow
                                commodityLabel={comparisonItems[0].label}
                                figures={row.breakEven}
                            />
                        )}
                    </div>
                </div>
                {/* A refusal that a farmer can act on says where. The
                    fixable one is a missing market price — /trends is where
                    prices live. The others are NOT fixable from here and get
                    no action: a mixed cost currency needs an FX rate this
                    product deliberately does not have, and an unrecorded rent
                    currency needs a column ParcelLease does not carry.
                    Offering a destination that cannot resolve the cause would
                    be worse than the plain explanation. */}
                {row.netWorthUnavailableCode === 'NO_MARKET_PRICE' && (
                    <p className="text-xs">
                        <TextLink tone="link" href={tenantHref('/trends')}>
                            {tc('exclFixTrends')}
                        </TextLink>
                    </p>
                )}
                {refusalText != null && (
                    // A refusal is stated, never blanked. Translated from
                    // the usecase's CODE when this client knows it, and
                    // from its English sentence when it does not — see
                    // explainRefusal, whose whole job is that an
                    // unrecognised code still explains itself.
                    <p className="text-xs text-content-muted">{refusalText}</p>
                )}
                <div className="flex flex-wrap gap-default text-xs text-content-subtle">
                    <span className="tabular-nums">
                        {tc('priceLabel')}:{' '}
                        {row.pricePerTonne == null
                            ? tc('priceNone')
                            : `${money(row.pricePerTonne)} ${tc('pricePerTonne')}`}
                    </span>
                    {row.priceObservedAt != null && (
                        // Sits beside the price it qualifies, not beside the
                        // report stamp in the header. The distance between
                        // the two dates IS the staleness signal: a valuation
                        // generated this morning off a quote observed three
                        // weeks ago is arithmetically correct and
                        // operationally worthless, and only showing both
                        // lets a reader see that for themselves.
                        <span className="tabular-nums">
                            {/* formatDate, NOT formatDateTime. The value is
                                date-only — trends.ts builds it as
                                `date.toISOString().slice(0, 10)` — so rendering
                                it with a time appends a midnight that was never
                                observed. A fabricated hour is a poor thing to
                                put on the very line whose job is to let a
                                reader judge how stale the price is. */}
                            {tc('priceObserved', { at: formatDate(row.priceObservedAt) })}
                        </span>
                    )}
                    {/* "Price in {currency}" takes a CODE. Substituting a
                        clause into that slot produced "Price in not recorded"
                        in English and, in Bulgarian, "Цена в не е записана" —
                        a preposition followed by a finite verb. The absent
                        case gets its own standalone sentence instead; a
                        placeholder is not a general-purpose blank. */}
                    <span>
                        {row.priceCurrency != null
                            ? tc('currencyPriceIn', { currency: row.priceCurrency })
                            : tc('currencyPriceUnrecorded')}
                    </span>
                    <span>
                        {costCurrencyCodes.length > 0
                            ? tc('currencyCostsIn', {
                                  currencies: costCurrencyCodes.join(', '),
                              })
                            : tc('currencyCostsUnrecorded')}
                    </span>
                    {rentCurrencyUnknown && (
                        // UNKNOWN_RENT_CURRENCY is an internal sentinel, not
                        // an ISO code — the usecase's own docblock says it "is
                        // never treated as one". Joining cashCostCurrencies
                        // verbatim printed it as if it were, so it is filtered
                        // out above and stated in its own words here.
                        <span>{tc('currencyRentUnrecorded')}</span>
                    )}
                    {row.priceSource != null && (
                        <span>{tc('priceSource', { source: row.priceSource })}</span>
                    )}
                </div>
            </Card>


            {/* ── Cash out — a DIFFERENT question, kept visibly apart ──
                Everything above answers "what is the grain worth after
                what it cost". This answers "what left the bank". They are
                not two views of one number and must never be added: crop
                cost is CONSUMPTION-based and rent cost is a lease-terms
                accrual, so a fertiliser purchase or a rent payment folded
                into either would bill the same money twice. Hence its own
                card, its own metric name, and the note saying so. */}
            {data.cashOut.length > 0 && (
                <Card as="section" density="compact" className="space-y-default border-border-subtle">
                    <div className="flex flex-wrap items-baseline gap-default">
                        <Heading level={3} as="h2" tone="muted">
                            {tc(COST_METRIC_LABEL_KEYS[COST_METRICS.GRAIN_CASH_OUT])}
                        </Heading>
                    </div>
                    <dl className="space-y-tight text-sm">
                        {data.cashOut.map((line) => (
                            // One row PER CURRENCY, never a blended total —
                            // there is no FX table in this product, so a
                            // single figure would reconcile against nothing.
                            <div
                                key={line.currency}
                                className="flex items-baseline justify-between gap-tight"
                            >
                                <dt className="text-content-muted">
                                    {line.categories
                                        .map((c) => t(`costCategory.${c}`))
                                        .join(', ')}
                                </dt>
                                <dd className="font-medium tabular-nums text-content-emphasis">
                                    {formatDecimal(line.amount, 2)} {line.currency}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className="text-xs text-content-subtle">{tc('cashOutNote')}</p>
                </Card>
            )}

            {/* ── Beside the cost, and neither one of its terms ──
                Two figures that belong to the farm rather than to a crop.
                `unallocatedToCrop` is money the allocator conserved onto
                land with nothing growing on it: the rows above are short
                by exactly this, so printing it is what makes "changing
                the basis redistributes and never changes the total"
                something a reader can check rather than take on trust.
                The imputed land charge is not money at all — it is what
                the farm's own land would fetch as rent, which is why it
                is here and not in the cost line. */}
            {(data.unallocatedToCrop.amount !== 0 || data.imputedLandCharge.areaHa > 0) && (
                <Card as="section" density="compact" className="space-y-default border-border-subtle">
                    <Heading level={3} as="h2" tone="muted">
                        {tc('besideCostTitle')}
                    </Heading>
                    <dl className="space-y-default text-sm">
                        {data.imputedLandCharge.areaHa > 0 && (
                            <div className="space-y-tight">
                                <div className="flex items-baseline justify-between gap-tight">
                                    <dt className="text-content-muted">
                                        {tc(COST_METRIC_LABEL_KEYS[COST_METRICS.IMPUTED_LAND_CHARGE])}
                                    </dt>
                                    <dd className="font-medium tabular-nums text-content-emphasis">
                                        {data.imputedLandCharge.totalAmount != null
                                            ? formatDecimal(data.imputedLandCharge.totalAmount, 2)
                                            : tc('imputedLandChargeRefused')}
                                    </dd>
                                </div>
                                <div className="flex flex-wrap items-center gap-tight">
                                    {/* The SAME word a pro-rata payroll share
                                        carries. An apportioned figure must
                                        never read as a measurement. */}
                                    <Badge variant="warning" size="sm">
                                        {tc('payrollAllocatedBadge')}
                                    </Badge>
                                    <p className="text-xs text-content-muted">
                                        {data.imputedLandCharge.perHa != null
                                            ? tc('imputedLandChargeNote', {
                                                  rate: formatDecimal(data.imputedLandCharge.perHa, 2),
                                                  area: formatDecimal(data.imputedLandCharge.areaHa, 2),
                                              })
                                            : tc('imputedLandChargeRefusedWhy')}
                                    </p>
                                </div>
                            </div>
                        )}
                        {data.unallocatedToCrop.amount !== 0 && (
                            <div className="space-y-tight">
                                <div className="flex items-baseline justify-between gap-tight">
                                    <dt className="text-content-muted">
                                        {tc('unallocatedToCropLabel')}
                                    </dt>
                                    <dd className="font-medium tabular-nums text-content-emphasis">
                                        {formatDecimal(data.unallocatedToCrop.amount, 2)}
                                    </dd>
                                </div>
                                <p className="text-xs text-content-muted">
                                    {tc('unallocatedToCropNote', {
                                        count: data.unallocatedToCrop.parcelIds.length,
                                        area: formatDecimal(data.unallocatedToCrop.areaHa, 2),
                                    })}
                                </p>
                            </div>
                        )}
                    </dl>
                </Card>
            )}

            <ExclusionsCard count={exclusionCount} classes={exclusionClasses} hrefFor={tenantHref} />

            {/* THE APPENDIX TABLE IS GONE, and this is the surface it
                paid for. It listed every commodity's five money columns
                below the sum, the cost breakdown, the KPI and the
                exclusions — and CommodityStrip already shows every crop's
                net side by side, higher up, which is what the strip's own
                docblock says it exists for. Net worth appeared in THREE
                places; it now appears in two, and the break-even bars ride
                the surface that was already there. Nine surfaces became
                eight. Its guard exemptions went with it. */}
        </div>
    );
}
