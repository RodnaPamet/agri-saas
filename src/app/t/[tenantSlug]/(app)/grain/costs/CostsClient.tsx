'use client';

import { useMemo, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { DataTable, createColumns } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/empty-state';
import { useTenantApiUrl, useTenantHref, useTenantCurrencySymbol } from '@/lib/tenant-context-provider';
import { COST_METRICS, COST_METRIC_LABEL_KEYS } from '@/lib/grain/cost-metrics';
import { formatDecimal } from '@/lib/number-format';

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
    /** Currencies the underlying costs were recorded in (usually one). */
    currencies: string[];
    /** True when this row sums costs recorded in more than one currency —
     *  the total is then not a meaningful single figure. */
    currencyMixed: boolean;
    costPerHa?: number | null;
    costPerTonne?: number | null;
    harvestedAreaHa?: number | null;
    producedTonnes?: number | null;
}
interface SeasonCostRow {
    seasonId: string | null;
    seasonName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    /** Currencies the underlying costs were recorded in (usually one). */
    currencies: string[];
    /** True when this row sums costs recorded in more than one currency —
     *  the total is then not a meaningful single figure. */
    currencyMixed: boolean;
    costPerHa?: number | null;
    costPerTonne?: number | null;
    harvestedAreaHa?: number | null;
    producedTonnes?: number | null;
    plantingCount: number;
}
interface FieldCostRow {
    locationId: string | null;
    locationName: string | null;
    logEntryCost: number;
    stockCost: number;
    totalCost: number;
    /** Currencies the underlying costs were recorded in (usually one). */
    currencies: string[];
    /** True when this row sums costs recorded in more than one currency —
     *  the total is then not a meaningful single figure. */
    currencyMixed: boolean;
    costPerHa?: number | null;
    costPerTonne?: number | null;
    harvestedAreaHa?: number | null;
    producedTonnes?: number | null;
    plantingCount: number;
}

type Dimension = 'planting' | 'field' | 'season';

type CostResponse =
    | { by: 'planting'; rows: PlantingCostRow[]; truncated?: boolean }
    | { by: 'field'; rows: FieldCostRow[]; truncated?: boolean }
    | { by: 'season'; rows: SeasonCostRow[]; truncated?: boolean };

interface CostsClientProps {
    tenantSlug: string;
    initialBy: Dimension;
    initialData: CostResponse;
}

/**
 * Format a cost magnitude in the TENANT's configured currency.
 *
 * The previous version labelled each row with its own `costCurrency`, which
 * is null for every entry the journal UI creates (the field was declared in
 * the modal's type and never sent), so money printed as a bare unlabelled
 * number. It only looked right because the demo seed writes 'EUR'.
 *
 * Two vocabularies were also being conflated: `Tenant.currencySymbol` is a
 * SYMBOL ("€") and `costCurrency` is an ISO CODE ("EUR"), with no mapping
 * between them and no FX table anywhere in the product. So a per-row
 * currency cannot be rendered faithfully OR converted — the tenant's
 * configured display currency, which the schema already documents as "the
 * tenant's display currency for every monetary surface", is the only label
 * this page can honestly print.
 *
 * Rows whose recorded currencies disagree are flagged separately
 * (`currencyMixed`) rather than being silently blended under one symbol.
 */
function useCostFormatter(): (v: number | null | undefined) => string {
    const symbol = useTenantCurrencySymbol();
    return useCallback(
        (v: number | null | undefined) => (v == null ? '—' : `${symbol}${formatDecimal(v, 2)}`),
        [symbol],
    );
}

export function CostsClient({
    tenantSlug,
    initialBy,
    initialData,
}: CostsClientProps) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const money = useCostFormatter();
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
                            {money(row.original.logEntryCost)}
                        </span>
                    ),
                },
                {
                    id: 'stockCost',
                    header: tc('colInputCost'),
                    accessorFn: (r) => r.stockCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.stockCost)}
                        </span>
                    ),
                },
                {
                    id: 'totalCost',
                    header: tc('colTotalCost'),
                    accessorFn: (r) => r.totalCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums block text-right">
                            {money(row.original.totalCost)}
                        </span>
                    ),
                },
            ]),
        [tc, money],
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
                            {money(row.original.logEntryCost)}
                        </span>
                    ),
                },
                {
                    id: 'stockCost',
                    header: tc('colInputCost'),
                    accessorFn: (r) => r.stockCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.stockCost)}
                        </span>
                    ),
                },
                {
                    id: 'totalCost',
                    header: tc('colTotalCost'),
                    accessorFn: (r) => r.totalCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums block text-right">
                            {money(row.original.totalCost)}
                        </span>
                    ),
                },
                {
                    // The two figures that turn spend into a question a
                    // farmer can act on: what an area cost, and what a tonne
                    // cost. Null (—) rather than 0 when the yield register
                    // has no area/tonnage for the grouping — "0 per hectare"
                    // would read as a free crop.
                    id: 'costPerHa',
                    header: tc('colCostPerHa'),
                    accessorFn: (r) => r.costPerHa ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.costPerHa)}
                        </span>
                    ),
                },
                {
                    id: 'costPerTonne',
                    header: tc('colCostPerTonne'),
                    accessorFn: (r) => r.costPerTonne ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.costPerTonne)}
                        </span>
                    ),
                },
            ]),
        [tc, money],
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
                            {money(row.original.logEntryCost)}
                        </span>
                    ),
                },
                {
                    id: 'stockCost',
                    header: tc('colInputCost'),
                    accessorFn: (r) => r.stockCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.stockCost)}
                        </span>
                    ),
                },
                {
                    id: 'totalCost',
                    header: tc('colTotalCost'),
                    accessorFn: (r) => r.totalCost,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-emphasis tabular-nums block text-right">
                            {money(row.original.totalCost)}
                        </span>
                    ),
                },
                {
                    id: 'costPerHa',
                    header: tc('colCostPerHa'),
                    accessorFn: (r) => r.costPerHa ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.costPerHa)}
                        </span>
                    ),
                },
                {
                    id: 'costPerTonne',
                    header: tc('colCostPerTonne'),
                    accessorFn: (r) => r.costPerTonne ?? -1,
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted tabular-nums block text-right">
                            {money(row.original.costPerTonne)}
                        </span>
                    ),
                },
            ]),
        [tc, money],
    );

    const emptyState = (
        <EmptyState
            size="sm"
            variant="no-records"
            title={tc('emptyTitle')}
            description={tc('emptyDescription')}
        />
    );

    // A partial total and a blended-currency total are both figures a
    // farmer would otherwise act on. Derived from the loaded payload so they
    // track whichever dimension is on screen.
    const truncated = Boolean(data?.truncated);
    const mixedCurrencies = useMemo(() => {
        // Iterated rather than annotated: `rows` is a UNION of three row
        // arrays, which TypeScript will not assign to one array type — but
        // it iterates the union happily, and every member carries the same
        // two currency fields. No cast needed.
        const rows = data?.rows ?? [];
        const all = new Set<string>();
        let mixed = false;
        for (const r of rows) {
            for (const c of r.currencies) all.add(c);
            if (r.currencyMixed) mixed = true;
        }
        return { list: [...all].sort(), mixed: mixed || all.size > 1 };
    }, [data]);
    const currencyMixed = mixedCurrencies.mixed;
    const mixedCurrencyList = mixedCurrencies.list.join(', ');

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
                    // Named, because two other pages report a DIFFERENT
                    // cost for the same season by design — the org
                    // dashboard counts unattributed spend, the season recap
                    // counts a date window. A reader who sees two numbers
                    // should be able to tell why.
                    eyebrow={tc(COST_METRIC_LABEL_KEYS[COST_METRICS.ATTRIBUTED_CROP_COST])}
                    // Two things a financial page must never hide: that the
                    // figures are only part of the farm, and that they blend
                    // currencies that cannot be added. Either replaces the
                    // ordinary description rather than sitting below it,
                    // because a caveat nobody reads is not a caveat.
                    description={
                        currencyMixed
                            ? tc('currencyMixedWarning', { currencies: mixedCurrencyList })
                            : truncated
                              ? tc('truncatedWarning')
                              : tc('description')
                    }
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
