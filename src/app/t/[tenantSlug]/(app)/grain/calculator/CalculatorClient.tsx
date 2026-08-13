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
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Heading } from '@/components/ui/typography';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { StatusBreakdown, type StatusBreakdownItem } from '@/components/ui/status-breakdown';
import { DataTable, createColumns } from '@/components/ui/table';
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
import { GrainSectionNav } from '../GrainSectionNav';

// ─── Serialised DTOs (mirror the grain-net-worth usecase output) ────

export interface CalculatorRow {
    commodity: string;

    pricePerTonne: number | null;
    priceCurrency: string | null;
    priceObservedAt: string | null;
    priceSource: string | null;

    standingCropAreaHa: number;
    standingCropExpectedKg: number;
    standingCropPlantingIds: string[];
    standingCropValue: number | null;

    grainOnHandTonnes: number;
    grainOnHandLotIds: string[];
    grainOnHandValue: number | null;

    attributedCropCost: number;
    attributedCropCostCurrencies: string[];
    attributedCropCostCurrencyMixed: boolean;

    rentCostMoneyAmount: number;
    rentCostProduceKg: number;
    rentCostProduceValue: number | null;

    payrollCost: number;
    payrollCostCurrencies: string[];
    payrollCostCurrencyMixed: boolean;
    payrollAllocated: boolean;

    cashCostTotal: number;
    cashCostCurrencies: string[];
    cashCostCurrencyMixed: boolean;

    // Consumptions the usecase could not price. They change no figure —
    // `cashCostTotal` above is simply a FLOOR whenever either is non-zero.
    unvaluedNoUnitCost: number;
    unvaluedUnitMismatch: number;

    netAssetPosition: number | null;
    netWorth: number | null;
    netWorthUnavailableReason: string | null;
}

export type LotExclusion = { lotId: string; unitKey: string | null };
export type LeaseExclusion = { leaseId: string; reason: string };
export type ExclusionEntry = string | LotExclusion | LeaseExclusion;

export interface CalculatorExclusions {
    plantingsMissingYieldEstimate: string[];
    plantingsUnknownCommodity: string[];
    lotsUnresolvedUnit: LotExclusion[];
    lotsUnknownCommodity: string[];
    commoditiesWithNoPrice: string[];
    leasesUnresolvedRent: LeaseExclusion[];
    leasesUnattributed: string[];
    leasesProduceRentUnpriced: string[];
    payrollUnattributable: string[];
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
const EXCLUSION_CLASSES: ReadonlyArray<{
    key: keyof CalculatorExclusions;
    labelKey: string;
}> = [
    { key: 'plantingsMissingYieldEstimate', labelKey: 'exclPlantingsMissingYieldEstimate' },
    { key: 'plantingsUnknownCommodity', labelKey: 'exclPlantingsUnknownCommodity' },
    { key: 'lotsUnresolvedUnit', labelKey: 'exclLotsUnresolvedUnit' },
    { key: 'lotsUnknownCommodity', labelKey: 'exclLotsUnknownCommodity' },
    { key: 'commoditiesWithNoPrice', labelKey: 'exclCommoditiesWithNoPrice' },
    { key: 'leasesUnresolvedRent', labelKey: 'exclLeasesUnresolvedRent' },
    { key: 'leasesUnattributed', labelKey: 'exclLeasesUnattributed' },
    { key: 'leasesProduceRentUnpriced', labelKey: 'exclLeasesProduceRentUnpriced' },
    { key: 'payrollUnattributable', labelKey: 'exclPayrollUnattributable' },
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

/** One exclusion entry rendered as a readable line. */
function describeEntry(entry: ExclusionEntry): string {
    if (typeof entry === 'string') return entry;
    if ('lotId' in entry) return entry.unitKey ? `${entry.lotId} (${entry.unitKey})` : entry.lotId;
    return `${entry.leaseId} — ${entry.reason}`;
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

    const commodityOptions = useMemo(
        () => rows.map((r) => ({ value: r.commodity, label: commodityLabel(r.commodity) })),
        [rows, commodityLabel],
    );

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

    const columns = useMemo(
        () =>
            createColumns<CalculatorRow>([
                {
                    id: 'commodity',
                    header: tc('colCommodity'),
                    accessorFn: (r) => r.commodity,
                    cell: ({ row: r }) => (
                        <span className="text-content-emphasis">
                            {commodityLabel(r.original.commodity)}
                        </span>
                    ),
                },
                {
                    id: 'standingCropValue',
                    header: tc('colStandingValue'),
                    accessorFn: (r) => r.standingCropValue ?? -1,
                    cell: ({ row: r }) => (
                        <span className="block text-right text-xs tabular-nums text-content-muted">
                            {money(r.original.standingCropValue)}
                        </span>
                    ),
                },
                {
                    id: 'grainOnHandValue',
                    header: tc('colOnHandValue'),
                    accessorFn: (r) => r.grainOnHandValue ?? -1,
                    cell: ({ row: r }) => (
                        <span className="block text-right text-xs tabular-nums text-content-muted">
                            {money(r.original.grainOnHandValue)}
                        </span>
                    ),
                },
                {
                    id: 'cashCostTotal',
                    header: tc('colCashCost'),
                    accessorFn: (r) => r.cashCostTotal,
                    cell: ({ row: r }) => (
                        <span className="block text-right text-xs tabular-nums text-content-muted">
                            {money(r.original.cashCostTotal)}
                        </span>
                    ),
                },
                {
                    // A refused net worth prints the refusal wording, never
                    // a zero. The full sentence lives in the summary card
                    // above — a table cell is the wrong place for it, but a
                    // blank cell would read as "nothing".
                    id: 'netWorth',
                    header: tc('colNetWorth'),
                    accessorFn: (r) => r.netWorth ?? -1,
                    cell: ({ row: r }) =>
                        r.original.netWorth == null ? (
                            <span className="block text-right text-xs text-content-subtle">
                                {tc('netWorthUnavailableTitle')}
                            </span>
                        ) : (
                            <span className="block text-right text-xs tabular-nums text-content-emphasis">
                                {money(r.original.netWorth)}
                            </span>
                        ),
                },
            ]),
        [tc, money, commodityLabel],
    );

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

    if (row == null) {
        return (
            <div className="animate-fadeIn space-y-section">
                {header}
                <GrainSectionNav tenantSlug={tenantSlug} active="calculator" />
                <EmptyState
                    size="sm"
                    variant="no-records"
                    title={tc('emptyTitle')}
                    description={tc('emptyDescription')}
                />
                <ExclusionsCard count={exclusionCount} classes={exclusionClasses} />
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
    const costCurrencyCodes = row.cashCostCurrencies.filter(
        (c) => c !== UNKNOWN_RENT_CURRENCY,
    );
    const rentCurrencyUnknown =
        costCurrencyCodes.length !== row.cashCostCurrencies.length;

    // Both panels charge the SAME farm cost — see the module docblock.
    // The subtraction is gated on the usecase having CERTIFIED that the
    // currencies are combinable (`netWorth != null`); when it refused,
    // this page refuses too rather than inventing an exchange rate.
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
    const costItems: StatusBreakdownItem[] = [
        {
            id: 'field',
            label: `${tc('costFieldLabel')} · ${money(row.attributedCropCost)}`,
            value: row.attributedCropCost,
            variant: 'brand',
        },
        {
            id: 'rent',
            label: `${tc('costRentLabel')} · ${money(row.rentCostMoneyAmount)}`,
            value: row.rentCostMoneyAmount,
            variant: 'warning',
        },
        {
            id: 'payroll',
            label: `${tc('costPayrollLabel')} · ${money(row.payrollCost)}`,
            value: row.payrollCost,
            variant: 'info',
        },
    ];

    return (
        <div className="animate-fadeIn space-y-section">
            {header}
            <GrainSectionNav tenantSlug={tenantSlug} active="calculator" />

            {commodityOptions.length > 1 && (
                <ToggleGroup
                    ariaLabel={tc('commodityAria')}
                    options={commodityOptions}
                    selected={selected}
                    selectAction={setSelected}
                />
            )}

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
                        {row.rentCostProduceKg > 0 && (
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
                        <KPIStat
                            size="md"
                            value={row.netWorth != null ? money(row.netWorth) : '—'}
                            label={tc('netWorthLabel')}
                            tone={row.netWorth != null ? 'default' : 'attention'}
                            description={
                                row.netWorth == null
                                    ? tc('netWorthUnavailableTitle')
                                    : undefined
                            }
                        />
                    </div>
                </div>
                {row.netWorthUnavailableReason != null && (
                    // A refusal is stated, never blanked. The sentence is
                    // authored by the usecase so the page cannot drift from
                    // the actual reason the figure was withheld.
                    <p className="text-xs text-content-muted">{row.netWorthUnavailableReason}</p>
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

            <ExclusionsCard count={exclusionCount} classes={exclusionClasses} />

            {/* Every commodity at once. `mobileFallback="scroll"` (not
                "card") because these money columns are only meaningful
                read side by side — a card that shows a net worth without
                the cost beside it is the misleading half of the row. */}
            <Card as="section" density="compact" className="space-y-default border-border-subtle">
                <Heading level={3} as="h2" tone="muted">
                    {tc('tableTitle')}
                </Heading>
                <DataTable<CalculatorRow>
                    // Peer convention (grain-costs-table / grain-bins-table),
                    // and required: tests/unit/data-table.test.ts asserts every
                    // client page mounting <DataTable> carries a data-testid.
                    data-testid="grain-calculator-table"
                    mobileFallback="scroll"
                    data={rows}
                    columns={columns}
                    getRowId={(r) => r.commodity}
                    selectionEnabled={false}
                    resourceName={(plural) =>
                        plural ? tc('resourceCommodities') : tc('resourceCommodity')
                    }
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={tc('emptyTitle')}
                            description={tc('emptyDescription')}
                        />
                    }
                />
            </Card>
        </div>
    );
}

// ─── One line of the sum ────────────────────────────────────────────

interface SumLineProps {
    /** Rendered before the amount so the column can be added by eye. */
    sign: '+' | '−';
    label: string;
    /** EXPECTED / ACTUAL — the term's basis, not decoration. */
    badge?: string;
    /**
     * The quantities behind the money (area, tonnes, kg) — a LIST, each
     * rendered as its own node. Joining them into one string would make
     * "125 dca" unfindable as a fact in its own right, by a test or by
     * anything else reading the DOM.
     */
    details?: readonly string[];
    amount: number | null;
    /** Shown instead of the amount when the term exists but could not be priced. */
    unavailableText?: string;
}

/**
 * One term of `standing + onHand − produceRent − cost = netWorth`.
 *
 * The sign is rendered, not implied by colour or position, because the
 * whole point of the layout is that a reader can add the column
 * themselves and arrive at the figure below it. A minus that exists only
 * as red text is not a minus on a monochrome print-out or to anyone who
 * does not distinguish the hue.
 *
 * `−` is U+2212, not a hyphen: it is the character that aligns with the
 * `+` at the same optical weight in a tabular-nums column.
 */
function SumLine({ sign, label, badge, details, amount, unavailableText }: SumLineProps) {
    const money = useExactMoneyFormatter();

    return (
        <div className="flex items-baseline justify-between gap-tight">
            <dt className="flex flex-wrap items-baseline gap-tight text-content-muted">
                <span>{label}</span>
                {badge != null && (
                    <Badge variant="outline" size="sm">
                        {badge}
                    </Badge>
                )}
                {details?.map((d) => (
                    <span key={d} className="tabular-nums text-content-subtle">
                        {d}
                    </span>
                ))}
            </dt>
            <dd className="font-medium tabular-nums text-content-emphasis">
                {unavailableText != null ? (
                    <span className="text-xs font-normal text-content-attention">
                        {unavailableText}
                    </span>
                ) : amount == null ? (
                    // The em-dash every formatter on this page already uses
                    // for a null. Signing it would assert a direction for a
                    // quantity we do not have.
                    money(null)
                ) : (
                    `${sign}${money(amount)}`
                )}
            </dd>
        </div>
    );
}

// ─── Exclusions ─────────────────────────────────────────────────────

interface ExclusionsCardProps {
    count: number;
    classes: ReadonlyArray<{
        key: keyof CalculatorExclusions;
        labelKey: string;
        entries: ReadonlyArray<ExclusionEntry>;
    }>;
}

/**
 * The exclusion count is ALWAYS rendered, including when it is zero —
 * "0 records excluded" is a statement; an absent line is not. The
 * accordion is the "which ones" affordance the count is useless
 * without.
 */
function ExclusionsCard({ count, classes }: ExclusionsCardProps) {
    const tc = useTranslations('grain.calculator');

    return (
        <Card as="section" density="compact" className="space-y-default border-border-subtle">
            <div className="flex flex-wrap items-baseline gap-default">
                <Heading level={3} as="h2" tone="muted">
                    {tc('exclusionsTitle')}
                </Heading>
                <Badge variant={count > 0 ? 'attention' : 'neutral'} size="md">
                    {tc('exclusionsCount', { count })}
                </Badge>
            </div>
            {count === 0 ? (
                <p className="text-xs text-content-muted">{tc('exclusionsNone')}</p>
            ) : (
                <>
                    <p className="text-xs text-content-muted">{tc('exclusionsHint')}</p>
                    <Accordion type="single" collapsible>
                        {classes.map((cls) => (
                            <AccordionItem key={cls.key} value={cls.key} density="compact">
                                <AccordionTrigger size="sm">
                                    <span className="text-left">
                                        {tc(cls.labelKey)} ({cls.entries.length})
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent size="sm">
                                    <ul className="space-y-tight pt-2 font-mono text-xs text-content-muted">
                                        {cls.entries.map((entry, i) => (
                                            <li key={`${cls.key}-${i}`}>{describeEntry(entry)}</li>
                                        ))}
                                    </ul>
                                </AccordionContent>
                            </AccordionItem>
                        ))}
                    </Accordion>
                </>
            )}
        </Card>
    );
}
