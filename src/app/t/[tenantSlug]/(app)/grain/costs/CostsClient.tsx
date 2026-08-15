'use client';

/**
 * Grain costs — the register where a farmer ENTERS a cost.
 *
 * ── What this page used to be, and why it stopped ───────────────────
 *
 * It was a read-only dimension-toggle rollup of
 * `COST_METRICS.ATTRIBUTED_CROP_COST` (planting / field / season). That
 * rollup is DROPPED, not moved: the grain net-worth calculator already
 * reports the same attributed-cost figure as part of a larger answer, and
 * `src/lib/grain/cost-metrics.ts` exists precisely because this product
 * once shipped the same word over three different numbers. Two pages
 * reporting one figure is the condition that created that module, so the
 * duplicate went rather than being relocated.
 *
 * What a farmer could not do anywhere was ENTER a cost without first
 * knowing which of five surfaces owned it. That is now this page.
 *
 * ── What an entry does NOT do ───────────────────────────────────────
 *
 * Nothing here writes into a domain's own ledger. `StockTransaction` is
 * hash-chained and append-only, needs a product and a quantity this form
 * does not collect, and would make a mistyped cost permanent. Domain
 * pages READ the entries that link to them instead — see the CostEntry
 * model docblock.
 *
 * ── Facets ──────────────────────────────────────────────────────────
 *
 * Category (multi-select) plus live search over supplier/currency. There
 * is deliberately no date facet: the filter platform has no date type
 * (`range` is numeric and truncates), so one is its own piece of work.
 * See `filter-defs.ts`.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Row } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Plus, Pen2, Trash, Paperclip } from '@/components/ui/icons/nucleo';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    filterStateToUrlParams,
    useFilterContext,
    useFilters,
    type FilterType,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { GrainSectionNav } from '../GrainSectionNav';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { useDebounce, useToastWithUndo } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import { buildCostFilters, COST_FILTER_KEYS } from './filter-defs';
import { CostEntryFormModal } from './CostEntryFormModal';

// ─── Types ───

export interface CostRow {
    id: string;
    category: string;
    /** Decimal serialises as a NUMBER through the usecase DTO's `dec()`. */
    amount: number;
    currency: string;
    incurredOn: string;
    supplier: string | null;
    invoiceFileId: string | null;
    plantingId: string | null;
    seasonId: string | null;
    locationId: string | null;
    parcelId: string | null;
    leaseId: string | null;
    itemId: string | null;
    /** WHICH land the cost spreads across — see `CostAllocationBasis`. */
    allocationBasis?: string;
    /** The chosen parcels, present only on a PARCEL_SUBSET entry. */
    allocationParcelIds?: string[];
    planting?: { id: string; successionNumber: number; cropPlan?: { name: string | null } | null } | null;
    season?: { id: string; name: string } | null;
    location?: { id: string; name: string } | null;
    parcel?: { id: string; name: string } | null;
    item?: { id: string; name: string; category: string } | null;
    invoiceFile?: { id: string; originalName: string } | null;
}

interface CostListResponse {
    rows: CostRow[];
    totalCount: number;
    truncated: boolean;
}

export interface CostsClientProps {
    initialRows: CostRow[];
    initialTotalCount: number;
    initialTruncated: boolean;
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

export function CostsClient(props: CostsClientProps) {
    const filterCtx = useFilterContext([], COST_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <CostsPageInner {...props} />
        </FilterProvider>
    );
}

function CostsPageInner({
    initialRows,
    initialTotalCount,
    initialTruncated,
    tenantSlug,
    permissions,
}: CostsClientProps) {
    const t = useTranslations('grain.costs');
    const tEnums = useTranslations('grainEnums');
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);
    const queryClient = useQueryClient();
    const triggerUndoToast = useToastWithUndo();

    const { state, search, hasActive, clearAll } = useFilters();

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<CostRow | null>(null);

    // Search is a SERVER param: an in-memory filter would only ever see
    // the capped page, so a match beyond it would be invisible — a silent
    // wrong answer. Debounced so typing does not fire a request a
    // keystroke.
    const debouncedSearch = useDebounce(search, 300);
    const filtersForQuery = useMemo(() => {
        const params = filterStateToUrlParams(state);
        const q = debouncedSearch.trim();
        if (q) params.set('q', q);
        return params;
    }, [state, debouncedSearch]);

    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of filtersForQuery) obj[k] = v;
        return obj;
    }, [filtersForQuery]);

    // Only hydrate from SSR when no facet is active — the SSR slice is the
    // unfiltered newest-first list.
    const noFacets = Object.keys(queryKeyFilters).length === 0;

    const costsQuery = useQuery<CostListResponse>({
        queryKey: ['grain-costs', tenantSlug, 'list', queryKeyFilters],
        queryFn: async () => {
            const qs = filtersForQuery.toString();
            const res = await fetch(apiUrl(`/grain/costs${qs ? `?${qs}` : ''}`));
            if (!res.ok) throw new Error('Failed to fetch cost entries');
            return res.json();
        },
        initialData: noFacets
            ? {
                  rows: initialRows,
                  totalCount: initialTotalCount ?? initialRows.length,
                  truncated: initialTruncated ?? false,
              }
            : undefined,
        // eslint-disable-next-line react-hooks/purity
        initialDataUpdatedAt: noFacets ? Date.now() : 0,
        staleTime: 30_000,
    });

    const rows = useMemo(() => costsQuery.data?.rows ?? [], [costsQuery.data]);
    const truncated = costsQuery.data?.truncated ?? false;
    const totalCount = costsQuery.data?.totalCount ?? rows.length;
    const loading = costsQuery.isLoading && !costsQuery.data;

    // A failed list read must NOT fall through to the empty state — an
    // unreachable API rendered as "no costs" is a confident claim of zero.
    // Gated on having nothing to show, so a failed BACKGROUND refetch
    // keeps stale rows rather than blanking them (DataTable renders
    // `error` INSTEAD of the table).
    const loadError = costsQuery.isError && rows.length === 0 ? t('loadFailed') : undefined;

    const liveFilterDefs: FilterType[] = useMemo(() => buildCostFilters(tEnums), [tEnums]);

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['grain-costs', tenantSlug] });
    }, [queryClient, tenantSlug]);

    // Epic 67 — every destructive action goes through the undo toast. A
    // fire-and-forget DELETE is the anti-pattern that convention replaced,
    // and it is a worse fit here than almost anywhere: a cost entry is a
    // hand-typed money record, so a mis-click deletes something the farmer
    // would have to re-key from a paper invoice.
    const handleDelete = useCallback(
        (row: CostRow) => {
            const listKey = ['grain-costs', tenantSlug, 'list', queryKeyFilters];
            const previous = queryClient.getQueryData<CostListResponse>(listKey);
            // Optimistic remove; the totalCount is left alone for the
            // 5-second window because the refetch on commit replaces it
            // with the server's exact figure anyway.
            queryClient.setQueryData<CostListResponse>(listKey, (old) =>
                old ? { ...old, rows: old.rows.filter((c) => c.id !== row.id) } : old,
            );
            triggerUndoToast({
                message: t('deletedToast'),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(apiUrl(`/grain/costs/${row.id}`), {
                        method: 'DELETE',
                    });
                    if (!res.ok) throw new Error('Delete cost entry failed');
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

    /** Which domain this entry is filed against, for the list. */
    const attributionOf = useCallback(
        (r: CostRow): string => {
            if (r.planting)
                return t('attrPlanting', { n: r.planting.successionNumber });
            if (r.season) return r.season.name;
            if (r.location) return r.location.name;
            if (r.parcel) return r.parcel.name;
            if (r.item) return r.item.name;
            if (r.leaseId) return t('attrLease');
            return '—';
        },
        [t],
    );

    const columns = useMemo(
        () =>
            createColumns<CostRow>([
                {
                    id: 'incurredOn',
                    header: t('colDate'),
                    accessorFn: (r) => r.incurredOn,
                    cell: ({ row }) => (
                        <span className="whitespace-nowrap text-xs tabular-nums text-content-muted">
                            {formatDate(row.original.incurredOn)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colDate') } },
                },
                {
                    id: 'category',
                    header: t('colCategory'),
                    accessorFn: (r) => r.category,
                    cell: ({ row }) => (
                        <Badge variant="outline" size="sm">
                            {tEnums(`costCategory.${row.original.category}`)}
                        </Badge>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'supplier',
                    header: t('colSupplier'),
                    accessorFn: (r) => r.supplier ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-emphasis">{row.original.supplier || '—'}</span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'amount',
                    header: t('colAmount'),
                    accessorFn: (r) => r.amount,
                    cell: ({ row }) => (
                        // Currency is printed as the RECORDED code, never a
                        // tenant symbol: entries in different currencies sit
                        // in one list and there is no FX table in this repo,
                        // so a single symbol over all of them would be a
                        // claim the data does not support.
                        <span className="block text-right text-xs tabular-nums text-content-emphasis">
                            {formatDecimal(row.original.amount, 2)} {row.original.currency}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colAmount') } },
                },
                {
                    id: 'attribution',
                    header: t('colAttribution'),
                    accessorFn: (r) => attributionOf(r),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {attributionOf(row.original)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colAttribution') } },
                },
                {
                    id: 'invoice',
                    header: t('colInvoice'),
                    accessorFn: (r) => (r.invoiceFileId ? 1 : 0),
                    cell: ({ row }) =>
                        row.original.invoiceFileId ? (
                            <Tooltip content={row.original.invoiceFile?.originalName ?? t('hasInvoice')}>
                                <span
                                    className="inline-flex items-center text-content-muted"
                                    aria-label={t('hasInvoice')}
                                >
                                    <Paperclip className="h-3.5 w-3.5" aria-hidden />
                                </span>
                            </Tooltip>
                        ) : (
                            <span className="text-xs text-content-subtle">—</span>
                        ),
                },
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) =>
                        permissions.canWrite ? (
                            <div className="flex items-center justify-end gap-tight">
                                <Tooltip content={t('editCost')}>
                                    <button
                                        type="button"
                                        aria-label={t('editCost')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`cost-edit-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setEditing(row.original);
                                            setIsCreateOpen(true);
                                        }}
                                    >
                                        <Pen2 className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('deleteCost')}>
                                    <button
                                        type="button"
                                        aria-label={t('deleteCost')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-error hover:text-content-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`cost-delete-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void handleDelete(row.original);
                                        }}
                                    >
                                        <Trash className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                            </div>
                        ) : null,
                },
            ]),
        [t, tEnums, permissions.canWrite, handleDelete, attributionOf],
    );

    return (
        <EntityListPage<CostRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: tEnums('dashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('title') },
                ],
                title: t('title'),
                description: t('description'),
                actions: permissions.canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        id="new-cost-btn"
                        onClick={() => {
                            setEditing(null);
                            setIsCreateOpen(true);
                        }}
                    >
                        {t('addCost')}
                    </Button>
                ) : null,
            }}
            kpis={
                truncated ? (
                    <div
                        role="status"
                        id="grain-costs-truncation-notice"
                        className="rounded-lg border border-border-subtle bg-bg-warning px-3 py-2 text-xs text-content-warning"
                    >
                        {t('truncatedNotice', { shown: rows.length, total: totalCount })}
                    </div>
                ) : null
            }
            filters={{
                defs: liveFilterDefs,
                searchId: 'grain-costs-search',
                searchPlaceholder: t('searchPlaceholder'),
                toolbarActions: <GrainSectionNav tenantSlug={tenantSlug} active="costs" />,
            }}
            table={{
                data: rows,
                columns,
                loading,
                error: loadError,
                getRowId: (r) => r.id,
                mobileFallback: 'card',
                onRowClick: permissions.canWrite
                    ? (r: Row<CostRow>) => {
                          setEditing(r.original);
                          setIsCreateOpen(true);
                      }
                    : undefined,
                emptyState:
                    hasActive || search ? (
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
                                          label: t('addCost'),
                                          onClick: () => {
                                              setEditing(null);
                                              setIsCreateOpen(true);
                                          },
                                      }
                                    : undefined
                            }
                        />
                    ),
                resourceName: (p) => (p ? t('costs') : t('cost')),
                'data-testid': 'grain-costs-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <CostEntryFormModal
                    open={isCreateOpen}
                    setOpen={setIsCreateOpen}
                    tenantSlug={tenantSlug}
                    record={editing}
                    onSaved={refetch}
                />
            )}
        </EntityListPage>
    );
}
