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
import { Tooltip } from '@/components/ui/tooltip';
import { Pen2, Trash } from '@/components/ui/icons/nucleo';
import { useToastWithUndo } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import { buildYieldFilters, YIELD_FILTER_KEYS } from './filter-defs';
import { YieldFormModal } from './YieldFormModal';

// ─── Types ───
// YieldRecordDto — plain numbers + a computed tPerHa.
export interface YieldRow {
    id: string;
    plantingId: string | null;
    locationId: string | null;
    seasonId: string | null;
    commodity: string | null;
    harvestedAt: string | null;
    grossTonnes: number | null;
    moisturePct: number | null;
    areaHa: number | null;
    /** grossTonnes at the 14% standard moisture basis. Null when moisture
     *  was never measured — that record has no comparable weight. */
    netTonnesStd: number | null;
    tPerHa: number | null;
    /** Which tonnage `tPerHa` came from, so two figures in one column are
     *  never silently on different bases. */
    tPerHaBasis: 'standard-moisture' | 'gross';
    /** NOT sent with list rows — commercial commentary, fetched on demand
     *  by the edit form. Present only on a detail read. */
    valuationNotes?: string | null;
    planting?: { id: string; successionNumber: number } | null;
    location?: { id: string; name: string } | null;
    season?: { id: string; name: string } | null;
}

interface YieldClientProps {
    /** SSR first page + whether the 500-row cap bit. */
    initialPayload: { rows: YieldRow[]; totalCount: number; truncated: boolean };
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

function fmtNum(v: number | null): string {
    if (v == null) return '—';
    return formatDecimal(v, 2);
}

export function YieldClient(props: YieldClientProps) {
    const filterCtx = useFilterContext([], YIELD_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <YieldPageInner {...props} />
        </FilterProvider>
    );
}

function YieldPageInner({
    initialPayload,
    tenantSlug,
    permissions,
}: YieldClientProps) {
    const t = useTranslations('grain.yield');
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
    const [editing, setEditing] = useState<YieldRow | null>(null);

    // seasonId / locationId are server-side facets; q is in-memory.
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

    interface YieldListPayload {
        rows: YieldRow[];
        totalCount: number;
        truncated: boolean;
    }

    const recordsQuery = useQuery<YieldListPayload>({
        queryKey: ['grain-yield', tenantSlug, 'list', queryKeyFilters, search.trim()],
        queryFn: async () => {
            // `q` rides with the facets: searching only the loaded page
            // meant a match on row 501 was invisible and reported as "no
            // results" for a record that exists.
            const params = new URLSearchParams(filtersForQuery);
            if (search.trim()) params.set('q', search.trim());
            const qs = params.toString();
            const res = await fetch(
                apiUrl(`/grain/yield-records${qs ? `?${qs}` : ''}`),
            );
            if (!res.ok) throw new Error('Failed to fetch yield records');
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

    // A failed list read must surface as an error, not as the empty
    // state (which claims zero rows). Gated on having nothing to show so
    // a failed background refetch never blanks cached/SSR rows — the
    // DataTable renders `error` INSTEAD of the table.
    const loadError =
        recordsQuery.isError && rawRecords.length === 0
            ? t('loadFailed')
            : undefined;

    // Search is applied by the server (see the `q` param above), so the
    // rows arriving here are already the answer — no second, narrower
    // filter over the loaded page.
    const records = rawRecords;

    // Season / location facet options derived from the loaded rows.
    const liveFilterDefs: FilterType[] = useMemo(
        () => buildYieldFilters(tEnums, rawRecords),
        [tEnums, rawRecords],
    );

    const refetch = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['grain-yield', tenantSlug] });
    }, [queryClient, tenantSlug]);

    const handleDelete = useCallback(
        (rec: YieldRow) => {
            const listKey = ['grain-yield', tenantSlug, 'list', queryKeyFilters];
            const previous = queryClient.getQueryData<YieldRow[]>(listKey);
            queryClient.setQueryData<YieldRow[]>(listKey, (old) =>
                (old ?? []).filter((r) => r.id !== rec.id),
            );
            triggerUndoToast({
                // Name the record: with several deletes in flight, "Yield
                // record deleted" gives the reader no way to tell which
                // one Undo would bring back.
                message: t('deletedToast', {
                    name: rec.commodity ?? t('deletedToastFallback'),
                }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(
                        apiUrl(`/grain/yield-records/${rec.id}`),
                        { method: 'DELETE' },
                    );
                    if (!res.ok) throw new Error('Delete yield record failed');
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
        (row: Row<YieldRow>) => {
            if (!permissions.canWrite) return;
            setEditing(row.original);
            setIsCreateOpen(true);
        },
        [permissions.canWrite],
    );
    const getRowId = useCallback((r: YieldRow) => r.id, []);

    const columns = useMemo(
        () =>
            createColumns<YieldRow>([
                {
                    id: 'commodity',
                    header: t('colCommodity'),
                    accessorFn: (r) => r.commodity ?? '—',
                    cell: ({ row }) => (
                        <TableTitleCell id={`yield-link-${row.original.id}`}>
                            {row.original.commodity ?? t('untitledHarvest')}
                        </TableTitleCell>
                    ),
                },
                {
                    id: 'harvestedAt',
                    header: t('colHarvested'),
                    accessorFn: (r) => r.harvestedAt ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {formatDate(row.original.harvestedAt)}
                        </span>
                    ),
                },
                {
                    id: 'grossTonnes',
                    header: t('colGross'),
                    accessorFn: (r) => r.grossTonnes ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums block text-right">
                            {fmtNum(row.original.grossTonnes)}
                        </span>
                    ),
                },
                {
                    // Gross tonnages measured at different moistures are not
                    // comparable; this column is the same grain expressed at
                    // the 14% trade basis, and it is what t/ha divides.
                    // Em dash where moisture was never measured — that
                    // record's comparable weight is genuinely unknown.
                    id: 'netTonnesStd',
                    header: t('colNetStd'),
                    accessorFn: (r) => r.netTonnesStd ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums block text-right">
                            {fmtNum(row.original.netTonnesStd)}
                        </span>
                    ),
                },
                {
                    id: 'moisturePct',
                    header: t('colMoisture'),
                    accessorFn: (r) => r.moisturePct ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {fmtNum(row.original.moisturePct)}
                        </span>
                    ),
                },
                {
                    id: 'areaHa',
                    header: t('colArea'),
                    accessorFn: (r) => r.areaHa ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {fmtNum(row.original.areaHa)}
                        </span>
                    ),
                },
                {
                    id: 'tPerHa',
                    header: t('colTPerHa'),
                    accessorFn: (r) => r.tPerHa ?? -1,
                    // A t/ha computed from gross sits in the same column as
                    // one computed at the standard basis; say which, rather
                    // than let them look alike. Via the Tooltip primitive —
                    // Epic 56 bans raw `title=`, and a native tooltip would
                    // not be keyboard-reachable anyway.
                    cell: ({ row }) => (
                        <Tooltip
                            content={
                                row.original.tPerHaBasis === 'gross'
                                    ? t('tPerHaBasisGross')
                                    : t('tPerHaBasisStandard')
                            }
                        >
                            <span className="text-xs text-content-emphasis tabular-nums block text-right">
                                {fmtNum(row.original.tPerHa)}
                                {row.original.tPerHaBasis === 'gross' && row.original.tPerHa != null ? '*' : ''}
                            </span>
                        </Tooltip>
                    ),
                },
                {
                    id: 'location',
                    header: t('colField'),
                    accessorFn: (r) => r.location?.name ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue() as string}
                        </span>
                    ),
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
                },
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) =>
                        permissions.canWrite ? (
                            <div className="flex items-center justify-end gap-tight">
                                <Tooltip content={t('editYield')}>
                                    <button
                                        type="button"
                                        aria-label={t('editYield')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`yield-edit-${row.original.id}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setEditing(row.original);
                                            setIsCreateOpen(true);
                                        }}
                                    >
                                        <Pen2 className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                                <Tooltip content={t('deleteYield')}>
                                    <button
                                        type="button"
                                        aria-label={t('deleteYield')}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-error hover:text-content-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        data-testid={`yield-delete-${row.original.id}`}
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
        <EntityListPage<YieldRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('breadcrumbYield') },
                ],
                title: t('title'),
                // The 500-row cap used to be silent: a farm with 600 harvest
                // records saw 500 and was told nothing, so any total read off
                // this page was simply wrong. Say so when it bites.
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
                        id="new-yield-btn"
                        onClick={() => {
                            setEditing(null);
                            setIsCreateOpen(true);
                        }}
                    >
                        {t('newYield')}
                    </Button>
                ) : null,
            }}
            filters={{
                defs: liveFilterDefs,
                searchId: 'grain-yield-search',
                searchPlaceholder: t('searchPlaceholder'),
                toolbarActions: (
                    <GrainSectionNav tenantSlug={tenantSlug} active="yield" />
                ),
            }}
            table={{
                data: records,
                columns,
                loading,
                error: loadError,
                getRowId,
                // mobileFallback: 'scroll' — the yield matrix is a wide,
                // dense numeric grid (crop / field / area / weight / moisture
                // / yield-per-area across many columns). The numbers ARE the
                // point and only make sense side-by-side, so on a phone we
                // keep the horizontally-scrollable table rather than collapse
                // it into a card (which would bury the comparison).
                mobileFallback: 'scroll',
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
                                      label: t('addYield'),
                                      onClick: () => {
                                          setEditing(null);
                                          setIsCreateOpen(true);
                                      },
                                  }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('yieldRecords') : t('yieldRecord')),
                'data-testid': 'grain-yield-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <YieldFormModal
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
