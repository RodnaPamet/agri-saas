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
 * ── The two panels ──────────────────────────────────────────────────
 *
 * Standing crop (EXPECTED — planned yield × area × today's price) and
 * grain on hand (ACTUAL — what is physically in a store, converted to
 * tonnes from each lot's own unit). Stacked on a phone, side by side
 * from `sm` up.
 *
 * The cost side is NOT split between them: the usecase attributes cost
 * per COMMODITY, not per "growing vs stored". Rather than invent a
 * split, both panels charge the SAME `cashCostTotal` and the page says
 * so — `sharedCostNote` states plainly that the two nets cannot be
 * added, and the combined, authoritative figure is `row.netWorth` in
 * the summary card above.
 *
 * ── Where the refusals show up ──────────────────────────────────────
 *
 *   • `netWorth === null` → the summary card renders
 *     `netWorthUnavailableReason` (a stated refusal — never a blank or
 *     a zero), and both panels drop their net line for the same reason.
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

export interface CalculatorData {
    generatedAt: string;
    seasonId: string | null;
    rows: CalculatorRow[];
    exclusions: CalculatorExclusions;
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
                <span className="text-xs tabular-nums text-content-subtle">
                    {tc('generatedAt', { at: formatDateTime(data.generatedAt) })}
                </span>
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
    const netCertified = row.netWorth != null;
    const standingNet =
        netCertified && row.standingCropValue != null
            ? row.standingCropValue - row.cashCostTotal
            : null;
    const onHandNet =
        netCertified && row.grainOnHandValue != null
            ? row.grainOnHandValue - row.cashCostTotal
            : null;

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
                <KPIStat
                    size="md"
                    value={row.netWorth != null ? money(row.netWorth) : '—'}
                    label={tc('netWorthLabel')}
                    tone={row.netWorth != null ? 'default' : 'attention'}
                    description={
                        row.netWorth == null ? tc('netWorthUnavailableTitle') : undefined
                    }
                />
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

            {/* ── The two panels: expected beside actual ──
                Stacked on a phone (the operator's real device), side by
                side from `sm` up. */}
            <div className="grid grid-cols-1 gap-section sm:grid-cols-2">
                <ValuePanel
                    title={tc('panelStandingTitle')}
                    subtitle={tc('panelStandingSubtitle')}
                    quantityLabel={tc('areaLabel')}
                    quantityValue={`${formatDecimal(areaDca, 1)} ${tc('areaUnit')}`}
                    secondaryLabel={tc('expectedYieldLabel')}
                    secondaryValue={`${formatDecimal(expectedTonnes, 2)} ${tc('tonnesUnit')}`}
                    gross={row.standingCropValue}
                    net={standingNet}
                    row={row}
                    costItems={costItems}
                />
                <ValuePanel
                    title={tc('panelOnHandTitle')}
                    subtitle={tc('panelOnHandSubtitle')}
                    quantityLabel={tc('inStoreLabel')}
                    quantityValue={`${formatDecimal(row.grainOnHandTonnes, 3)} ${tc('tonnesUnit')}`}
                    secondaryLabel={null}
                    secondaryValue={null}
                    gross={row.grainOnHandValue}
                    net={onHandNet}
                    row={row}
                    costItems={costItems}
                />
            </div>

            <p className="text-xs text-content-subtle">{tc('sharedCostNote')}</p>

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

// ─── Panel ──────────────────────────────────────────────────────────

interface ValuePanelProps {
    title: string;
    subtitle: string;
    quantityLabel: string;
    quantityValue: string;
    secondaryLabel: string | null;
    secondaryValue: string | null;
    gross: number | null;
    net: number | null;
    row: CalculatorRow;
    costItems: StatusBreakdownItem[];
}

/**
 * One side of the calculator: a quantity, its gross value, the cost
 * charged against it broken down BY SOURCE, and the net.
 *
 * The breakdown is a `<StatusBreakdown>` from the Epic 59 chart
 * platform — three labelled categories sharing a total is exactly what
 * that primitive is for, and it keeps this page free of the hand-rolled
 * percentage-width div the platform replaced.
 *
 * (Spelling that hand-rolled bar out literally here is what the earlier
 * draft did, and `tests/guardrails/dashboard-chart-bypass.test.ts` failed
 * the file for it: the scanner reads raw source and cannot tell a bypass
 * from a comment saying "we do not bypass". Describe the anti-pattern in
 * prose rather than quoting its code.)
 */
function ValuePanel({
    title,
    subtitle,
    quantityLabel,
    quantityValue,
    secondaryLabel,
    secondaryValue,
    gross,
    net,
    row,
    costItems,
}: ValuePanelProps) {
    const tc = useTranslations('grain.calculator');
    const money = useExactMoneyFormatter();

    return (
        <Card as="section" density="compact" className="space-y-default border-border-subtle">
            <div className="flex flex-wrap items-baseline gap-tight">
                <Heading level={2}>{title}</Heading>
                <Badge variant="outline" size="sm">
                    {subtitle}
                </Badge>
            </div>

            <dl className="space-y-tight text-sm">
                <div className="flex items-baseline justify-between gap-tight">
                    <dt className="text-content-muted">{quantityLabel}</dt>
                    <dd className="tabular-nums text-content-default">{quantityValue}</dd>
                </div>
                {secondaryLabel != null && secondaryValue != null && (
                    <div className="flex items-baseline justify-between gap-tight">
                        <dt className="text-content-muted">{secondaryLabel}</dt>
                        <dd className="tabular-nums text-content-default">{secondaryValue}</dd>
                    </div>
                )}
                <div className="flex items-baseline justify-between gap-tight border-t border-border-subtle pt-2">
                    <dt className="text-content-muted">{tc('grossValueLabel')}</dt>
                    <dd className="font-medium tabular-nums text-content-emphasis">
                        {money(gross)}
                    </dd>
                </div>
            </dl>

            <div className="space-y-tight">
                <p className="text-xs uppercase tracking-wide text-content-subtle">
                    {tc('costBreakdownLabel')}
                </p>
                <StatusBreakdown
                    size="sm"
                    ariaLabel={tc('costBreakdownAria')}
                    items={costItems}
                    // OFF, and deliberately: the count slot renders the raw
                    // number with no currency. The amount is in the label
                    // instead — see the costItems comment.
                    showCount={false}
                    showPercent
                />
                <div className="flex items-baseline justify-between gap-tight text-sm">
                    <span className="text-content-muted">{tc('costTotalLabel')}</span>
                    <span className="font-medium tabular-nums text-content-emphasis">
                        {money(row.cashCostTotal)}
                    </span>
                </div>
                {row.payrollAllocated && (
                    // An allocation is not a measurement. Said twice —
                    // badge for the skim, sentence for the reader.
                    <div className="space-y-tight">
                        <Badge variant="warning" size="sm">
                            {tc('payrollAllocatedBadge')}
                        </Badge>
                        <p className="text-xs text-content-muted">{tc('payrollAllocatedNote')}</p>
                    </div>
                )}
                {row.rentCostProduceKg > 0 && (
                    <p className="text-xs text-content-muted">
                        {tc('produceRentLabel')}: {formatDecimal(row.rentCostProduceKg, 0)}{' '}
                        {tc('kgUnit')}
                        {row.rentCostProduceValue == null
                            ? ` — ${tc('produceRentUnpriced')}`
                            : ` — ${money(row.rentCostProduceValue)}`}
                    </p>
                )}
            </div>

            <div className="flex items-baseline justify-between gap-tight border-t border-border-subtle pt-2 text-sm">
                <span className="text-content-muted">{tc('netAfterCostLabel')}</span>
                {net == null ? (
                    <span className="text-xs text-content-attention">
                        {tc('netWorthUnavailableTitle')}
                    </span>
                ) : (
                    <span className="text-base font-semibold tabular-nums text-content-emphasis">
                        {money(net)}
                    </span>
                )}
            </div>
        </Card>
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
