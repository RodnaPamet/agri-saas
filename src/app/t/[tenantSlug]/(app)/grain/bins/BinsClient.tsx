'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Row } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { GrainSectionNav } from '../GrainSectionNav';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { ProgressBar } from '@/components/ui/progress-bar';
import { formatDecimal } from '@/lib/number-format';
import { BinFormModal } from './BinFormModal';

// ─── Types ───
// BinDto — plain numbers (the usecase already coerces Decimals).
export interface BinRow {
    id: string;
    name: string;
    key: string | null;
    kind: 'BIN' | 'STORAGE';
    description: string | null;
    capacityTonnes: number | null;
    /** Stored produce CONVERTED to tonnes — comparable to capacityTonnes. */
    storedTonnes: number;
    lotCount: number;
    /** Ratio storedTonnes / capacity (0..1+); null without a capacity or when mixedUnits. */
    fillPct: number | null;
    /** Bin holds stock with no tonnage (e.g. `each`), so no honest fill exists. */
    mixedUnits: boolean;
    /** That unconvertible stock, per unit. */
    unconvertible: { unitKey: string; symbol: string; quantity: number; lotCount: number }[];
}

interface BinsClientProps {
    initialBins: BinRow[];
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

function fmtNum(v: number | null): string {
    if (v == null) return '—';
    return formatDecimal(v, 2);
}

export function BinsClient(props: BinsClientProps) {
    // Bins have no faceted filters — the empty key set still gives the
    // FilterToolbar a context for its live search box.
    const filterCtx = useFilterContext([], [] as const, {});
    return (
        <FilterProvider value={filterCtx}>
            <BinsPageInner {...props} />
        </FilterProvider>
    );
}

function BinsPageInner({ initialBins, tenantSlug, permissions }: BinsClientProps) {
    const t = useTranslations('grain.bins');
    const router = useRouter();
    const apiUrl = useCallback(
        (path: string) => `/api/t/${tenantSlug}${path}`,
        [tenantSlug],
    );

    const filterCtx = useFilters();
    const { search } = filterCtx;

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    // No `editing` state: the list creates, the detail page edits. Keeping a
    // never-set editing slot here would imply the list still edits.

    const binsQuery = useQuery<BinRow[]>({
        queryKey: ['grain-bins', tenantSlug, 'list'],
        queryFn: async () => {
            const res = await fetch(apiUrl('/grain/bins'));
            if (!res.ok) throw new Error('Failed to fetch bins');
            return res.json();
        },
        initialData: initialBins,
        // eslint-disable-next-line react-hooks/purity
        initialDataUpdatedAt: Date.now(),
        staleTime: 30_000,
    });

    // Stable ref so the search memo below doesn't recompute every render.
    const rawBins = useMemo(() => binsQuery.data ?? [], [binsQuery.data]);
    const loading = binsQuery.isLoading && !binsQuery.data;

    // A failed list read must surface as an error, not as the empty
    // state (which claims zero rows). Gated on having nothing to show so
    // a failed background refetch never blanks cached/SSR rows — the
    // DataTable renders `error` INSTEAD of the table.
    const loadError =
        binsQuery.isError && rawBins.length === 0 ? t('loadFailed') : undefined;

    // Live free-text search (name / key) over loaded rows.
    const bins = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return rawBins;
        // guardrail-ignore: in-memory text filter over the loaded page, not a DB query.
        return rawBins.filter(
            (b) =>
                b.name.toLowerCase().includes(q) ||
                (b.key ?? '').toLowerCase().includes(q),
        );
    }, [rawBins, search]);

    const handleRowClick = useCallback(
        (row: Row<BinRow>) => {
            // Opens the bin DETAIL page. It used to open the edit form, which
            // meant a READER — who cannot write — got a completely inert
            // table, and the purpose-built read endpoint had no callers.
            // Editing now lives on the detail page.
            router.push(`/t/${tenantSlug}/grain/bins/${row.original.id}`);
        },
        [router, tenantSlug],
    );
    const getRowId = useCallback((b: BinRow) => b.id, []);

    const columns = useMemo(
        () =>
            createColumns<BinRow>([
                {
                    accessorKey: 'name',
                    header: t('colName'),
                    cell: ({ row }) => (
                        <TableTitleCell id={`bin-link-${row.original.id}`}>
                            {row.original.name}
                        </TableTitleCell>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    accessorKey: 'kind',
                    header: t('colKind'),
                    cell: ({ row }) => (
                        <AgStatusBadge entity="bin" status={row.original.kind} />
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colKind') } },
                },
                {
                    id: 'capacityTonnes',
                    header: t('colCapacity'),
                    accessorFn: (b) => b.capacityTonnes ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums block text-right">
                            {fmtNum(row.original.capacityTonnes)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colCapacity') } },
                },
                {
                    id: 'storedTonnes',
                    header: t('colStored'),
                    accessorFn: (b) => b.storedTonnes,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums block text-right">
                            {fmtNum(row.original.storedTonnes)}
                            {/* Stock with no tonnage is listed beside the tonnes
                                rather than folded into them — numbers + unit
                                symbols only, so no i18n key is needed. */}
                            {row.original.unconvertible.map((u) => (
                                <span
                                    key={u.unitKey}
                                    className="block text-content-subtle"
                                >
                                    {`+${fmtNum(u.quantity)} ${u.symbol}`}
                                </span>
                            ))}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colStored') } },
                },
                {
                    id: 'fillPct',
                    header: t('colFill'),
                    accessorFn: (b) => b.fillPct ?? -1,
                    cell: ({ row }) => {
                        const ratio = row.original.fillPct;
                        if (ratio == null) {
                            // Distinguish "no capacity configured" (—) from
                            // "capacity set but the contents have no tonnage",
                            // so a suppressed fill bar is explained rather than
                            // just blank.
                            return (
                                <span className="text-xs text-content-subtle">
                                    {row.original.mixedUnits
                                        ? t('fillMixedUnits')
                                        : '—'}
                                </span>
                            );
                        }
                        const pct = Math.round(ratio * 100);
                        return (
                            <ProgressBar
                                value={pct}
                                variant={pct >= 100 ? 'warning' : 'success'}
                                size="sm"
                                showValue
                                className="w-24"
                                aria-label={t('fillAria', { pct })}
                            />
                        );
                    },
                    meta: { mobileCard: { slot: 'meta', label: t('colFill') } },
                },
                {
                    id: 'lotCount',
                    header: t('colLots'),
                    accessorFn: (b) => b.lotCount,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums">
                            {row.original.lotCount}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    return (
        <EntityListPage<BinRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('breadcrumbBins') },
                ],
                title: t('title'),
                description: t('description'),
                actions: permissions.canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        id="new-bin-btn"
                        onClick={() => setIsCreateOpen(true)}
                    >
                        {t('newBin')}
                    </Button>
                ) : null,
            }}
            filters={{
                defs: [],
                searchId: 'grain-bins-search',
                searchPlaceholder: t('searchPlaceholder'),
                toolbarActions: (
                    <GrainSectionNav tenantSlug={tenantSlug} active="bins" />
                ),
            }}
            table={{
                data: bins,
                columns,
                loading,
                error: loadError,
                getRowId,
                mobileFallback: 'card',
                onRowClick: permissions.canWrite ? handleRowClick : undefined,
                emptyState: search ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('emptyNoResultsTitle')}
                        description={t('emptyNoResultsDesc')}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        primaryAction={
                            permissions.canWrite
                                ? {
                                      label: t('addBin'),
                                      onClick: () => setIsCreateOpen(true),
                                  }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('bins') : t('bin')),
                'data-testid': 'grain-bins-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <BinFormModal
                    open={isCreateOpen}
                    setOpen={setIsCreateOpen}
                    tenantSlug={tenantSlug}
                    onSaved={() => binsQuery.refetch()}
                />
            )}
        </EntityListPage>
    );
}
