'use client';

/**
 * Trends → Prices tab.
 *
 * A commodity picker + range selector driving one line chart PER UNIT-GROUP
 * (EC EUR/t, listings BGN, Alpha Vantage USD each get their own Y axis — units
 * are never mixed on one axis). Above the charts sit stat tiles (latest BG
 * official price + week-over-week delta, listings index + sample count,
 * reference-benchmark latest). Degrades to a skeleton while loading, and to a
 * combined empty + operator-configuration panel when the payload has no data
 * (the endpoint returns empty series when EC / Alpha Vantage are unconfigured
 * OR the window is genuinely empty — the two are indistinguishable to the
 * client, so the no-data panel carries both messages).
 *
 * Lives under `src/components/trends/` (not the route folder) deliberately: the
 * `single-tab-pattern` guard forbids `<TabSelect>` inside `src/app/**`, and
 * this tab uses TabSelect for the range selector.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    commoditiesInCategory,
    commodityMeta,
    type CommodityCategory,
} from '@/lib/market/commodity-vocabulary';
import { TREND_CHARTABLE, type TrendCommodity } from '@/app-layer/schemas/trends.schemas';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { usePermissions } from '@/lib/tenant-context-provider';
import { FormField } from '@/components/ui/form-field';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { TabSelect } from '@/components/ui/tab-select';
import { Heading } from '@/components/ui/typography';
import {
    TimeSeriesChart,
    Areas,
    XAxis,
    YAxis,
    type Series,
} from '@/components/ui/charts';
import {
    type TrendPricesResponse,
    type MergedDatum,
    type TrendSeries,
    groupSeriesByRegionUnit,
    buildMergedData,
    seriesKey,
    sourceLabelKey,
    findEcSeries,
    primarySeries,
    findListingsSeries,
    findReferenceSeries,
    latestPoint,
    weekOverWeekDelta,
    isEmptyPayload,
    formatPriceWithCurrency,
    formatDelta,
    firstInterestedCommodity,
} from './trends-helpers';
import { SeriesProvenance } from './SeriesProvenance';

const RANGES = ['1m', '3m', '1y', 'all'] as const;
type Commodity = TrendCommodity;
type Range = (typeof RANGES)[number];

/**
 * The picker is two levels now: category, then commodity within it.
 *
 * Options come from the vocabulary's own category lookup rather than a list
 * in this file, so adding a commodity never means editing a React component.
 * Only slugs the read path can actually serve are offered — the vocabulary is
 * deliberately a superset of what is quotable, and a dropdown entry that can
 * only ever draw an empty chart reads as a broken page.
 */
const CATEGORIES = ['grain', 'fuel', 'fertilizer'] as const satisfies readonly CommodityCategory[];

const CHARTABLE = new Set<string>(TREND_CHARTABLE);

function commoditiesFor(category: CommodityCategory): Commodity[] {
    return commoditiesInCategory(category).filter((c): c is Commodity => CHARTABLE.has(c));
}

/** The category a slug belongs to — used to open on the right tab. */
function categoryOf(commodity: Commodity): CommodityCategory {
    return commodityMeta(commodity)?.category ?? 'grain';
}

// Token-backed series palette (currentColor drives chart fill/stroke; the
// legend dot uses the matching bg-*). Assigned by a series' global index so a
// region keeps the same hue across every unit-group chart on the tab.
const SERIES_TEXT = [
    'text-brand-default',
    'text-content-success',
    'text-content-info',
    'text-content-warning',
    'text-content-error',
    'text-brand-emphasis',
];
const SERIES_DOT = [
    'bg-brand-default',
    'bg-content-success',
    'bg-content-info',
    'bg-content-warning',
    'bg-content-error',
    'bg-brand-emphasis',
];

// ─── Stat tile ───────────────────────────────────────────────────────

function StatTile({
    label,
    value,
    sub,
    tone,
    footer,
}: {
    label: string;
    value: string;
    sub?: string;
    tone?: 'up' | 'down' | 'flat';
    /** Provenance line — source, stage and observation date. */
    footer?: React.ReactNode;
}) {
    const toneClass =
        tone === 'up'
            ? 'text-content-success'
            : tone === 'down'
              ? 'text-content-error'
              : 'text-content-muted';
    return (
        <Card density="compact" className="min-w-[140px] flex-1">
            <p className="text-xs text-content-muted">{label}</p>
            <p className="metric-gradient font-display mt-0.5 text-2xl font-semibold tabular-nums">
                {value}
            </p>
            {sub !== undefined && (
                <p className={`text-xs tabular-nums ${toneClass}`}>{sub}</p>
            )}
            {footer}
        </Card>
    );
}

// ─── Unit-group chart ────────────────────────────────────────────────

function UnitGroupChart({
    unit,
    merged,
    series,
    colorIndex,
    commodityLabel,
}: {
    unit: string;
    merged: MergedDatum[];
    series: TrendSeries[];
    colorIndex: Map<string, number>;
    commodityLabel: string;
}) {
    const t = useTranslations('trends');
    const chartSeries = useMemo<Series<Record<string, number>>[]>(
        () =>
            series.map((s) => {
                const k = seriesKey(s);
                const idx = colorIndex.get(k) ?? 0;
                return {
                    id: k,
                    isActive: true,
                    valueAccessor: (d) => d.values[k] ?? 0,
                    colorClassName: SERIES_TEXT[idx % SERIES_TEXT.length],
                };
            }),
        [series, colorIndex],
    );

    return (
        <Card className="space-y-default">
            <div className="flex items-baseline justify-between gap-tight">
                <Heading level={3}>{commodityLabel}</Heading>
                {/* Currency/unit rides the axis caption — units never mix on
                    one axis, so each group's chart declares its own. */}
                <span className="text-xs font-medium text-content-muted tabular-nums">
                    {unit}
                </span>
            </div>

            {/* Source-tagged legend. */}
            <ul className="flex flex-wrap gap-default text-xs">
                {series.map((s) => {
                    const idx = colorIndex.get(seriesKey(s)) ?? 0;
                    return (
                        <li key={seriesKey(s)} className="flex items-center gap-tight">
                            <span
                                aria-hidden="true"
                                className={`h-2 w-2 rounded-full ${SERIES_DOT[idx % SERIES_DOT.length]}`}
                            />
                            <span className="text-content-muted">
                                {t(`sources.${sourceLabelKey(s.source)}`)}
                            </span>
                            <span className="font-medium text-content-default">{s.region}</span>
                        </li>
                    );
                })}
            </ul>

            <div
                className="h-56"
                role="img"
                aria-label={t('chartAria', { commodity: commodityLabel, unit })}
            >
                <TimeSeriesChart<Record<string, number>>
                    type="area"
                    data={merged}
                    series={chartSeries}
                >
                    <YAxis showGridLines />
                    <Areas />
                    <XAxis />
                </TimeSeriesChart>
            </div>
        </Card>
    );
}

// ─── Prices tab ──────────────────────────────────────────────────────

export function PricesTab() {
    const t = useTranslations('trends');
    // Operator hints name environment variables; only admins should see them.
    const permissions = usePermissions();
    const isAdmin = permissions.admin.manage;
    // The stated interest drives which price opens first.
    //
    // UserInterest persisted and synced across devices, but its ONLY consumer
    // was the news For-You filter — so a farmer who told us they grow
    // sunflower still landed on wheat every single time they opened Prices.
    // The preference existed and the product ignored it.
    const { data: interestsData } = useTenantSWR<{ keywords: string[] }>(
        CACHE_KEYS.me.interests(),
    );
    const preferred = useMemo(
        () => firstInterestedCommodity(interestsData?.keywords),
        [interestsData],
    );
    const [commodity, setCommodity] = useState<Commodity | null>(null);
    const [category, setCategory] = useState<CommodityCategory | null>(null);
    const [range, setRange] = useState<Range>('3m');

    // `null` until interests load, then the preferred one — but ONLY while the
    // user has not chosen. An interests fetch resolving late must never yank
    // the picker out from under someone who already selected a commodity.
    //
    // `preferred` can only ever be a CROP: firstInterestedCommodity resolves
    // free-text keywords through the crop-only `normalizeCommodity`, so a
    // farmer whose interests mention дизел is not dropped onto the diesel
    // chart by a feature they never asked for.
    const effectiveCommodity: Commodity = commodity ?? preferred ?? 'wheat';

    // The category follows the commodity unless the user picked one. Changing
    // category necessarily changes the valid set, so it defaults to the first
    // commodity of the new category — but a selection that is STILL VALID is
    // never reset, which is the same promise the commodity picker already made.
    const effectiveCategory: CommodityCategory = category ?? categoryOf(effectiveCommodity);
    const categoryCommodities = useMemo(() => commoditiesFor(effectiveCategory), [effectiveCategory]);
    const commodityInCategory = categoryCommodities.includes(effectiveCommodity);
    const shownCommodity: Commodity = commodityInCategory
        ? effectiveCommodity
        : (categoryCommodities[0] ?? 'wheat');

    const { data, error } = useTenantSWR<TrendPricesResponse>(
        CACHE_KEYS.trends.prices(shownCommodity, range),
    );

    const categoryOptions = useMemo(
        () => CATEGORIES.map((c) => ({ id: c, label: t(`categories.${c}`) })),
        [t],
    );
    const commodityOptions = useMemo<ComboboxOption[]>(
        () => categoryCommodities.map((c) => ({ value: c, label: t(`commodities.${c}`) })),
        [categoryCommodities, t],
    );
    const selectedCommodity = useMemo<ComboboxOption>(
        () => ({ value: shownCommodity, label: t(`commodities.${shownCommodity}`) }),
        [shownCommodity, t],
    );
    const rangeOptions = useMemo(
        () => RANGES.map((r) => ({ id: r, label: t(`ranges.${r}`) })),
        [t],
    );

    const colorIndex = useMemo(() => {
        const m = new Map<string, number>();
        (data?.series ?? []).forEach((s, i) => m.set(seriesKey(s), i));
        return m;
    }, [data]);

    const groups = useMemo(
        () => (data ? groupSeriesByRegionUnit(data.series) : []),
        [data],
    );

    // ── Stat-tile derivations ──
    //
    // The three crop tiles look up EC / listings / Alpha Vantage BY NAME, and
    // none of those publish diesel or fertiliser — so for an input they would
    // render three "no data" tiles above a perfectly good chart. Inputs get a
    // single tile driven by whichever series actually reported most recently.
    const isInput = commodityMeta(shownCommodity)?.kind === 'input';
    const tiles = useMemo(() => {
        if (!data) return null;
        const ec = findEcSeries(data.series, 'BG');
        const listings = findListingsSeries(data.series);
        const reference = findReferenceSeries(data.series);
        return { ec, listings, reference };
    }, [data]);
    const primary = useMemo(() => (data ? primarySeries(data.series) : null), [data]);

    // ── Practices (always visible so a user can switch even on empty) ──
    const practices = (
        <div className="flex flex-col gap-default sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-default sm:flex-row sm:items-end">
                <TabSelect<CommodityCategory>
                    options={categoryOptions}
                    selected={effectiveCategory}
                    onSelect={(next: CommodityCategory) => {
                        setCategory(next);
                        // Do NOT reset a still-valid selection. Only when the
                        // chosen commodity does not exist in the new category
                        // does the picker move, and then to that category's
                        // first entry rather than to nothing.
                        const options = commoditiesFor(next);
                        if (!options.includes(shownCommodity)) {
                            setCommodity(options[0] ?? null);
                        }
                    }}
                    ariaLabel={t('categories.ariaLabel')}
                    idPrefix="trends-category-"
                />
                <div className="w-full sm:max-w-[220px]">
                    <FormField label={t('commodityLabel')}>
                        <Combobox
                            options={commodityOptions}
                            selected={selectedCommodity}
                            setSelected={(opt) => {
                                if (opt) setCommodity(opt.value as Commodity);
                            }}
                            searchPlaceholder={t('commoditySearchPlaceholder')}
                        />
                    </FormField>
                </div>
            </div>
            <TabSelect<Range>
                options={rangeOptions}
                selected={range}
                onSelect={setRange}
                ariaLabel={t('rangeAriaLabel')}
                idPrefix="trends-range-"
            />
        </div>
    );

    const isLoading = !data && !error;
    // ERROR and EMPTY are different facts and must not share a rendering.
    // They used to be collapsed (`error != null || isEmptyPayload(data)`), so a
    // 500, a 429 from the read limiter, and a dropped rural connection all read
    // as "No data for this period" — a confident claim that the market was
    // quiet — followed by a lecture about environment variables the reader
    // cannot set. A farmer on a bad signal was told the market had no prices.
    const isError = error != null;
    const empty = !isError && data != null && isEmptyPayload(data);

    return (
        <div className="space-y-section" id="trends-prices-panel">
            {practices}

            {isLoading ? (
                <div className="space-y-default" data-testid="trends-loading">
                    <div className="flex gap-default">
                        <Skeleton className="h-20 flex-1" />
                        <Skeleton className="h-20 flex-1" />
                        <Skeleton className="h-20 flex-1" />
                    </div>
                    <Skeleton className="h-72 w-full" />
                </div>
            ) : isError ? (
                <ErrorState
                    title={t('error.title')}
                    description={t('error.description')}
                    data-testid="trends-error"
                />
            ) : empty ? (
                <EmptyState
                    variant="no-records"
                    title={isInput ? t('noSeries.title') : t('empty.title')}
                    description={isInput ? t('noSeries.body') : t('empty.description')}
                    data-testid="trends-empty"
                >
                    {/* Operator-configuration explainer, ADMINS ONLY.
                        It names environment variables — EC_AGRIFOOD_BASE_URL,
                        ALPHA_VANTAGE_API_KEY — which is an instruction a
                        farmer cannot act on and should not have to read. It
                        also leaks a little of our deployment shape to every
                        user of every tenant. Operators still see it; everyone
                        else gets the plain empty state. */}
                    {isAdmin && (
                        <div
                            className="mt-default rounded-lg border border-border-subtle bg-bg-muted px-4 py-3 text-left"
                            data-testid="trends-operator-hint"
                        >
                            <p className="text-xs font-semibold text-content-emphasis">
                                {t('operator.title')}
                            </p>
                            <p className="mt-1 text-xs text-content-muted">
                                {t('operator.body', {
                                    ec: 'EC_AGRIFOOD_BASE_URL',
                                    av: 'ALPHA_VANTAGE_API_KEY',
                                })}
                            </p>
                        </div>
                    )}
                </EmptyState>
            ) : (
                <>
                    {/* Stat tiles — wrap on 390px. */}
                    <div className="flex flex-wrap gap-default">
                        {isInput ? (
                            <StatTile
                                label={t('tiles.bgLatest')}
                                value={
                                    primary && latestPoint(primary)
                                        ? formatPriceWithCurrency(
                                              latestPoint(primary)!.price,
                                              primary.currency,
                                          )
                                        : t('tiles.noData')
                                }
                                footer={
                                    primary && data ? (
                                        // Source SHOWN, not hidden: a hand-typed
                                        // fertiliser price and a fed one must not
                                        // look alike here of all places.
                                        <SeriesProvenance
                                            series={primary}
                                            generatedAt={data.generatedAt}
                                            className="mt-1"
                                        />
                                    ) : undefined
                                }
                            />
                        ) : (
                        <>
                        <StatTile
                            label={t('tiles.bgLatest')}
                            value={
                                tiles?.ec && latestPoint(tiles.ec)
                                    ? formatPriceWithCurrency(
                                          latestPoint(tiles.ec)!.price,
                                          tiles.ec.currency,
                                      )
                                    : t('tiles.noData')
                            }
                            sub={
                                tiles?.ec && weekOverWeekDelta(tiles.ec) != null
                                    ? formatDelta(weekOverWeekDelta(tiles.ec)!)
                                    : undefined
                            }
                            tone={
                                tiles?.ec && weekOverWeekDelta(tiles.ec) != null
                                    ? weekOverWeekDelta(tiles.ec)! > 0
                                        ? 'up'
                                        : weekOverWeekDelta(tiles.ec)! < 0
                                          ? 'down'
                                          : 'flat'
                                    : undefined
                            }
                            footer={
                                tiles?.ec && data ? (
                                    <SeriesProvenance
                                        series={tiles.ec}
                                        generatedAt={data.generatedAt}
                                        hideSource
                                        className="mt-1"
                                    />
                                ) : undefined
                            }
                        />
                        <StatTile
                            label={t('tiles.listings')}
                            value={
                                tiles?.listings && latestPoint(tiles.listings)
                                    ? formatPriceWithCurrency(
                                          latestPoint(tiles.listings)!.price,
                                          tiles.listings.currency,
                                      )
                                    : t('tiles.noData')
                            }
                            sub={
                                tiles?.listings && latestPoint(tiles.listings)?.count != null
                                    ? t('tiles.listingsCount', {
                                          count: latestPoint(tiles.listings)!.count!,
                                      })
                                    : undefined
                            }
                            footer={
                                tiles?.listings && data ? (
                                    <SeriesProvenance
                                        series={tiles.listings}
                                        generatedAt={data.generatedAt}
                                        hideSource
                                        className="mt-1"
                                    />
                                ) : undefined
                            }
                        />
                        <StatTile
                            label={t('tiles.reference')}
                            value={
                                tiles?.reference && latestPoint(tiles.reference)
                                    ? formatPriceWithCurrency(
                                          latestPoint(tiles.reference)!.price,
                                          tiles.reference.currency,
                                      )
                                    : t('tiles.noData')
                            }
                            sub={
                                tiles?.reference && weekOverWeekDelta(tiles.reference) != null
                                    ? formatDelta(weekOverWeekDelta(tiles.reference)!)
                                    : undefined
                            }
                            tone={
                                tiles?.reference && weekOverWeekDelta(tiles.reference) != null
                                    ? weekOverWeekDelta(tiles.reference)! > 0
                                        ? 'up'
                                        : weekOverWeekDelta(tiles.reference)! < 0
                                          ? 'down'
                                          : 'flat'
                                    : undefined
                            }
                            footer={
                                tiles?.reference && data ? (
                                    <SeriesProvenance
                                        series={tiles.reference}
                                        generatedAt={data.generatedAt}
                                        hideSource
                                        className="mt-1"
                                    />
                                ) : undefined
                            }
                        />
                        </>
                        )}
                    </div>

                    {/* One chart per unit-group. */}
                    {groups.map((g) => (
                        <UnitGroupChart
                            key={g.key}
                            unit={g.unit}
                            merged={buildMergedData(g)}
                            series={g.series}
                            colorIndex={colorIndex}
                            commodityLabel={t(`commodities.${shownCommodity}`)}
                        />
                    ))}
                </>
            )}
        </div>
    );
}
