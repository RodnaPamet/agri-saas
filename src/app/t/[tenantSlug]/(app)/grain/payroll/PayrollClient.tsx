'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Row } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Plus, Pen2, Trash } from '@/components/ui/icons/nucleo';
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
import { Tooltip } from '@/components/ui/tooltip';
import { useToastWithUndo } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import { buildPayrollFilters, PAYROLL_FILTER_KEYS } from './filter-defs';
import { PayrollFormModal } from './PayrollFormModal';

// ─── Types ───
// PayrollExpenseDto — plain amount + ISO date strings.
export interface PayrollRow {
    id: string;
    amount: number;
    currency: string;
    incurredOn: string;
    plantingId: string | null;
    seasonId: string | null;
    createdByUserId: string | null;
    /** NOT sent with list rows — commercial/personal free text, fetched on
     *  demand by the edit form. Present only on a detail read. */
    description?: string | null;
    planting?: { id: string; successionNumber: number; cropPlan?: { name: string | null } | null } | null;
    season?: { id: string; name: string } | null;
}

interface PayrollClientProps {
    /** SSR first page + whether the 500-row cap bit. */
    initialPayload: { rows: PayrollRow[]; totalCount: number; truncated: boolean };
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

/** "CropPlan #3" when the planting's crop plan is named, else "#3". No
 *  hardcoded English fallback — a planting with no attribution renders
 *  as an em dash, translated by the caller. */
function plantingLabel(p: PayrollRow['planting']): string | null {
    if (!p) return null;
    return p.cropPlan?.name ? `${p.cropPlan.name} #${p.successionNumber}` : `#${p.successionNumber}`;
}

export function PayrollClient(props: PayrollClientProps) {
    const filterCtx = useFilterContext([], PAYROLL_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <PayrollPageInner {...props} />
        </FilterProvider>
    );
}

function PayrollPageInner({
    initialPayload,
    tenantSlug,
    permissions,
}: PayrollClientProps) {
    const t = useTranslations('payroll');
    const tEnums = useTranslations('grainEnums');
    const apiUrl = useCallback(
        (path: string) => `/api/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const queryClient = useQueryClient();
    const triggerUndoToast = useToastWithUndo();

    const filterCtx = useFilters();
    const { state, search, hasActive, clearAll } = filterCtx;

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<PayrollRow | null>(null);

    // seasonId is a server-side facet; q rides with it (server-side search).
    const filtersForQuery = useMemo(
        () => filterStateToUrlParams(state),
        [state],
    );
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of filtersForQuery) obj[k] = v;
        return obj;
    }, [filtersForQuery]);

    const noFacets = Object.keys(queryKeyFilters).length === 0 && search.trim() === '';

    interface PayrollListPayload {
        rows: PayrollRow[];
        totalCount: number;
        truncated: boolean;
    }

    const recordsQuery = useQuery<PayrollListPayload>({
        queryKey: ['grain-payroll', tenantSlug, 'list', queryKeyFilters, search.trim()],
        queryFn: async () => {
            // `q` rides with the facets: searching only the loaded page
            // meant a match on row 501 was invisible.
            const params = new URLSearchParams(filtersForQuery);
            if (search.trim()) params.set('q', search.trim());
            const qs = params.toString();
            const res = await fetch(
                apiUrl(`/grain/payroll${qs ? `?${qs}` : ''}`),
            );
            if (!res.ok) throw new Error('Failed to fetch payroll expenses');
            return res.json();
        },
        initialData: noFacets ? initialPayload : undefined,
        // eslint-disable-next-line react-hooks/purity
        initialDataUpdatedAt: noFacets ? Date.now() : 0,
        staleTime: 30_000,
    });

    // Stable ref so the search + facet memos below don't recompute every
    // render (query.data ?? [] would mint a fresh array each pass).
    const rawRecords = useMemo(
        () => recordsQuery.data?.rows ?? [],
        [recordsQuery.data],
    );
    const loading = recordsQuery.isLoading && !recordsQuery.data;

    // A failed list read must surface as an error, not as the empty state
    // (which claims zero rows). Gated on having nothing to show so a
    // failed background refetch never blanks cached/SSR rows.
    const loadError =
        recordsQuery.isError && rawRecords.length === 0
            ? t('loadFailed')
            : undefined;

    const records = rawRecords;

    // Season facet options derived from the loaded rows.
    const liveFilterDefs: FilterType[] = useMemo(
        () => buildPayrollFilters(tEnums, rawRecords),
        [tEnums, rawRecords],
    );

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['grain-payroll', tenantSlug] });
    }, [queryClient, tenantSlug]);

    const handleDelete = useCallback(
        (rec: PayrollRow) => {
            const listKey = ['grain-payroll', tenantSlug, 'list', queryKeyFilters];
            const previous = queryClient.getQueryData<PayrollRow[]>(listKey);
            queryClient.setQueryData<PayrollRow[]>(listKey, (old) =>
                (old ?? []).filter((r) => r.id !== rec.id),
            );
            triggerUndoToast({
                // Name the row: with several deletes in flight, a bare
                // "Payroll expense deleted" gives no way to tell which one
                // Undo would bring back.
                message: t('deletedToast', {
                    name: `${formatDecimal(rec.amount, 2)} ${rec.currency}`,
                }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(
                        apiUrl(`/grain/payroll/${rec.id}`),
                        { method: 'DELETE' },
                    );
                    if (!res.ok) throw new Error('Delete payroll expense failed');
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
        (row: Row<PayrollRow>) => {
            if (!permissions.canWrite) return;
            setEditing(row.original);
            setIsCreateOpen(true);
        },
        [permissions.canWrite],
    );
    const getRowId = useCallback((r: PayrollRow) => r.id, []);

    const columns = useMemo(
        () =>
            createColumns<PayrollRow>([
                {
                    id: 'amount',
                    header: t('colAmount'),
                    accessorFn: (r) => r.amount,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums font-medium">
                            {formatDecimal(row.original.amount, 2)} {row.original.currency}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'incurredOn',
                    header: t('colDate'),
                    accessorFn: (r) => r.incurredOn ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {formatDate(row.original.incurredOn)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colDate') } },
                },
                {
                    id: 'planting',
                    header: t('colPlanting'),
                    accessorFn: (r) => plantingLabel(r.planting) ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue() as string}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colPlanting') } },
                },
                {
                    id: 'season',
                    header: t('colSeason'),
                    accessorFn: (r) => r.season?.name ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue() as string}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colSeason') } },
                },
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) =>
                        permissions.canWrite ? (
                            <div className="flex items-center justify-end gap-tight">
                                <Tooltip content={t('editPayroll')}>
                                    <button
                                        type="button"
                                        aria-label={t('editPayroll')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`payroll-edit-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setEditing(row.original);
                                            setIsCreateOpen(true);
                                        }}
                                    >
                                        <Pen2 className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('deletePayroll')}>
                                    <button
                                        type="button"
                                        aria-label={t('deletePayroll')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-error hover:text-content-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`payroll-delete-${row.original.id}`}
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
                    meta: { mobileCard: { slot: 'actions' } },
                },
            ]),
        [permissions.canWrite, handleDelete, t],
    );

    return (
        <EntityListPage<PayrollRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('breadcrumbPayroll') },
                ],
                title: t('title'),
                // The 500-row cap used to be silent on the yield register — a
                // full page read as "the total" when it was really a
                // truncated one. Say so when it bites.
                description: recordsQuery.data?.truncated
                    ? t('truncatedNotice', {
                          shown: rawRecords.length,
                          total: recordsQuery.data.totalCount,
                      })
                    : t('description'),
                actions: permissions.canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        id="new-payroll-btn"
                        onClick={() => {
                            setEditing(null);
                            setIsCreateOpen(true);
                        }}
                    >
                        {t('newPayroll')}
                    </Button>
                ) : null,
            }}
            filters={{
                defs: liveFilterDefs,
                searchId: 'grain-payroll-search',
                searchPlaceholder: t('searchPlaceholder'),
                toolbarActions: (
                    <GrainSectionNav tenantSlug={tenantSlug} active="payroll" />
                ),
            }}
            table={{
                data: records,
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
                                      label: t('addPayroll'),
                                      onClick: () => {
                                          setEditing(null);
                                          setIsCreateOpen(true);
                                      },
                                  }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('payrollExpenses') : t('payrollExpense')),
                'data-testid': 'grain-payroll-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <PayrollFormModal
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
