'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { StackY3 } from '@/components/ui/icons/nucleo/stack-y-3';
import { ArrowTrendUp } from '@/components/ui/icons/nucleo/arrow-trend-up';
import { MoneyBill } from '@/components/ui/icons/nucleo/money-bill';
import { BoxArchive } from '@/components/ui/icons/nucleo/box-archive';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { StatusBreakdown, type StatusBreakdownItem } from '@/components/ui/status-breakdown';
import { EmptyState } from '@/components/ui/empty-state';
import KpiCard from '@/components/ui/KpiCard';
import { Heading } from '@/components/ui/typography';
import { formatDecimal } from '@/lib/number-format';
import type {
    PortfolioGrainSummary,
    PortfolioGrainTenantRow,
    PortfolioGrainSeasonRow,
} from '@/app-layer/usecases/portfolio-grain';

/**
 * Org portfolio grain dashboard (client island).
 *
 * Pure presentation over the server-computed `PortfolioGrainSummary`:
 *   - four KPI tiles for the org totals,
 *   - a per-farm yield breakdown visual (shared `<StatusBreakdown>`),
 *   - a per-tenant `<DataTable>` (contracted / yield / cost / bin fill).
 *
 * No fetching, no mutation — the cross-tenant aggregation already ran
 * server-side inside the RLS-bound fan-out.
 */

interface Props {
    summary: PortfolioGrainSummary;
}

/** Currency symbol from an ISO-ish code (EUR → €, GBP → £, USD → $),
 *  falling back to the code itself, then '€' (demo default). */
function currencySymbol(currency: string | null): string {
    switch (currency) {
        case 'EUR':
            return '€';
        case 'GBP':
            return '£';
        case 'USD':
            return '$';
        case null:
        case undefined:
            return '€';
        default:
            return `${currency} `;
    }
}

function formatTonnes(n: number): string {
    return `${formatDecimal(n, 1)} t`;
}

function formatCost(n: number, currency: string | null): string {
    const sym = currencySymbol(currency);
    if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(0)}K`;
    return `${sym}${Math.round(n).toLocaleString()}`;
}

export function PortfolioGrainClient({ summary }: Props) {
    const t = useTranslations('grain.portfolio');
    const { totals, perTenant } = summary;
    // Older cached payloads predate the per-season rollup — default so a
    // stale response degrades to "no season table" rather than crashing.
    const perSeason = summary.perSeason ?? [];
    const sym = currencySymbol(totals.currency);

    const [sortBy, setSortBy] = useState<string>('tenantName');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

    const hasGrain = totals.tenantsWithGrain > 0;

    // Per-farm yield breakdown — the ONE visual. Drops zero-yield farms
    // so the chart stays legible; the full table below still lists them.
    const yieldByFarm = useMemo<StatusBreakdownItem[]>(
        () =>
            perTenant
                .filter((r) => r.totalYieldTonnes > 0)
                .sort((a, b) => b.totalYieldTonnes - a.totalYieldTonnes)
                .map((r) => ({
                    id: r.tenantId,
                    label: r.tenantName,
                    value: Math.round(r.totalYieldTonnes),
                    variant: 'success' as const,
                })),
        [perTenant],
    );

    const sorted = useMemo(() => {
        const copy = [...perTenant];
        copy.sort((a, b) => {
            const dir = sortOrder === 'asc' ? 1 : -1;
            switch (sortBy) {
                case 'contractedSaleTonnes':
                    return dir * (a.contractedSaleTonnes - b.contractedSaleTonnes);
                case 'totalYieldTonnes':
                    return dir * (a.totalYieldTonnes - b.totalYieldTonnes);
                case 'totalActivityCost':
                    return dir * (a.totalActivityCost - b.totalActivityCost);
                case 'binStoredTonnes':
                    return dir * (a.binStoredTonnes - b.binStoredTonnes);
                case 'tenantName':
                default:
                    return dir * a.tenantName.localeCompare(b.tenantName);
            }
        });
        return copy;
    }, [perTenant, sortBy, sortOrder]);

    const seasonColumns = useMemo(
        () =>
            createColumns<PortfolioGrainSeasonRow>([
                {
                    id: 'seasonName',
                    header: t('colSeason'),
                    accessorFn: (r) => r.seasonName ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-emphasis">
                            {row.original.seasonName ?? t('seasonUnassigned')}
                        </span>
                    ),
                },
                {
                    id: 'contractedSaleTonnes',
                    header: t('colContractedSeason'),
                    accessorFn: (r) => r.contractedSaleTonnes,
                    cell: ({ row }) => (
                        <span className="text-xs tabular-nums text-content-default block text-right">
                            {formatTonnes(row.original.contractedSaleTonnes)}
                        </span>
                    ),
                },
                {
                    id: 'producedTonnes',
                    header: t('colProduced'),
                    accessorFn: (r) => r.producedTonnes,
                    cell: ({ row }) => (
                        <span className="text-xs tabular-nums text-content-default block text-right">
                            {formatTonnes(row.original.producedTonnes)}
                        </span>
                    ),
                },
                {
                    id: 'coveragePct',
                    header: t('colCoverage'),
                    accessorFn: (r) => r.coveragePct ?? -1,
                    cell: ({ row }) => {
                        const pct = row.original.coveragePct;
                        if (pct == null) {
                            // Produced nothing: a percentage of zero is
                            // undefined, not 0%.
                            return (
                                <span className="text-xs text-content-subtle block text-right">
                                    —
                                </span>
                            );
                        }
                        // Over 100% means more was sold than grown — the
                        // most actionable cell in this table, so it gets
                        // the warning tone rather than being clamped away.
                        return (
                            <span
                                className={`text-xs tabular-nums block text-right ${
                                    pct > 100
                                        ? 'text-content-warning font-medium'
                                        : 'text-content-default'
                                }`}
                            >
                                {pct.toFixed(1)}%
                            </span>
                        );
                    },
                },
                {
                    id: 'deltaTonnes',
                    header: t('colSurplus'),
                    accessorFn: (r) => r.deltaTonnes,
                    cell: ({ row }) => {
                        const delta = row.original.deltaTonnes;
                        return (
                            <span
                                className={`text-xs tabular-nums block text-right ${
                                    delta < 0 ? 'text-content-warning' : 'text-content-muted'
                                }`}
                            >
                                {delta > 0 ? '+' : ''}
                                {formatTonnes(delta)}
                            </span>
                        );
                    },
                },
            ]),
        [t],
    );

    const columns = useMemo(
        () =>
            createColumns<PortfolioGrainTenantRow>([
                {
                    id: 'tenantName',
                    header: t('colFarm'),
                    cell: ({ row }) => (
                        <span className="font-medium text-content-emphasis">
                            {row.original.tenantName}
                        </span>
                    ),
                },
                {
                    id: 'contractedSaleTonnes',
                    header: t('colContracted'),
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-default">
                            {formatTonnes(row.original.contractedSaleTonnes)}
                            <span className="text-content-subtle">
                                {' / '}
                                {formatTonnes(row.original.contractedPurchaseTonnes)}
                            </span>
                        </span>
                    ),
                },
                {
                    id: 'totalYieldTonnes',
                    header: t('colYield'),
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-default">
                            {formatTonnes(row.original.totalYieldTonnes)}
                        </span>
                    ),
                },
                {
                    id: 'totalActivityCost',
                    header: t('colActivityCost'),
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-default">
                            {formatCost(row.original.totalActivityCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'binStoredTonnes',
                    header: t('colBinFill'),
                    cell: ({ row }) => {
                        const { binStoredTonnes, binCapacityTonnes, binCount } = row.original;
                        if (binCount === 0) {
                            return <span className="text-content-subtle">—</span>;
                        }
                        const pct =
                            binCapacityTonnes > 0
                                ? Math.round((binStoredTonnes / binCapacityTonnes) * 100)
                                : null;
                        return (
                            <span className="tabular-nums text-content-default">
                                {formatTonnes(binStoredTonnes)}
                                {binCapacityTonnes > 0 && (
                                    <span className="text-content-subtle">
                                        {' / '}
                                        {formatTonnes(binCapacityTonnes)}
                                        {pct != null ? ` (${pct}%)` : ''}
                                    </span>
                                )}
                            </span>
                        );
                    },
                },
            ]),
        [t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div>
                    <Heading level={1}>{t('title')}</Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('subtitle', {
                            count: totals.tenantsTotal,
                            withGrain:
                                totals.tenantsWithGrain < totals.tenantsTotal
                                    ? t('withGrainData', { count: totals.tenantsWithGrain })
                                    : '',
                        })}
                    </p>
                </div>
            </ListPageShell.Header>

            {!hasGrain ? (
                <ListPageShell.Body>
                    <EmptyState
                        icon={StackY3}
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        variant="no-records"
                        data-testid="org-grain-empty"
                    />
                </ListPageShell.Body>
            ) : (
                <ListPageShell.Body>
                    <div className="space-y-section">
                        {/* KPI tiles — org totals. */}
                        <div
                            className="grid grid-cols-1 gap-default sm:grid-cols-2 xl:grid-cols-4"
                            data-testid="org-grain-kpis"
                        >
                            <KpiCard
                                label={t('kpiContractedSale')}
                                value={totals.contractedSaleTonnes}
                                format="compact"
                                icon={StackY3}
                                subtitle={t('kpiPurchaseSubtitle', { amount: formatTonnes(totals.contractedPurchaseTonnes) })}
                                trendPolarity="neutral"
                            />
                            {/* PRODUCTION, not stock. These two tiles sit
                                side by side and measure different things:
                                this one is everything harvested across every
                                recorded season, the bin tile is what is in
                                store right now. They are not additive, and
                                where the same grain appears in both (a
                                journal harvest that minted its yield record)
                                the subtitle says how much — otherwise a
                                group operator reading them as one total is
                                double-counting and cannot tell. */}
                            <KpiCard
                                label={t('kpiHarvestedYield')}
                                value={totals.totalYieldTonnes}
                                format="compact"
                                icon={ArrowTrendUp}
                                gradient="from-emerald-500 to-teal-500"
                                trendVariant="success"
                                subtitle={
                                    totals.yieldAlsoInStoreTonnes > 0
                                        ? t('kpiYieldAlsoInStore', {
                                              amount: formatTonnes(totals.yieldAlsoInStoreTonnes),
                                          })
                                        : t('kpiYieldProductionOnly')
                                }
                                trendPolarity="neutral"
                            />
                            {/* Contract value — the revenue side. Until
                                this landed the dashboard showed activity
                                COST with nothing to weigh it against, so
                                a group operator saw only money going
                                out. `mixedCurrency` is surfaced in the
                                subtitle rather than hidden: a partial
                                total presented as complete is worse than
                                no total. */}
                            <KpiCard
                                label={
                                    totals.currency
                                        ? t('kpiContractValueCurrency', {
                                              currency: totals.currency,
                                          })
                                        : t('kpiContractValue')
                                }
                                value={totals.contractedValue}
                                format="compact"
                                icon={MoneyBill}
                                gradient="from-lime-500 to-emerald-500"
                                subtitle={
                                    totals.mixedCurrency
                                        ? t('kpiContractValueMixed')
                                        : t('kpiContractValueSubtitle')
                                }
                                trendPolarity="neutral"
                            />
                            <KpiCard
                                label={t('kpiActivityCost')}
                                value={totals.totalActivityCost}
                                format="compact"
                                icon={MoneyBill}
                                gradient="from-amber-500 to-orange-500"
                                subtitle={
                                    totals.currency
                                        ? t('kpiTotalCurrency', { currency: totals.currency })
                                        : t('kpiTotal')
                                }
                                trendPolarity="neutral"
                            />
                            <KpiCard
                                label={t('kpiBinUtilisation')}
                                value={totals.binUtilisationPct}
                                format="percent"
                                icon={BoxArchive}
                                gradient="from-sky-500 to-indigo-500"
                                subtitle={t('kpiBinSubtitle', { stored: formatTonnes(totals.binStoredTonnes), capacity: formatTonnes(totals.binCapacityTonnes) })}
                                trendPolarity="neutral"
                            />
                        </div>

                        {/* Contracted-vs-produced per season — the rollup
                            `Contract.seasonId` has described in the schema
                            since the module shipped. Before this, contracted
                            tonnes and harvested tonnes rendered as two
                            unrelated tiles with nothing relating them. */}
                        {perSeason.length > 0 && (
                            <section
                                className="rounded-lg border border-border-default bg-bg-default p-4"
                                data-testid="org-grain-per-season"
                            >
                                <Heading level={3}>{t('seasonCoverage')}</Heading>
                                <p className="text-xs text-content-muted mt-1 mb-3">
                                    {t('seasonCoverageNote')}
                                </p>
                                <DataTable<PortfolioGrainSeasonRow>
                                    data={perSeason}
                                    mobileFallback="scroll"
                                    columns={seasonColumns}
                                    getRowId={(r) => r.seasonName ?? '__unassigned__'}
                                    data-testid="org-grain-season-table"
                                />
                            </section>
                        )}

                        {/* Yield-by-farm breakdown — the single visual. */}
                        {yieldByFarm.length > 0 && (
                            <section
                                className="rounded-lg border border-border-default bg-bg-default p-4"
                                data-testid="org-grain-yield-by-farm"
                            >
                                <Heading level={3}>{t('yieldByFarm')}</Heading>
                                <p className="text-xs text-content-muted mt-1 mb-3">
                                    {t('yieldByFarmNote', { sym })}
                                </p>
                                <StatusBreakdown
                                    items={yieldByFarm}
                                    showPercent
                                    ariaLabel={t('yieldByFarmAria')}
                                />
                            </section>
                        )}

                        {/* Per-tenant breakdown table.
                            mobileFallback="scroll" — this is a wide, dense
                            numeric portfolio grid (contracted / yield / cost /
                            bin-stored tonnes per farm). The figures only make
                            sense side-by-side for cross-farm comparison, so on
                            a phone we keep the horizontally-scrollable table
                            rather than collapse each farm row into a card. */}
                        <DataTable<PortfolioGrainTenantRow>
                            data={sorted}
                            mobileFallback="scroll"
                            columns={columns}
                            getRowId={(r) => r.tenantId}
                            sortableColumns={[
                                'tenantName',
                                'contractedSaleTonnes',
                                'totalYieldTonnes',
                                'totalActivityCost',
                                'binStoredTonnes',
                            ]}
                            sortBy={sortBy}
                            sortOrder={sortOrder}
                            onSortChange={(p) => {
                                if (p.sortBy) setSortBy(p.sortBy);
                                if (p.sortOrder) setSortOrder(p.sortOrder);
                            }}
                            resourceName={(plural) => (plural ? t('farms') : t('farm'))}
                            emptyState={
                                <TableEmptyState
                                    title={t('tableEmptyTitle')}
                                    description={t('tableEmptyDescription')}
                                    icon={<StackY3 className="size-10" />}
                                />
                            }
                            data-testid="org-grain-table"
                        />
                    </div>
                </ListPageShell.Body>
            )}
        </ListPageShell>
    );
}
