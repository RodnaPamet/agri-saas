'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { Fab } from '@/components/ui/fab';
import { PullToRefresh } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import { buildPlanningFilters, CROP_PLAN_FILTER_KEYS } from './filter-defs';
import { NewCropPlanModal } from './NewCropPlanModal';

/** List-row shape returned by GET /planning/crop-plans. */
interface CropPlanRow {
    id: string;
    name: string;
    status: string;
    successions: number;
    intervalDays: number;
    season?: { id: string; name: string } | null;
    cropType?: { id: string; name: string } | null;
    variety?: { id: string; name: string } | null;
    _count?: { plantings?: number };
}

interface CatalogOption {
    id: string;
    name: string;
    cropType?: { id: string; name: string } | null;
    defaultMethod?: string | null;
}

interface LocationOption {
    id: string;
    name: string;
}

interface CropPlansClientProps {
    initialPlans: CropPlanRow[];
    seasons: CatalogOption[];
    cropTypes: CatalogOption[];
    varieties: CatalogOption[];
    locations: LocationOption[];
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

export function CropPlansClient(props: CropPlansClientProps) {
    const filterCtx = useFilterContext([], CROP_PLAN_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <CropPlansPageInner {...props} />
        </FilterProvider>
    );
}

function CropPlansPageInner({
    initialPlans,
    seasons,
    cropTypes,
    varieties,
    locations,
    tenantSlug,
    permissions,
}: CropPlansClientProps) {
    const t = useTranslations('planning.list');
    const tp = useTranslations('planning');
    const te = useTranslations('planningEnums');
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const router = useRouter();
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;
    const fetchParams = useMemo(() => toApiSearchParams(state, { search }), [state, search]);

    const noFilters = !hasActive && !search;
    const plansKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs ? `/planning/crop-plans?${qs}` : '/planning/crop-plans';
    }, [fetchParams]);

    const plansQuery = useTenantSWR<CropPlanRow[]>(plansKey, {
        fallbackData: noFilters ? initialPlans : undefined,
    });
    const plans = plansQuery.data ?? [];
    const loading = plansQuery.isLoading && !plansQuery.data;

    const liveFilters = useMemo(() => buildPlanningFilters(te, seasons, cropTypes), [te, seasons, cropTypes]);

    const columns = useMemo(
        () =>
            createColumns<CropPlanRow>([
                {
                    accessorKey: 'name',
                    header: t('colPlan'),
                    cell: ({ row, getValue }) => (
                        <TableTitleCell
                            href={tenantHref(`/planning/${row.original.id}`)}
                            id={`crop-plan-link-${row.original.id}`}
                        >
                            {getValue() as string}
                        </TableTitleCell>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'season',
                    header: t('colSeason'),
                    accessorFn: (p) => p.season?.name ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colSeason') } },
                },
                {
                    id: 'crop',
                    header: t('colCrop'),
                    accessorFn: (p) => p.variety?.name ?? p.cropType?.name ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-default">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'successions',
                    header: t('colSuccessions'),
                    accessorFn: (p) => p.successions,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums">
                            {row.original.successions}
                            {row.original.intervalDays > 0 ? ` · ${row.original.intervalDays}d` : ''}
                        </span>
                    ),
                },
                {
                    id: 'plantings',
                    header: t('colPlantings'),
                    accessorFn: (p) => p._count?.plantings ?? 0,
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted tabular-nums">{getValue() as number}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colPlantings') } },
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <AgStatusBadge entity="cropPlan" status={row.original.status} />
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- read 2026-10-17 for #1730: the body closes over no state value absent from these deps. Verified against the sibling column memos, one of which (`EvidenceClient`) did omit one and froze two columns pre-hydration (#2033)
        [tenantSlug, t],
    );

    return (
        <EntityListPage<CropPlanRow>
            className="gap-section"
            header={{
                breadcrumbs: [
                    { label: tp('bcDashboard'), href: tenantHref('/dashboard') },
                    { label: tp('bcPlanting') },
                ],
                title: t('title'),
                description: t('description'),
                actions: (
                    <div className="flex items-center gap-tight">
                        <Button
                            variant="secondary"
                            onClick={() => router.push(tenantHref('/planning/seasons'))}
                            id="planning-seasons-btn"
                        >
                            {t('seasons')}
                        </Button>
                        {permissions.canWrite ? (
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                onClick={() => setIsCreateOpen(true)}
                                id="new-crop-plan-btn"
                            >
                                {t('newPlan')}
                            </Button>
                        ) : null}
                    </div>
                ),
            }}
            filters={{
                defs: liveFilters,
                searchId: 'crop-plans-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: plans,
                columns,
                loading,
                getRowId: (p) => p.id,
                mobileFallback: 'card',
                onRowClick: (row) => router.push(tenantHref(`/planning/${row.original.id}`)),
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('emptyFilteredTitle')}
                        description={t('emptyFilteredDesc')}
                        secondaryAction={{ label: t('clearFilters'), onClick: () => filterCtx.clearAll() }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDesc')}
                        primaryAction={
                            permissions.canWrite
                                ? { label: t('addPlan'), onClick: () => setIsCreateOpen(true) }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('resourcePlural') : t('resourceSingular')),
                'data-testid': 'crop-plans-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canWrite && (
                <>
                    <NewCropPlanModal
                        open={isCreateOpen}
                        setOpen={setIsCreateOpen}
                        tenantSlug={tenantSlug}
                        seasons={seasons}
                        cropTypes={cropTypes}
                        varieties={varieties}
                        locations={locations}
                        onSaved={(plan) => {
                            void plansQuery.mutate();
                            router.push(tenantHref(`/planning/${plan.id}`));
                        }}
                    />
                    {/* Mobile-only FAB — the primary create action in the
                        thumb zone (md:hidden; the header button is the
                        desktop affordance). */}
                    <PullToRefresh onRefresh={() => plansQuery.mutate()} />
                    <ScrollToTop />
                    <Fab
                        onClick={() => setIsCreateOpen(true)}
                        label={t('fabLabel')}
                        icon={<Plus aria-hidden className="h-6 w-6" />}
                    />
                </>
            )}
        </EntityListPage>
    );
}
