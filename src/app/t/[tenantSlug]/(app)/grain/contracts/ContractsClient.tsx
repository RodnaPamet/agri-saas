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
import { GrainSectionNav } from '../GrainSectionNav';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { Pen2, Trash, StackY3 } from '@/components/ui/icons/nucleo';
import { useDebounce, useToastWithUndo } from '@/components/ui/hooks';
import { formatDateRange } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import {
    buildContractFilters,
    CONTRACT_FILTER_KEYS,
} from './filter-defs';
import { ContractFormModal } from './ContractFormModal';
import {
    ContractProgressCell,
    ContractWindowBadge,
} from './ContractFulfilmentCell';
import { ContractBookTotals } from './ContractBookTotals';
import { DeliveriesSheet } from './DeliveriesSheet';

// ─── Types ───
//
// RAW Prisma Contract model: Decimal columns serialize as STRINGS over
// JSON. Parse with Number(...) for display; keep them as strings on the
// row so the edit form can round-trip them losslessly.
export interface ContractFulfilmentDto {
    contractId: string;
    deliveredTonnes: string;
    deliveryCount: number;
    remainingTonnes: string | null;
    progressPct: number | null;
    complete: boolean;
}

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
    createdAt: string;
    updatedAt: string;
    season?: { id: string; name: string; status: string } | null;
    /** Derived server-side from the GrainDelivery ledger. */
    fulfilment?: ContractFulfilmentDto;
    /** Derived server-side: volume × price, exact decimal string. */
    valueAmount?: string | null;
}

/**
 * The full row, including the two Epic-B ENCRYPTED narrative columns.
 *
 * The LIST deliberately omits `terms` / `pricingNotes` — they used to
 * ride along decrypted for up to 500 rows into every viewer's cache,
 * including READERs and AUDITORs who have no surface that renders them.
 * The edit modal fetches this shape for ONE contract when it opens.
 */
export interface ContractDetail extends ContractRow {
    terms: string | null;
    pricingNotes: string | null;
}

/** One currency's slice of the book (never summed across currencies). */
export interface ContractBookTotalDto {
    currency: string | null;
    contractCount: number;
    contractedTonnes: string;
    contractValue: string;
    unpricedCount: number;
}

/** The list endpoint's payload — rows, per-currency book totals, and the
 *  truth about the 500-row cap. */
export interface ContractListResponse {
    rows: ContractRow[];
    totals: ContractBookTotalDto[];
    /** Matching contracts in the tenant (not just on this page). */
    totalCount: number;
    /** True when the page hit the server cap and rows are missing. */
    truncated: boolean;
}

interface ContractsClientProps {
    initialContracts: ContractRow[];
    initialTotals: ContractBookTotalDto[];
    initialTotalCount?: number;
    initialTruncated?: boolean;
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

/** Format a string|null decimal for display; right-aligned tabular-nums.
 *
 *  Pinned to the repo's fixed formatting locale (`formatDecimal`) rather
 *  than `toLocaleString(undefined)`: the runtime default differs between
 *  the Node render and the browser, so an unpinned separator is a
 *  hydration mismatch waiting for the first non-en-US visitor. */
function fmtNum(v: string | null): string {
    if (v == null || v === '') return '—';
    return formatDecimal(v, 2);
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
    initialTotals,
    initialTotalCount,
    initialTruncated,
    tenantSlug,
    permissions,
}: ContractsClientProps) {
    const t = useTranslations('grain.contracts');
    const tEnums = useTranslations('grainEnums');
    // Enum MEMBER labels — the same `ag.status.contract.*` keys the
    // table badge resolves, so the chip and the badge cannot disagree.
    const tAg = useTranslations('ag');
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
    // Delivery-ledger sheet — which contract's fulfilment is open.
    const [deliveriesFor, setDeliveriesFor] = useState<ContractRow | null>(null);

    // ─── API query string from filter state (status + type only) ───
    // Search is a SERVER param now. The in-memory filter only ever saw
    // the 500-row page, so a match on row 501 was invisible — a silent
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

    // Only hydrate from SSR when no facet is active (the SSR slice is the
    // unfiltered newest-first list).
    const noFacets = Object.keys(queryKeyFilters).length === 0;

    const contractsQuery = useQuery<ContractListResponse>({
        queryKey: ['grain-contracts', tenantSlug, 'list', queryKeyFilters],
        queryFn: async () => {
            const qs = filtersForQuery.toString();
            const res = await fetch(apiUrl(`/grain/contracts${qs ? `?${qs}` : ''}`));
            if (!res.ok) throw new Error('Failed to fetch contracts');
            return res.json();
        },
        initialData: noFacets
            ? {
                  rows: initialContracts,
                  totals: initialTotals,
                  totalCount: initialTotalCount ?? initialContracts.length,
                  truncated: initialTruncated ?? false,
              }
            : undefined,
        // eslint-disable-next-line react-hooks/purity
        initialDataUpdatedAt: noFacets ? Date.now() : 0,
        staleTime: 30_000,
    });

    // Stable ref so the search memo below doesn't recompute every render
    // (query.data?.rows ?? [] would mint a fresh array each pass).
    const rawContracts = useMemo(
        () => contractsQuery.data?.rows ?? [],
        [contractsQuery.data],
    );
    const bookTotals = useMemo(
        () => contractsQuery.data?.totals ?? [],
        [contractsQuery.data],
    );
    // The 500-row server cap used to be silent — a tenant with 600
    // contracts saw 500 and was told nothing, which is a wrong answer
    // delivered confidently. Say so.
    const truncated = contractsQuery.data?.truncated ?? false;
    const totalCount = contractsQuery.data?.totalCount ?? rawContracts.length;
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

    // No in-memory filter pass: `q` goes to the server (see above), so
    // `rawContracts` is already the answer. Filtering again here would
    // only re-hide rows the server deliberately returned.
    const contracts = rawContracts;

    const liveFilterDefs: FilterType[] = useMemo(
        () => buildContractFilters(tEnums, tAg),
        [tEnums, tAg],
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
                queryClient.getQueryData<ContractListResponse>(listKey);
            // Optimistic remove. Totals are left alone for the 5-second
            // undo window: recomputing the book client-side would need
            // decimal arithmetic on strings, and the refetch on commit
            // replaces them with the server's exact figures anyway.
            queryClient.setQueryData<ContractListResponse>(listKey, (old) =>
                old
                    ? { ...old, rows: old.rows.filter((c) => c.id !== contract.id) }
                    : old,
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
                    // "Counterparty" is trade jargon for two concrete
                    // roles the schema already distinguishes: a SALE has
                    // a BUYER, a PURCHASE has a SUPPLIER. The header
                    // names the common case and each row names its own.
                    header: t('colParty'),
                    cell: ({ row }) => (
                        <div className="flex flex-col">
                            <TableTitleCell id={`contract-link-${row.original.id}`}>
                                {row.original.counterparty}
                            </TableTitleCell>
                            <span className="text-[0.625rem] uppercase tracking-wide text-content-subtle">
                                {row.original.type === 'SALE'
                                    ? t('roleBuyer')
                                    : t('roleSupplier')}
                            </span>
                        </div>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'key',
                    // The contract NUMBER — the reference printed on the
                    // paper the farmer is holding. It has always had a
                    // real unique index and no way to enter, see or
                    // search it.
                    header: t('colKey'),
                    accessorFn: (c) => c.key ?? '',
                    cell: ({ row }) =>
                        row.original.key ? (
                            <span className="font-mono text-xs text-content-muted">
                                {row.original.key}
                            </span>
                        ) : (
                            <span className="text-xs text-content-subtle">—</span>
                        ),
                    meta: { mobileCard: { slot: 'meta', label: t('colKey') } },
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
                        <div className="flex flex-wrap items-center gap-tight">
                            <AgStatusBadge entity="contract" status={row.original.status} />
                            {/* "Settled" is trade jargon — it means paid,
                                not merely delivered. One tooltip beats a
                                farmer guessing. */}
                            {row.original.status === 'SETTLED' && (
                                <InfoTooltip content={t('jargonSettled')} />
                            )}
                            <ContractWindowBadge
                                status={row.original.status}
                                deliveryEnd={row.original.deliveryEnd}
                            />
                        </div>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'fulfilment',
                    header: t('colDelivered'),
                    // Sort by progress, with "no denominator" rows last.
                    accessorFn: (c) => c.fulfilment?.progressPct ?? -1,
                    cell: ({ row }) => (
                        <ContractProgressCell
                            fulfilment={row.original.fulfilment}
                            volumeTonnes={row.original.volumeTonnes}
                        />
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colDelivered') } },
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
                    id: 'valueAmount',
                    header: t('colValue'),
                    // Sort numerically; unpriced rows sort last.
                    accessorFn: (c) =>
                        c.valueAmount != null ? Number(c.valueAmount) : -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums tracking-tight block text-right">
                            {row.original.valueAmount == null
                                ? '—'
                                : `${fmtNum(row.original.valueAmount)}${
                                      row.original.priceCurrency
                                          ? ` ${row.original.priceCurrency}`
                                          : ''
                                  }`}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colValue') } },
                },
                {
                    id: 'deliveryStart',
                    header: t('colDelivery'),
                    accessorFn: (c) => c.deliveryStart ?? '',
                    cell: ({ row }) => (
                        // The WINDOW, not just its opening date. A
                        // delivery window is a period the farmer plans
                        // haulage around; showing only the start hid the
                        // deadline that actually matters.
                        <span className="whitespace-nowrap text-xs text-content-muted">
                            {formatDateRange(
                                row.original.deliveryStart,
                                row.original.deliveryEnd,
                            )}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colDelivery') } },
                },
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) =>
                        permissions.canWrite ? (
                            <div className="flex items-center justify-end gap-tight">
                                <Tooltip content={t('recordDelivery')}>
                                    <button
                                        type="button"
                                        aria-label={t('recordDelivery')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`contract-deliveries-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setDeliveriesFor(row.original);
                                        }}
                                    >
                                        <StackY3 className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
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
            kpis={
                <>
                    <ContractBookTotals totals={bookTotals} />
                    {truncated && (
                        <div
                            role="status"
                            id="grain-contracts-truncation-notice"
                            className="rounded-lg border border-border-subtle bg-bg-warning px-3 py-2 text-xs text-content-warning"
                        >
                            {t('truncatedNotice', {
                                shown: rawContracts.length,
                                total: totalCount,
                            })}
                        </div>
                    )}
                </>
            }
            filters={{
                defs: liveFilterDefs,
                searchId: 'grain-contracts-search',
                searchPlaceholder: t('searchPlaceholder'),
                toolbarActions: (
                    <GrainSectionNav tenantSlug={tenantSlug} active="contracts" />
                ),
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
            {/* Delivery ledger. Mounted for readers too — seeing what has
                been delivered is a read, and the sheet gates its own
                write affordances on `canWrite`. */}
            <DeliveriesSheet
                open={deliveriesFor != null}
                onOpenChange={(next) => {
                    if (!next) setDeliveriesFor(null);
                }}
                contract={deliveriesFor}
                tenantSlug={tenantSlug}
                canWrite={permissions.canWrite}
                onChanged={refetch}
            />
        </EntityListPage>
    );
}
