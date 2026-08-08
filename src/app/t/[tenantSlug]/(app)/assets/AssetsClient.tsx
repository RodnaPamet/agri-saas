'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useMemo, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { DataTable, createColumns, useColumnsDropdown, useBulkDelete } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    useFilterCardVisibility,
    type CardDefinition,
} from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { Tooltip } from '@/components/ui/tooltip';
import { AppIcon } from '@/components/icons/AppIcon';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import { buildAssetFilters, ASSET_FILTER_KEYS } from './filter-defs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { firstAssetDataIndex } from '@/lib/assets/asset-sparkline';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import { Plus, Trash } from '@/components/ui/icons/nucleo';
import type { TrendPayload } from '@/app-layer/usecases/compliance-trends';
import type { TimeSeriesPoint } from '@/components/ui/charts';
import { NewAssetModal } from './NewAssetModal';
import { DeletedAssetsView } from './DeletedAssetsView';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { hasComplianceModules } from '@/lib/modules';
import type { StatusBadgeVariant } from '@/components/ui/status-badge';

// B7 — status badge tone; IN_MAINTENANCE gets its own amber tone.
const ASSET_STATUS_TONE: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    IN_MAINTENANCE: 'warning',
    RETIRED: 'neutral',
};

interface AssetsClientProps {
    initialAssets: any[];
    initialFilters: Record<string, string>;
    tenantSlug: string;
    permissions: { canWrite: boolean; canAdmin: boolean };
    translations: {
        title: string;
        listDescription: string;
        addAsset: string;
        createAsset: string;
        name: string;
        type: string;
        manufacturer: string;
        owner: string;
        location: string;
        controlsCol: string;
        noAssets: string;
        cancel: string;
        assetsRegistered: string;
    };
}

/**
 * Client island for assets — handles create form, filter interactions, and table navigation.
 * Data is pre-fetched server-side and passed via props.
 */
export function AssetsClient(props: AssetsClientProps) {
    const filterCtx = useFilterContext([], ASSET_FILTER_KEYS, {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <AssetsPageInner {...props} />
        </FilterProvider>
    );
}

function AssetsPageInner({ initialAssets, initialFilters, tenantSlug, permissions, translations: t }: AssetsClientProps) {
    // Inline strings not passed via the server `translations` prop use a
    // client-side `useTranslations('assets')` binding (`tm`).
    const tm = useTranslations('assets');
    // Assets-exoskeleton — the compliance chrome (Controls + Risks link
    // counts, the coverage shield) only renders for a tenant that runs a
    // compliance module. A plain farm gets a clean register.
    const { availableModules } = useTenantContext();
    const showCompliance = hasComplianceModules(availableModules);
    // B2 — in-page Trash toggle (ADMIN-only; no navbar entry).
    const [showDeleted, setShowDeleted] = useState(false);
    // Modal-form follow-up — create-asset modal mounted off the list,
    // auto-opening on `?create=1` (the redirect target from
    // `/assets/new`). Matches the canonical NewVendorModal wiring.
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const searchParams = useSearchParams();
    const router = useRouter();
    useEffect(() => {
        if (searchParams?.get('create') === '1') {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setIsCreateOpen(true);
            const next = new URLSearchParams(searchParams.toString());
            next.delete('create');
            const qs = next.toString();
            router.replace(
                `/t/${tenantSlug}/assets${qs ? `?${qs}` : ''}`,
                { scroll: false },
            );
        }
        // First-mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;
    const fetchParams = useMemo(
        () => toApiSearchParams(state, { search }),
        [state, search],
    );
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of fetchParams) obj[k] = v;
        return obj;
    }, [fetchParams]);

    const serverHadFilters = initialFilters && Object.keys(initialFilters).length > 0;
    const filtersMatchInitial = useMemo(() => {
        if (!serverHadFilters) return !hasActive;
        const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initialFilters)]);
        for (const k of keys) {
            if ((queryKeyFilters[k] ?? '') !== (initialFilters[k] ?? '')) return false;
        }
        return true;
    }, [queryKeyFilters, initialFilters, serverHadFilters, hasActive]);

    const assetsQuery = useQuery({
        queryKey: queryKeys.assets.list(tenantSlug, queryKeyFilters),
        queryFn: async () => {
            const qs = fetchParams.toString();
            const res = await fetch(apiUrl(`/assets${qs ? `?${qs}` : ''}`));
            if (!res.ok) throw new Error('Failed to fetch assets');
            return res.json();
        },
        initialData: filtersMatchInitial ? initialAssets : undefined,
    });
    const assets = assetsQuery.data ?? [];

    // Bulk-delete via the table selection action-row.
    const { batchAction: assetBulkDelete, dialog: assetDeleteDialog } =
        useBulkDelete({
            entitySingular: tm('assetSingular'),
            entityPlural: tm('assetPlural'),
            onDelete: async (assetIds) => {
                const res = await fetch(`/api/t/${tenantSlug}/assets/bulk/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assetIds }),
                });
                if (!res.ok) throw new Error('Failed to delete assets');
                await assetsQuery.refetch();
            },
        });

    const liveFilters = useMemo(() => buildAssetFilters(), []);
    // R-filter-gear (#3, 2026-06-07) — the gear controls the quantifiable
    // KPI cards (Total / Active / High criticality / Retired), not the
    // filter categories (which stay in the Filter dropdown).
    const kpiCards: CardDefinition[] = useMemo(
        () => [
            { id: 'total', label: tm('kpiTotal'), kind: 'kpi' },
            { id: 'active', label: tm('kpiActive'), kind: 'kpi' },
            { id: 'critical', label: tm('kpiCritical'), kind: 'kpi' },
            { id: 'retired', label: tm('kpiRetired'), kind: 'kpi' },
        ],
        [tm],
    );
    const { visibleCards: visibleKpiCards, dropdown: filtersDropdown } =
        useFilterCardVisibility({
            storageKey: 'inflect:filter-vis:assets',
            cards: kpiCards,
        });

    // R23-PR-D — KPI definitions for the Assets page. Mirrors the
    // Risks-page reference shape: typed id union, predicate per KPI
    // derives `isActive` from current filter state (so a card lights
    // up whether the user clicked the KPI or set the filter via the
    // dropdown). Granular `clear` callbacks scope toggle-off to each
    // KPI's own key (status / criticality), so sibling filters
    // survive.
    type AssetKpiId = 'total' | 'active' | 'critical' | 'retired';
    // guardrail-ignore: KPI counts across the loaded page, not a refilter.
    const totalAssets = assets.length;
    // guardrail-ignore: KPI count, not a refilter.
    const activeAssets = assets.filter((a: any) => a.status === 'ACTIVE').length;
    // guardrail-ignore: KPI count, not a refilter.
    const criticalAssets = assets.filter((a: any) => a.criticality === 'HIGH').length;
    // guardrail-ignore: KPI count, not a refilter.
    const retiredAssets = assets.filter((a: any) => a.status === 'RETIRED').length;

    // Sparkline data per KPI — cumulative count by `createdAt`, so each
    // tile shows how its current number was built up over time. Derived
    // KPI sparklines are a REAL per-day series from the daily
    // compliance-snapshot job (one frozen point per 24h), not a
    // client-side replay of the loaded rows. Same endpoint + snapshot
    // table the executive dashboard trend uses. A fresh tenant (or the
    // first day after this shipped) returns <2 points → cards render
    // without a sparkline until history accrues.
    const trendsQuery = useQuery({
        queryKey: queryKeys.assets.trends(tenantSlug),
        queryFn: async (): Promise<TrendPayload> => {
            const res = await fetch(apiUrl('/dashboard/trends?days=30'));
            if (!res.ok) throw new Error('Failed to fetch asset trends');
            return res.json();
        },
        staleTime: 5 * 60_000,
    });
    const assetTrends = useMemo(() => {
        const points = trendsQuery.data?.dataPoints ?? [];
        const series = (pick: (d: TrendPayload['dataPoints'][number]) => number): TimeSeriesPoint[] =>
            points.map((d) => ({ date: new Date(d.date), value: pick(d) }));
        const totalRaw = series((d) => d.assetsTotal);
        const activeRaw = series((d) => d.assetsActive);
        const criticalRaw = series((d) => d.assetsHighCriticality);
        const retiredRaw = series((d) => d.assetsRetired);
        // Trim the leading defaulted-zero prefix: the ComplianceSnapshot asset
        // columns are @default(0) and shipped 2026-06-07, so snapshots from
        // before then read 0 for every asset metric — a FALSE history that made
        // the retired curve a fake "ramp from 0" instead of a truthful flat
        // value. Slice all four series by the SAME index (gated on total>0) so
        // they stay date-aligned and start where real data begins.
        const start = firstAssetDataIndex(totalRaw);
        const total = totalRaw.slice(start);
        const active = activeRaw.slice(start);
        const critical = criticalRaw.slice(start);
        const retired = retiredRaw.slice(start);
        // Shared 0-anchored domain so the four sparklines are comparable on
        // absolute scale: `total` rides high, `retired` sits low, instead of
        // each auto-fitting its own range (which made them all look alike).
        // `total` is the superset, so its max is the global max.
        const globalMax = Math.max(1, ...total.map((p) => p.value));
        const sparklineDomain: [number, number] = [0, globalMax];
        return { total, active, critical, retired, sparklineDomain };
    }, [trendsQuery.data]);

    const assetKpiDefs: ReadonlyArray<KpiFilterDef<AssetKpiId>> = useMemo(
        () => [
            {
                id: 'total',
                apply: (ctx) => ctx.clearAll(),
                isActive: (s) => Object.keys(s).length === 0,
            },
            {
                id: 'active',
                apply: (ctx) => ctx.set('status', 'ACTIVE'),
                isActive: (s) => (s.status ?? []).includes('ACTIVE'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'critical',
                apply: (ctx) => ctx.set('criticality', 'HIGH'),
                isActive: (s) => (s.criticality ?? []).includes('HIGH'),
                clear: (ctx) => ctx.removeAll('criticality'),
            },
            {
                id: 'retired',
                apply: (ctx) => ctx.set('status', 'RETIRED'),
                isActive: (s) => (s.status ?? []).includes('RETIRED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
        ],
        [],
    );
    const { activeKpiId: activeAssetKpi, toggle: toggleAssetKpi } =
        useKpiFilter(assetKpiDefs);

    // R10-PR7 — column-visibility gear.
    const assetColumnList = useMemo(
        () => [
            // First-column rule (Risk/Controls parity) — the
            // per-tenant `AST-N` Code leads the column DEFS, but is off by
            // default — toggle it on via the gear. Name is the default lead.
            { id: 'code', label: tm('colCode'), defaultVisible: false },
            { id: 'name', label: t.name },
            { id: 'type', label: t.type },
            { id: 'manufacturer', label: t.manufacturer },
            { id: 'owner', label: t.owner },
            { id: 'status', label: tm('status') },
            // Compliance-only link counts — hidden for a plain farm.
            ...(showCompliance ? [{ id: 'controls', label: t.controlsCol }] : []),
            { id: 'tasks', label: tm('colTasks') },
        ],
        [t, tm, showCompliance],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:assets',
        columns: assetColumnList,
    });

    const assetColumns = useMemo(() => createColumns<any>([
        {
            // First-column convention — `AST-N` Code leads. Mono +
            // tabular-nums so the digits align column-wise; muted
            // tone keeps the canonical-id signal quiet while the
            // Name cell carries the click affordance.
            id: 'code',
            header: tm('colCode'),
            // Args are inferred from the column generic — leaving
            // explicit annotations off keeps the type-narrowness
            // ratchet honest.
            accessorFn: (a) => a.key ?? null,
            cell: ({ getValue }) => {
                const k = getValue();
                return (
                    <span className="font-mono text-xs text-content-muted tabular-nums">
                        {k ?? '—'}
                    </span>
                );
            },
        },
        {
            accessorKey: 'name',
            header: t.name,
            // B2 — match Controls table standard: title cell is a
            // `<Link>` so single-click on the name navigates.
            cell: ({ row, getValue }: any) => (
                <TableTitleCell
                    href={tenantHref(`/assets/${row.original.id}`)}
                    id={`asset-link-${row.original.id}`}
                >
                    {getValue()}
                </TableTitleCell>
            ),
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            accessorKey: 'type',
            header: t.type,
            cell: ({ getValue }: any) => <StatusBadge variant="info" size="sm">{String(getValue()).replace(/_/g, ' ')}</StatusBadge>,
            meta: { mobileCard: { slot: 'status', label: t.type } },
        },
        {
            id: 'manufacturer',
            header: t.manufacturer,
            accessorFn: (a: any) => a.manufacturer || '—',
            meta: { mobileCard: { slot: 'meta', label: t.manufacturer } },
        },
        {
            // B4 — prefer the structured assignee's name, fall back to the
            // free-text keeper.
            id: 'owner',
            header: t.owner,
            accessorFn: (a: any) => a.ownerUser?.name || a.owner || '—',
            meta: { mobileCard: { slot: 'meta', label: t.owner } },
        },
        {
            // B7 — status cell with a per-status tone (IN_MAINTENANCE amber).
            id: 'status',
            header: tm('status'),
            accessorFn: (a) => a.status || 'ACTIVE',
            cell: ({ getValue }) => {
                const s = String(getValue());
                return <StatusBadge variant={ASSET_STATUS_TONE[s] ?? 'neutral'} size="sm">{s.replace(/_/g, ' ')}</StatusBadge>;
            },
            meta: { mobileCard: { slot: 'status', label: tm('status') } },
        },
        // Compliance-only link counts (assets-exoskeleton): the asset↔risk
        // and asset↔control registers only mean something to a tenant running
        // a compliance module. Gated out entirely for a plain farm.
        ...(showCompliance
            ? [
                  {
                      id: 'controls',
                      header: t.controlsCol,
                      accessorFn: (a: any) => a._count?.controls || 0,
                      cell: ({ getValue }: any) => <span className="text-xs">{getValue()}</span>,
                      meta: { mobileCard: { slot: 'meta' as const, label: t.controlsCol } },
                  },
              ]
            : []),
        {
            // B7 — unified linked-task count (done/total), matching Controls.
            id: 'tasks',
            header: tm('colTasks'),
            accessorFn: (a: any) => `${a.taskDone ?? 0}/${a.taskTotal ?? 0}`,
            cell: ({ row }: any) => {
                const total = row.original.taskTotal ?? 0;
                const done = row.original.taskDone ?? 0;
                return (
                    <span
                        className={
                            total > 0 && done === total
                                ? 'text-content-success text-xs'
                                : 'text-content-muted text-xs'
                        }
                    >
                        {done}/{total}
                    </span>
                );
            },
        },
    ]), [t, tm, showCompliance]);

    // B2 — swap the whole surface into the Trash view. Placed after all
    // hooks so hook order stays stable.
    if (showDeleted && permissions.canAdmin) {
        return <DeletedAssetsView tenantSlug={tenantSlug} onBack={() => setShowDeleted(false)} />;
    }

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: tm('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                                { label: t.title },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t.title}</Heading>
                        {t.listDescription && (
                            <p className="text-sm text-content-muted mt-1">{t.listDescription}</p>
                        )}
                    </div>
                    <div className="flex gap-tight">
                        {/* Coverage shield → the compliance coverage board.
                            Hidden for a plain farm (assets-exoskeleton). */}
                        {showCompliance && (
                            <Tooltip content={tm('tooltipCoverage')}>
                                <Link href={tenantHref('/coverage')} aria-label={tm('tooltipCoverage')} className={buttonVariants({ variant: 'secondary', size: 'icon' })}><AppIcon name="shield" size={16} /></Link>
                            </Tooltip>
                        )}
                        {/* B2 — in-page Trash. ADMIN-only (the includeDeleted
                            route + restore/purge are ADMIN-gated). */}
                        {permissions.canAdmin && (
                            <Tooltip content={tm('trashTitle')}>
                                <Button variant="secondary" size="icon" onClick={() => setShowDeleted(true)} id="assets-trash-btn" aria-label={tm('trashTitle')}>
                                    <Trash className="size-4" />
                                </Button>
                            </Tooltip>
                        )}
                        {/* B3 — Add gated on write, matching the empty-state CTA. */}
                        {permissions.canWrite && (
                            <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setIsCreateOpen(true)} id="new-asset-btn">{t.addAsset}</Button>
                        )}
                    </div>
                </div>
            </ListPageShell.Header>

            <ListPageShell.Filters className="space-y-section">
                {/* R23-PR-D — KPI strip above the filter toolbar.
                    Mirrors the Risks-page reference layout exactly:
                    same grid, same gap, same KpiFilterCard primitive,
                    KPIs derived from filter state via useKpiFilter. */}
                <div className="grid grid-cols-1 gap-default sm:grid-cols-2 md:grid-cols-4">
                    {visibleKpiCards.map((card) => {
                        const cfg: Record<
                            string,
                            {
                                value: number;
                                accent: 'indigo' | 'emerald' | 'rose' | 'slate';
                                sparkline?: typeof assetTrends.total;
                            }
                        > = {
                            total: {
                                value: totalAssets,
                                accent: 'indigo',
                                sparkline: assetTrends.total,
                            },
                            active: {
                                value: activeAssets,
                                accent: 'emerald',
                                sparkline: assetTrends.active,
                            },
                            critical: {
                                value: criticalAssets,
                                accent: 'rose',
                                sparkline: assetTrends.critical,
                            },
                            retired: {
                                value: retiredAssets,
                                accent: 'slate',
                                sparkline: assetTrends.retired,
                            },
                        };
                        const c = cfg[card.id];
                        if (!c) return null;
                        return (
                            <KpiFilterCard
                                key={card.id}
                                label={card.label}
                                value={c.value}
                                accent={c.accent}
                                sparkline={c.sparkline}
                                sparklineDomain={assetTrends.sparklineDomain}
                                onClick={() =>
                                    toggleAssetKpi(card.id as AssetKpiId)
                                }
                                selected={activeAssetKpi === card.id}
                            />
                        );
                    })}
                </div>
                <FilterToolbar
                    filters={liveFilters}
                    searchId="assets-search"
                    searchPlaceholder={tm('searchPlaceholder')}
                    actions={<>{columnsDropdown}{filtersDropdown}</>}
                />
            </ListPageShell.Filters>

            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data={assets}
                    columns={orderColumns(assetColumns)}
                    getRowId={(a: any) => a.id}
                    batchActions={permissions.canAdmin ? [assetBulkDelete] : undefined}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    onRowClick={(row) => router.push(tenantHref(`/assets/${row.original.id}`))}
                    emptyState={
                        hasActive ? (
                            <EmptyState
                                size="sm"
                                variant="no-results"
                                title={tm('noResultsTitle')}
                                description={tm('noResultsDescription')}
                                secondaryAction={{
                                    label: tm('clearFilters'),
                                    onClick: () => filterCtx.clearAll(),
                                }}
                            />
                        ) : (
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t.noAssets}
                                description={tm('emptyRecordsDescription')}
                                primaryAction={
                                    permissions.canWrite
                                        ? {
                                              label: tm('addAssetAction'),
                                              onClick: () => setIsCreateOpen(true),
                                          }
                                        : undefined
                                }
                            />
                        )
                    }
                    resourceName={(p) => p ? tm('assetPlural') : tm('assetSingular')}
                    data-testid="assets-table"
                    className="hover:bg-bg-muted"
                />
            </ListPageShell.Body>

            <NewAssetModal
                open={isCreateOpen}
                setOpen={setIsCreateOpen}
                tenantSlug={tenantSlug}
                labels={{
                    name: t.name,
                    type: t.type,
                    location: t.location,
                    cancel: t.cancel,
                    createAsset: t.createAsset,
                    addAsset: t.addAsset,
                }}
            />

            {assetDeleteDialog}
        </ListPageShell>
    );
}
