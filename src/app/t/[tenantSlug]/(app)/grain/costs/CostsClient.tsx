'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { DataTable, createColumns } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/empty-state';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

// ─── Row shapes (mirror the cost-rollup usecase DTOs) ───

interface PlantingCostRow {
    plantingId: string;
    plantingName: string;
    cropVariety: string | null;
    seasonId: string | null;
    locationId: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    currency: string | null;
}
interface SeasonCostRow {
    seasonId: string | null;
    seasonName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    currency: string | null;
    plantingCount: number;
}
interface FieldCostRow {
    locationId: string | null;
    locationName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    currency: string | null;
    plantingCount: number;
}

type Dimension = 'planting' | 'field' | 'season';

type CostResponse =
    | { by: 'planting'; rows: PlantingCostRow[] }
    | { by: 'field'; rows: FieldCostRow[] }
    | { by: 'season'; rows: SeasonCostRow[] };

interface CostsClientProps {
    tenantSlug: string;
    initialBy: Dimension;
    initialData: CostResponse;
}

/** Format a cost magnitude with the row's own currency (precise, not compact). */
function money(v: number | null | undefined, currency: string | null): string {
    if (v == null) return '—';
    const n = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return currency ? `${n} ${currency}` : n;
}

export function CostsClient({
    tenantSlug,
    initialBy,
    initialData,
}: CostsClientProps) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('grainEnums');
    const tc = useTranslations('grain.costs');
    const [by, setBy] = useState<Dimension>(initialBy);

    const dimensionOptions = useMemo(
        () => [
            { value: 'planting', label: t('groupByPlanting') },
            { value: 'field', label: t('groupByField') },
            { value: 'season', label: t('groupBySeason') },
        ],
        [t],
    );

    const costsQuery = useQuery<CostResponse>({
        queryKey: ['grain-costs', tenantSlug, by],
        queryFn: async () => {
            const res = await fetch(apiUrl(`/grain/costs?by=${by}`));
            if (!res.ok) throw new Error('Failed to fetch cost rollup');
            return res.json();
        },
        initialData: by === initialBy ? initialData : undefined,
        // eslint-disable-next-line react-hooks/purity
        initialDataUpdatedAt: by === initialBy ? Date.now() : 0,
        staleTime: 30_000,
    });

    const loading = costsQuery.isLoading && !costsQuery.data;
    const data = costsQuery.data;

    // A failed rollup read must surface as an error, not as the empty
    // state ("no cost data yet") — that reads as "this farm spent
    // nothing", the most misleading possible answer for a cost report.
    // Gated on having no response at all so a failed background refetch
    // never blanks rows already on screen (the DataTable renders `error`
    // INSTEAD of the table).
    const loadError = costsQuery.isError && !data ? tc('loadFailed') : undefined;

    // ─── Columns per dimension. Each branch is fully typed against its
    //     own row shape; the table is rendered in the matching branch so
    //     the row generic and the column generic agree.
    const plantingColumns = useMemo(
        () =>
            createColumns<PlantingCostRow>([
                {
                    accessorKey: 'plantingName',
                    header: tc('colPlanting'),
                    cell: ({ row }) => (
                        <span className="text-content-emphasis">
                            {row.original.plantingName}
                        </span>
                    ),
                },
                {
                    id: 'cropVariety',
                    header: tc('colVariety'),
                    accessorFn: (r) => r.cropVariety ?? '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue() as string}
                        </span>
                    ),
                },
                {
                    id: 'logEntryCost',
                    header: tc('colFieldEventCost'),
                    accessorFn: (r) => r.logEntryCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.logEntryCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'stockCost',
                    header: tc('colInputCost'),
                    accessorFn: (r) => r.stockCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.stockCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'totalCost',
                    header: tc('colTotalCost'),
                    accessorFn: (r) => r.totalCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums block text-right">
                            {money(row.original.totalCost, row.original.currency)}
                        </span>
                    ),
                },
            ]),
        [tc],
    );

    const seasonColumns = useMemo(
        () =>
            createColumns<SeasonCostRow>([
                {
                    id: 'seasonName',
                    header: tc('colSeason'),
                    accessorFn: (r) => r.seasonName ?? tc('unassigned'),
                    cell: ({ getValue }) => (
                        <span className="text-content-emphasis">
                            {getValue() as string}
                        </span>
                    ),
                },
                {
                    id: 'plantingCount',
                    header: tc('colPlantings'),
                    accessorFn: (r) => r.plantingCount,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums">
                            {row.original.plantingCount}
                        </span>
                    ),
                },
                {
                    id: 'logEntryCost',
                    header: tc('colFieldEventCost'),
                    accessorFn: (r) => r.logEntryCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.logEntryCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'stockCost',
                    header: tc('colInputCost'),
                    accessorFn: (r) => r.stockCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.stockCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'totalCost',
                    header: tc('colTotalCost'),
                    accessorFn: (r) => r.totalCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums block text-right">
                            {money(row.original.totalCost, row.original.currency)}
                        </span>
                    ),
                },
            ]),
        [tc],
    );

    const fieldColumns = useMemo(
        () =>
            createColumns<FieldCostRow>([
                {
                    id: 'locationName',
                    header: tc('colField'),
                    accessorFn: (r) => r.locationName ?? tc('unassigned'),
                    cell: ({ getValue }) => (
                        <span className="text-content-emphasis">
                            {getValue() as string}
                        </span>
                    ),
                },
                {
                    id: 'plantingCount',
                    header: tc('colPlantings'),
                    accessorFn: (r) => r.plantingCount,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums">
                            {row.original.plantingCount}
                        </span>
                    ),
                },
                {
                    id: 'logEntryCost',
                    header: tc('colFieldEventCost'),
                    accessorFn: (r) => r.logEntryCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.logEntryCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'stockCost',
                    header: tc('colInputCost'),
                    accessorFn: (r) => r.stockCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.stockCost, row.original.currency)}
                        </span>
                    ),
                },
                {
                    id: 'totalCost',
                    header: tc('colTotalCost'),
                    accessorFn: (r) => r.totalCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums block text-right">
                            {money(row.original.totalCost, row.original.currency)}
                        </span>
                    ),
                },
            ]),
        [tc],
    );

    const emptyState = (
        <EmptyState
            size="sm"
            variant="no-records"
            title={tc('emptyTitle')}
            description={tc('emptyDescription')}
        />
    );

    // Pick the matching DataTable in a typed branch so the row + column
    // generics always agree (the API echoes `by`, so we trust it; fall
    // back to the selected dimension while the first page loads).
    const activeBy = data?.by ?? by;

    return (
        <ListPageShell className="animate-fadeIn gap-section">
            <ListPageShell.Header>
                <PageHeader
                    breadcrumbs={[
                        { label: t('dashboard'), href: tenantHref('/dashboard') },
                        { label: t('costs') },
                    ]}
                    title={tc('title')}
                    description={tc('description')}
                />
            </ListPageShell.Header>
            <ListPageShell.Filters className="space-y-section">
                <ToggleGroup
                    ariaLabel={tc('dimensionAria')}
                    options={dimensionOptions}
                    selected={by}
                    selectAction={(v) => setBy(v as Dimension)}
                />
            </ListPageShell.Filters>
            <ListPageShell.Body>
                {/* mobileFallback="scroll" on all three cost tables — these
                    are wide, dense financial breakdowns (seed / fertiliser /
                    chemical / labour / fuel / total cost columns per row). The
                    cost columns only make sense read side-by-side, so on a
                    phone we keep the horizontally-scrollable table rather than
                    collapse each row into a card. */}
                {activeBy === 'planting' && (
                    <DataTable<PlantingCostRow>
                        fillBody
                        mobileFallback="scroll"
                        data={
                            data && data.by === 'planting' ? data.rows : []
                        }
                        columns={plantingColumns}
                        loading={loading}
                        error={loadError}
                        getRowId={(r) => r.plantingId}
                        emptyState={emptyState}
                        resourceName={(p) => (p ? 'plantings' : 'planting')}
                        data-testid="grain-costs-table"
                    />
                )}
                {activeBy === 'season' && (
                    <DataTable<SeasonCostRow>
                        fillBody
                        mobileFallback="scroll"
                        data={data && data.by === 'season' ? data.rows : []}
                        columns={seasonColumns}
                        loading={loading}
                        error={loadError}
                        getRowId={(r) => r.seasonId ?? 'unassigned'}
                        emptyState={emptyState}
                        resourceName={(p) => (p ? 'seasons' : 'season')}
                        data-testid="grain-costs-table"
                    />
                )}
                {activeBy === 'field' && (
                    <DataTable<FieldCostRow>
                        fillBody
                        mobileFallback="scroll"
                        data={data && data.by === 'field' ? data.rows : []}
                        columns={fieldColumns}
                        loading={loading}
                        error={loadError}
                        getRowId={(r) => r.locationId ?? 'unassigned'}
                        emptyState={emptyState}
                        resourceName={(p) => (p ? 'fields' : 'field')}
                        data-testid="grain-costs-table"
                    />
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
