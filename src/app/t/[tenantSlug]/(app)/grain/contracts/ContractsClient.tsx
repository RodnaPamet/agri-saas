'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Row } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    filterStateToUrlParams,
    useFilterContext,
    useFilters,
    type FilterType,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { Tooltip } from '@/components/ui/tooltip';
import { Pen2, Trash } from '@/components/ui/icons/nucleo';
import { useToastWithUndo } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import {
    buildContractFilters,
    CONTRACT_FILTER_KEYS,
} from './filter-defs';
import { ContractFormModal } from './ContractFormModal';

// ─── Types ───
//
// RAW Prisma Contract model: Decimal columns serialize as STRINGS over
// JSON. Parse with Number(...) for display; keep them as strings on the
// row so the edit form can round-trip them losslessly.
export interface ContractRow {
    id: string;
    seasonId: string | null;
    key: string | null;
    counterparty: string;
    commodity: string | null;
    type: 'SALE' | 'PURCHASE';
    status: 'DRAFT' | 'ACTIVE' | 'DELIVERED' | 'SETTLED' | 'CANCELLED';
    volumeTonnes: string | null;
    pricePerTonne: string | null;
    priceCurrency: string | null;
    deliveryStart: string | null;
    deliveryEnd: string | null;
    terms: string | null;
    pricingNotes: string | null;
    createdAt: string;
    updatedAt: string;
    season?: { id: string; name: string; status: string } | null;
}

interface ContractsClientProps {
    initialContracts: ContractRow[];
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

/** Format a string|null decimal for display; right-aligned tabular-nums. */
function fmtNum(v: string | null): string {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function ContractsClient(props: ContractsClientProps) {
    const filterCtx = useFilterContext([], CONTRACT_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <ContractsPageInner {...props} />
        </FilterProvider>
    );
}

function ContractsPageInner({
    initialContracts,
    tenantSlug,
    permissions,
}: ContractsClientProps) {
    const t = useTranslations('grain.contracts');
    const tEnums = useTranslations('grainEnums');
    const apiUrl = useCallback(
        (path: string) => `/api/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const queryClient = useQueryClient();
    const triggerUndoToast = useToastWithUndo();

    const filterCtx = useFilters();
    const { state, search, hasActive, clearAll } = filterCtx;

    // Create / edit modal state. A null `editing` with the modal open is a
    // create; a row sets edit mode.
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<ContractRow | null>(null);

    // ─── API query string from filter state (status + type only) ───
    const filtersForQuery = useMemo(() => {
        const params = filterStateToUrlParams(state);
        // `q` is not a server param for contracts — search filters loaded
        // rows in-memory below.
        return params;
    }, [state]);

    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of filtersForQuery) obj[k] = v;
        return obj;
    }, [filtersForQuery]);

    // Only hydrate from SSR when no facet is active (the SSR slice is the
    // unfiltered newest-first list).
    const noFacets = Object.keys(queryKeyFilters).length === 0;

    const contractsQuery = useQuery<ContractRow[]>({
        queryKey: ['grain-contracts', tenantSlug, 'list', queryKeyFilters],
        queryFn: async () => {
            const qs = filtersForQuery.toString();
            const res = await fetch(apiUrl(`/grain/contracts${qs ? `?${qs}` : ''}`));
            if (!res.ok) throw new Error('Failed to fetch contracts');
            return res.json();
        },
        initialData: noFacets ? initialContracts : undefined,
        // eslint-disable-next-line react-hooks/purity
        initialDataUpdatedAt: noFacets ? Date.now() : 0,
        staleTime: 30_000,
    });

    // Stable ref so the search memo below doesn't recompute every render
    // (query.data ?? [] would mint a fresh array each pass).
    const rawContracts = useMemo(
        () => contractsQuery.data ?? [],
        [contractsQuery.data],
    );
    const loading = contractsQuery.isLoading && !contractsQuery.data;

    // A failed list read must NOT fall through to the empty state — an
    // unreachable API, a 403, or a 500 rendered as "No contracts match
    // your filters", i.e. a confident claim of zero rows. Surface it as
    // an error instead.
    //
    // Gated on having nothing to show: when a background refetch fails
    // but cached/SSR rows are still on screen, keep the rows (the
    // DataTable renders `error` INSTEAD of the table, so raising it here
    // would blank good data).
    const loadError =
        contractsQuery.isError && rawContracts.length === 0
            ? t('loadFailed')
            : undefined;

    // Live free-text search (counterparty / commodity) over loaded rows —
    // FilterToolbar's search box is live (no Enter).
    const contracts = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return rawContracts;
        // guardrail-ignore: in-memory text filter over the loaded page, not a DB query.
        return rawContracts.filter(
            (c) =>
                c.counterparty.toLowerCase().includes(q) ||
                (c.commodity ?? '').toLowerCase().includes(q),
        );
    }, [rawContracts, search]);

    const liveFilterDefs: FilterType[] = useMemo(
        () => buildContractFilters(tEnums),
        [tEnums],
    );

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['grain-contracts', tenantSlug] });
    }, [queryClient, tenantSlug]);

    const handleDelete = useCallback(
        (contract: ContractRow) => {
            const listKey = [
                'grain-contracts',
                tenantSlug,
                'list',
                queryKeyFilters,
            ];
            const previous =
                queryClient.getQueryData<ContractRow[]>(listKey);
            // Optimistic remove.
            queryClient.setQueryData<ContractRow[]>(listKey, (old) =>
                (old ?? []).filter((c) => c.id !== contract.id),
            );
            triggerUndoToast({
                message: t('deletedToast', { counterparty: contract.counterparty }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(
                        apiUrl(`/grain/contracts/${contract.id}`),
                        { method: 'DELETE' },
                    );
                    if (!res.ok) throw new Error('Delete contract failed');
                },
                undoAction: () => {
                    if (previous) queryClient.setQueryData(listKey, previous);
                },
                onError: () => {
                    if (previous) queryClient.setQueryData(listKey, previous);
                },
                onCommit: () => refetch(),
            });
        },
        [apiUrl, queryClient, queryKeyFilters, refetch, tenantSlug, triggerUndoToast, t],
    );

    const handleRowClick = useCallback(
        (row: Row<ContractRow>) => {
            if (!permissions.canWrite) return;
            setEditing(row.original);
            setIsCreateOpen(true);
        },
        [permissions.canWrite],
    );
    const getRowId = useCallback((c: ContractRow) => c.id, []);

    const columns = useMemo(
        () =>
            createColumns<ContractRow>([
                {
                    accessorKey: 'counterparty',
                    header: t('colCounterparty'),
                    cell: ({ row }) => (
                        <TableTitleCell id={`contract-link-${row.original.id}`}>
                            {row.original.counterparty}
                        </TableTitleCell>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'commodity',
                    header: t('colCommodity'),
                    accessorFn: (c) => c.commodity ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue() as string}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    accessorKey: 'type',
                    header: t('colType'),
                    cell: ({ row }) => (
                        <AgStatusBadge entity="contractType" status={row.original.type} />
                    ),
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <AgStatusBadge entity="contract" status={row.original.status} />
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'volumeTonnes',
                    header: t('colVolume'),
                    accessorFn: (c) => c.volumeTonnes ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums tracking-tight block text-right">
                            {fmtNum(row.original.volumeTonnes)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colVolume') } },
                },
                {
                    id: 'pricePerTonne',
                    header: t('colPrice'),
                    accessorFn: (c) => c.pricePerTonne ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums tracking-tight block text-right">
                            {fmtNum(row.original.pricePerTonne)}
                            {row.original.priceCurrency
                                ? ` ${row.original.priceCurrency}`
                                : ''}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colPrice') } },
                },
                {
                    id: 'deliveryStart',
                    header: t('colDelivery'),
                    accessorFn: (c) => c.deliveryStart ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {formatDate(row.original.deliveryStart)}
                        </span>
                    ),
                },
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) =>
                        permissions.canWrite ? (
                            <div className="flex items-center justify-end gap-tight">
                                <Tooltip content={t('editContract')}>
                                    <button
                                        type="button"
                                        aria-label={t('editContract')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`contract-edit-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setEditing(row.original);
                                            setIsCreateOpen(true);
                                        }}
                                    >
                                        <Pen2 className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('deleteContract')}>
                                    <button
                                        type="button"
                                        aria-label={t('deleteContract')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-error hover:text-content-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`contract-delete-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDelete(row.original);
                                        }}
                                    >
                                        <Trash className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                            </div>
                        ) : null,
                },
            ]),
        [permissions.canWrite, handleDelete, t],
    );

    return (
        <EntityListPage<ContractRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('breadcrumbContracts') },
                ],
                title: t('title'),
                description: t('description'),
                actions: permissions.canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        id="new-contract-btn"
                        onClick={() => {
                            setEditing(null);
                            setIsCreateOpen(true);
                        }}
                    >
                        {t('newContract')}
                    </Button>
                ) : null,
            }}
            filters={{
                defs: liveFilterDefs,
                searchId: 'grain-contracts-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: contracts,
                columns,
                loading,
                error: loadError,
                getRowId,
                mobileFallback: 'card',
                onRowClick: permissions.canWrite ? handleRowClick : undefined,
                emptyState: hasActive || search ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('emptyNoResultsTitle')}
                        description={t('emptyNoResultsDesc')}
                        secondaryAction={{ label: t('clearFilters'), onClick: () => clearAll() }}
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
                                      label: t('addContract'),
                                      onClick: () => {
                                          setEditing(null);
                                          setIsCreateOpen(true);
                                      },
                                  }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('contracts') : t('contract')),
                'data-testid': 'grain-contracts-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <ContractFormModal
                    open={isCreateOpen}
                    setOpen={setIsCreateOpen}
                    tenantSlug={tenantSlug}
                    contract={editing}
                    onSaved={refetch}
                />
            )}
        </EntityListPage>
    );
}
