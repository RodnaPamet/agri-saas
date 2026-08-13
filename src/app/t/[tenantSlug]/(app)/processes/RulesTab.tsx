'use client';

/**
 * Automation Rules tab (Automation Epic 1).
 *
 * The "rule inventory" overview — Archer's workflow-manager entry screen.
 * Lists every automation rule with status, trigger, action, last-fired,
 * execution count, and priority, filterable by status / trigger / action.
 *
 * Filtering is in-memory over the fetched list (rule counts are small).
 * Row click → RuleDetailSheet and the "+ Rule" builder land in Epics 2-3;
 * Epic 1 ships the read-only inventory.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { RuleDetailSheet } from '@/components/processes/RuleDetailSheet';
import { RuleBuilderModal } from '@/components/processes/RuleBuilderModal';
import { TemplateLibraryModal } from '@/components/processes/TemplateLibraryModal';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/format-date';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildRuleFilters,
    RULE_FILTER_KEYS,
    RULE_STATUS_LABELS,
    RULE_ACTION_LABELS,
} from '@/components/processes/automation-filter-defs';
import type { AutomationRuleRow } from '@/components/processes/types';

export type { AutomationRuleRow };


const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ENABLED: 'success',
    DISABLED: 'neutral',
    DRAFT: 'info',
    ARCHIVED: 'neutral',
};

function humanizeEvent(name: string): string {
    return name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/** Comma-separated multi-select match (empty filter = match all). */
function matchesCsv(filterValue: string | null, rowValue: string): boolean {
    if (!filterValue) return true;
    return filterValue.split(',').filter(Boolean).includes(rowValue);
}

export function RulesTab({ tenantSlug }: { tenantSlug: string }) {
    const filterCtx = useFilterContext([], RULE_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <RulesTabInner tenantSlug={tenantSlug} />
        </FilterProvider>
    );
}

function RulesTabInner({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('processes.rules');
    const { state, search } = useFilters();
    const { data, isLoading, error } = useTenantSWR<AutomationRuleRow[]>(
        CACHE_KEYS.automation.rules.list(),
    );
    const [selected, setSelected] = useState<AutomationRuleRow | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [builderOpen, setBuilderOpen] = useState(false);
    const [editRule, setEditRule] = useState<AutomationRuleRow | null>(null);
    const [templatesOpen, setTemplatesOpen] = useState(false);

    const rows = useMemo(() => {
        const all = data ?? [];
        const sp = toApiSearchParams(state, { search });
        const status = sp.get('status');
        const trigger = sp.get('triggerEvent');
        const action = sp.get('actionType');
        return all.filter(
            (r) =>
                matchesCsv(status, r.status) &&
                matchesCsv(trigger, r.triggerEvent) &&
                matchesCsv(action, r.actionType),
        );
    }, [data, state, search]);

    const columns = useMemo(
        () =>
            createColumns<AutomationRuleRow>([
                {
                    accessorKey: 'name',
                    header: t('colName'),
                    cell: ({ row }) => (
                        <span className="font-medium text-content-emphasis">
                            {row.original.name}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    accessorKey: 'triggerEvent',
                    header: t('colTrigger'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {humanizeEvent(row.original.triggerEvent)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    accessorKey: 'actionType',
                    header: t('colAction'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {RULE_ACTION_LABELS[row.original.actionType] ??
                                row.original.actionType}
                        </span>
                    ),
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}
                        >
                            {RULE_STATUS_LABELS[row.original.status] ?? row.original.status}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    accessorKey: 'lastTriggeredAt',
                    header: t('colLastTriggered'),
                    cell: ({ row }) =>
                        row.original.lastTriggeredAt ? (
                            <span className="text-sm text-content-muted tabular-nums">
                                {formatDate(row.original.lastTriggeredAt)}
                            </span>
                        ) : (
                            <span className="text-sm text-content-subtle">{t('never')}</span>
                        ),
                    meta: { mobileCard: { slot: 'meta', label: t('colLastTriggered') } },
                },
                {
                    accessorKey: 'executionCount',
                    header: t('colRuns'),
                    cell: ({ row }) => (
                        <span className="text-sm tabular-nums text-content-muted">
                            {row.original.executionCount}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colRuns') } },
                },
                {
                    accessorKey: 'priority',
                    header: t('colPriority'),
                    cell: ({ row }) => (
                        <span className="text-sm tabular-nums text-content-muted">
                            {row.original.priority}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    return (
        <>
            <EntityListPage<AutomationRuleRow>
                header={{
                    eyebrow: t('eyebrow'),
                    title: t('title'),
                    count: t('ruleCount', { count: rows.length }),
                }}
                filters={{
                    defs: buildRuleFilters(),
                    toolbarActions: (
                        <Button variant="secondary" onClick={() => setTemplatesOpen(true)}>
                            {t('templates')}
                        </Button>
                    ),
                    toolbarPrimary: (
                        <Button
                            variant="primary"
                            icon={<Plus />}
                            onClick={() => {
                                setEditRule(null);
                                setBuilderOpen(true);
                            }}
                            id="new-rule-btn"
                        >
                            {t('newRule')}
                        </Button>
                    ),
                }}
                table={{
                    data: rows,
                    columns,
                    loading: isLoading,
                    error: error ? t('loadError') : undefined,
                    getRowId: (r) => r.id,
                    mobileFallback: 'card',
                    resourceName: (plural) => (plural ? t('resourceOther') : t('resourceOne')),
                    onRowClick: (r) => {
                        setSelected(r.original);
                        setSheetOpen(true);
                    },
                    emptyState: (
                        <EmptyState
                            title={t('emptyTitle')}
                            description={t('emptyDesc')}
                        />
                    ),
                    'data-testid': 'automation-rules-table',
                }}
            />
            <RuleDetailSheet
                rule={selected}
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                onEdit={(r) => {
                    setSheetOpen(false);
                    setEditRule(r);
                    setBuilderOpen(true);
                }}
            />
            <RuleBuilderModal
                tenantSlug={tenantSlug}
                open={builderOpen}
                setOpen={setBuilderOpen}
                editRule={editRule}
            />
            <TemplateLibraryModal open={templatesOpen} setOpen={setTemplatesOpen} />
        </>
    );
}
