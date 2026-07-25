'use client';

/**
 * Farm Tasks — the field-work management queue (the sole task UI).
 *
 * Lists GET /farm-tasks?scope=all (every FARM_TASK + FIELD_OPERATION in the
 * tenant, soonest-due first) so OWNER/ADMIN/EDITOR can see and manage work
 * they assigned to others; operators complete their own list on /my-work.
 * Rows open the shared task detail at /farm-tasks/[taskId]; the header create
 * modal POSTs /farm-tasks.
 *
 * Capabilities surfaced here (all reuse the shared task backend, no fork):
 *   - Filter / search (status · assignee · due) + KPI strip — client-side over
 *     the bounded queue, mirroring the Journal list page.
 *   - Inline "Mark done" (POST /tasks/[id]/status → RESOLVED) for the assignee
 *     AND managers (canWrite), closing the gap where non-operators had no
 *     completion path outside the operator-locked /my-work.
 *   - Bulk assign / status / due / delete via /tasks/bulk/*.
 *
 * A farm task is a thin discriminator over the IC Task module: its
 * LiteFarm-catalog type + category ride in `Task.metadataJson`, and it links
 * to Locations / Equipment via TaskLink.
 */

import { useMemo, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useThresholdLoadMore, PullToRefresh } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { TableLoadMoreFooter } from '@/components/ui/table-load-more-footer';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Plus, CircleCheck } from '@/components/ui/icons/nucleo';
import { Fab } from '@/components/ui/fab';
import { createColumns, useBulkDelete } from '@/components/ui/table';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { parseYMD, toYMD, startOfUtcDay } from '@/components/ui/date-picker/date-utils';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { formatDate } from '@/lib/format-date';
import { TERMINAL_WORK_ITEM_STATUSES } from '@/app-layer/domain/work-item-status';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import { FARM_TASK_FILTER_KEYS, buildFarmTaskFilters } from './filter-defs';
import {
    FARM_TASK_TYPES,
    FARM_TASK_CATEGORIES,
    getFarmTaskType,
} from '@/lib/agriculture/farm-task-types';

interface FarmTaskRow {
    id: string;
    title: string;
    type: string;
    status: string;
    dueAt: string | null;
    createdAt: string;
    priority?: string | null;
    assignee: { id: string; name: string | null; email: string } | null;
    metadataJson?: { farmTaskType?: string; farmTaskCategory?: string } | null;
}

interface EquipmentRow { id: string; name: string; category: string; make: string | null; model: string | null; }
interface LocationRow { id: string; name: string; }

type Priority = 'P0' | 'P1' | 'P2' | 'P3';

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    OPEN: 'neutral',
    TRIAGED: 'info',
    IN_PROGRESS: 'info',
    BLOCKED: 'error',
    PENDING_REVIEW: 'warning',
    RESOLVED: 'success',
    CLOSED: 'neutral',
    CANCELED: 'neutral',
};
const PRIORITY_VALUES = ['P0', 'P1', 'P2', 'P3'];
// Statuses a task can legally reach RESOLVED from (BLOCKED must be unblocked
// first). "Mark done" is only offered from these — see WORK_ITEM_TRANSITIONS.
const DONE_FROM_STATUSES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'PENDING_REVIEW'];
// Non-terminal targets for the bulk status action (terminal statuses need a
// per-task resolution note, so they aren't offered in bulk).
const BULK_STATUS_VALUES = ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED'];

const TYPE_BY_VALUE = new Map(FARM_TASK_TYPES.map((t) => [t.key, t]));
const TYPE_OPTIONS: ComboboxOption[] = FARM_TASK_CATEGORIES.flatMap((cat) =>
    FARM_TASK_TYPES.filter((t) => t.category === cat).map((t) => ({ value: t.key, label: t.name })),
);

function resolveTaskTypeName(row: FarmTaskRow, typeLabel: (type: string) => string): string {
    const key = row.metadataJson?.farmTaskType;
    if (key) {
        const def = getFarmTaskType(key);
        if (def) return def.name;
    }
    return typeLabel(row.type);
}

export function FarmTasksClient({ tenantSlug, currentUserId }: { tenantSlug: string; currentUserId: string | null }) {
    const filterCtx = useFilterContext([], FARM_TASK_FILTER_KEYS);
    return (
        <FilterProvider value={filterCtx}>
            <FarmTasksInner tenantSlug={tenantSlug} currentUserId={currentUserId} />
        </FilterProvider>
    );
}

type FarmKpiId = 'total' | 'open' | 'overdue' | 'dueWeek';

function FarmTasksInner({ tenantSlug, currentUserId }: { tenantSlug: string; currentUserId: string | null }) {
    const buildUrl = useTenantApiUrl();
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const router = useRouter();
    const { permissions } = useTenantContext();
    const canWrite = !!permissions.canWrite;
    const t = useTranslations('farmTasks');
    const te = useTranslations('taskEnums');
    const statusLabel = (s: string) => (te.has(`status.${s}`) ? te(`status.${s}`) : s);
    const typeLabel = (ty: string) => (te.has(`type.${ty}`) ? te(`type.${ty}`) : ty.replace(/_/g, ' '));
    const categoryLabel = (c: string) => (te.has(`category.${c}`) ? te(`category.${c}`) : c);
    const PRIORITY_OPTIONS: ComboboxOption[] = PRIORITY_VALUES.map((v) => ({ value: v, label: te(`priority.${v}`) }));

    // Manager view — the whole tenant's field work, so the assignee filter is
    // meaningful and it fully replaces the retired compliance task list.
    const { data: tasks, mutate, isLoading } = useTenantSWR<FarmTaskRow[]>('/farm-tasks?scope=all');
    const rows = useMemo(() => tasks ?? [], [tasks]);

    const { state, search, hasActive, clearAll } = useFilters();

    // Hydration-safe "now" for overdue / due-soon logic (avoids SSR mismatch).
    const [now, setNow] = useState<Date | null>(null);
    useEffect(() => setNow(new Date()), []);

    // Client-side filtering over the bounded queue (mirrors the Journal page —
    // the endpoint returns a flat merged array, not a filtered query).
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter((row) => {
            const statuses = state.status ?? [];
            if (statuses.length && !statuses.includes(row.status)) return false;
            const assignees = state.assigneeUserId ?? [];
            if (assignees.length && !(row.assignee?.id && assignees.includes(row.assignee.id))) return false;
            const due = state.due ?? [];
            if (due.length) {
                const dueDate = row.dueAt ? new Date(row.dueAt) : null;
                const overdue = !!(now && dueDate && dueDate < now && !(TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(row.status));
                const next7 = !!(now && dueDate && dueDate >= now && dueDate <= new Date(now.getTime() + 7 * 86_400_000));
                if (!((due.includes('overdue') && overdue) || (due.includes('next7d') && next7))) return false;
            }
            if (q) {
                const hay = `${row.title} ${resolveTaskTypeName(row, typeLabel)} ${row.assignee?.name ?? ''} ${row.assignee?.email ?? ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, state, search, now]);

    // ── KPI strip (counts over the loaded queue, not a refilter) ──
    // guardrail-ignore: KPI count, not a client-side refilter.
    const totalTasks = rows.length;
    // guardrail-ignore: KPI count.
    const openTasks = rows.filter((r) => r.status === 'OPEN').length;
    // guardrail-ignore: KPI count.
    const overdueTasks = rows.filter((r) => !!(now && r.dueAt && new Date(r.dueAt) < now && !(TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(r.status))).length;
    // guardrail-ignore: KPI count.
    const dueWeekTasks = rows.filter((r) => {
        if (!now || !r.dueAt) return false;
        const d = new Date(r.dueAt);
        return d >= now && d <= new Date(now.getTime() + 7 * 86_400_000);
    }).length;
    const farmKpiDefs: ReadonlyArray<KpiFilterDef<FarmKpiId>> = useMemo(
        () => [
            { id: 'total', apply: (ctx) => ctx.clearAll(), isActive: (s) => Object.keys(s).length === 0 },
            { id: 'open', apply: (ctx) => ctx.set('status', 'OPEN'), isActive: (s) => (s.status ?? []).includes('OPEN'), clear: (ctx) => ctx.removeAll('status') },
            { id: 'overdue', apply: (ctx) => ctx.set('due', 'overdue'), isActive: (s) => (s.due ?? []).includes('overdue'), clear: (ctx) => ctx.removeAll('due') },
            { id: 'dueWeek', apply: (ctx) => ctx.set('due', 'next7d'), isActive: (s) => (s.due ?? []).includes('next7d'), clear: (ctx) => ctx.removeAll('due') },
        ],
        [],
    );
    const { activeKpiId, toggle: toggleKpi } = useKpiFilter(farmKpiDefs);

    const liveFilters = useMemo(() => buildFarmTaskFilters(te, rows), [te, rows]);

    // ── Create-modal state ──
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [farmTaskType, setFarmTaskType] = useState('');
    const [priority, setPriority] = useState<Priority>('P2');
    const [dueAt, setDueAt] = useState<Date | null>(null);
    const [assigneeUserId, setAssigneeUserId] = useState<string | null>(null);
    const [locationIds, setLocationIds] = useState<string[]>([]);
    const [equipmentIds, setEquipmentIds] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { data: locations } = useTenantSWR<LocationRow[]>('/locations');
    const { data: equipment } = useTenantSWR<EquipmentRow[]>(isCreateOpen ? '/equipment' : null);

    // The FAB jumps to a field's parcel map (where a spray / field operation
    // begins). Relabelled honestly to what it does — it does not create a task.
    const goToFieldMap = () => {
        const first = locations?.[0];
        router.push(first ? tenantHref(`/locations/${first.id}?tab=map`) : tenantHref('/locations'));
    };

    const locationOptions: ComboboxOption[] = useMemo(
        () => (locations ?? []).map((l) => ({ value: l.id, label: l.name })),
        [locations],
    );
    const equipmentOptions: ComboboxOption[] = useMemo(
        () => (equipment ?? []).map((e) => ({
            value: e.id,
            label: [e.name, [e.make, e.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
        })),
        [equipment],
    );

    const resetForm = () => {
        setTitle(''); setFarmTaskType(''); setPriority('P2'); setDueAt(null);
        setAssigneeUserId(null); setLocationIds([]); setEquipmentIds([]); setError(null);
    };
    const openCreate = () => { resetForm(); setIsCreateOpen(true); };
    const canSubmit = title.trim().length > 0 && farmTaskType.length > 0 && !submitting;

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            await apiPost(buildUrl('/farm-tasks'), {
                title: title.trim(),
                farmTaskType,
                priority,
                dueAt: dueAt ? dueAt.toISOString() : null,
                assigneeUserId: assigneeUserId || null,
                locationIds,
                equipmentIds,
            });
            setIsCreateOpen(false);
            resetForm();
            await mutate();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create task');
        } finally {
            setSubmitting(false);
        }
    };

    // ── Inline "Mark done" — assignee self-serve OR manager (canWrite). One
    // click completes with a default resolution (the detail page prompts for a
    // richer note). The server enforces the real authorization + transition. ──
    const [markingId, setMarkingId] = useState<string | null>(null);
    const markDone = useCallback(async (id: string) => {
        setMarkingId(id);
        try {
            await mutate((cur) => (cur ? cur.map((r) => (r.id === id ? { ...r, status: 'RESOLVED' } : r)) : cur), { revalidate: false });
            await apiPost(buildUrl(`/tasks/${id}/status`), { status: 'RESOLVED', resolution: t('quickDoneResolution') });
        } catch {
            /* revalidation below reverts the optimistic patch */
        } finally {
            setMarkingId(null);
            await mutate();
        }
    }, [mutate, buildUrl, t]);

    // ── Bulk selection + actions ──
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const selectedRows = useMemo(() => Object.fromEntries([...selected].map((id) => [id, true])), [selected]);
    const [bulkAction, setBulkAction] = useState('');
    const [bulkValue, setBulkValue] = useState('');
    const [bulkValueLabel, setBulkValueLabel] = useState('');
    const [bulkBusy, setBulkBusy] = useState(false);
    const bulkActionOptions: ComboboxOption[] = [
        { value: 'assign', label: te('ui.assign') },
        { value: 'status', label: te('ui.changeStatus') },
        { value: 'due', label: te('ui.setDueDate') },
    ];
    const bulkStatusOptions: ComboboxOption[] = BULK_STATUS_VALUES.map((v) => ({ value: v, label: statusLabel(v) }));

    const bulkDelete = useBulkDelete<FarmTaskRow>({
        entitySingular: 'task',
        entityPlural: 'tasks',
        onDelete: async (ids) => {
            await apiPost(buildUrl('/tasks/bulk/delete'), { taskIds: ids });
            setSelected(new Set());
            await mutate();
        },
    });

    const handleBulkSubmit = async () => {
        if (!bulkAction || selected.size === 0) return;
        const ids = [...selected];
        setBulkBusy(true);
        try {
            if (bulkAction === 'assign') {
                await apiPost(buildUrl('/tasks/bulk/assign'), { taskIds: ids, assigneeUserId: bulkValue || null });
            } else if (bulkAction === 'status') {
                await apiPost(buildUrl('/tasks/bulk/status'), { taskIds: ids, status: bulkValue });
            } else if (bulkAction === 'due') {
                await apiPost(buildUrl('/tasks/bulk/due'), { taskIds: ids, dueAt: bulkValue || null });
            }
        } finally {
            setBulkBusy(false);
            setSelected(new Set());
            setBulkAction(''); setBulkValue(''); setBulkValueLabel('');
            await mutate();
        }
    };

    const columns = useMemo(
        () =>
            createColumns<FarmTaskRow>([
                {
                    accessorKey: 'title',
                    header: t('colTitle'),
                    cell: ({ row }) => (<span className="font-medium text-content-emphasis">{row.original.title}</span>),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'taskType',
                    header: t('colTaskType'),
                    accessorFn: (r) => resolveTaskTypeName(r, typeLabel),
                    cell: ({ getValue }) => (<span className="text-content-secondary">{getValue() as string}</span>),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'dueAt',
                    header: t('colDue'),
                    accessorFn: (row) => row.dueAt,
                    cell: ({ row }) => row.original.dueAt
                        ? (<span className="text-xs text-content-muted">{formatDate(row.original.dueAt)}</span>)
                        : (<span className="text-content-subtle">—</span>),
                    meta: { disableTruncate: true, mobileCard: { slot: 'meta', label: t('colDue') } },
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_BADGE[row.original.status] ?? 'neutral'} size="sm">
                            {statusLabel(row.original.status)}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status' } },
                },
                {
                    id: 'assignee',
                    header: t('colAssignee'),
                    accessorFn: (row) => row.assignee?.name ?? row.assignee?.email ?? '—',
                    cell: ({ getValue }) => (<span className="text-xs text-content-muted">{getValue() as string}</span>),
                },
                {
                    id: 'actions',
                    header: '',
                    cell: ({ row }) => {
                        const r = row.original;
                        const eligible = (canWrite || (!!currentUserId && r.assignee?.id === currentUserId)) && DONE_FROM_STATUSES.includes(r.status);
                        if (!eligible) return null;
                        return (
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<CircleCheck className="size-4" />}
                                loading={markingId === r.id}
                                onClick={(e) => { e.stopPropagation(); void markDone(r.id); }}
                                id={`mark-done-${r.id}`}
                            >
                                {t('detail.markDone')}
                            </Button>
                        );
                    },
                    meta: { mobileCard: { slot: 'meta' } },
                },
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [t, te, canWrite, currentUserId, markingId, markDone],
    );

    // Roadmap-6 P3 — window the queue to a bounded first slice with a
    // "Load more" footer. Applied to the FILTERED rows.
    const { visibleRows, totalCount, hasMore, loadMore } = useThresholdLoadMore(filtered);

    return (
        <EntityListPage<FarmTaskRow>
            className="gap-section"
            header={{
                breadcrumbs: [
                    { label: t('dashboard'), href: tenantHref('/dashboard') },
                    { label: t('breadcrumb') },
                ],
                title: t('title'),
                description: t('description'),
                actions: canWrite ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={openCreate}
                        id="new-farm-task-btn"
                    >
                        {t('addTask')}
                    </Button>
                ) : undefined,
            }}
            kpis={
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <KpiFilterCard label={t('kpiTotal')} value={totalTasks} onClick={() => toggleKpi('total')} selected={activeKpiId === 'total'} />
                    <KpiFilterCard label={t('kpiOpen')} value={openTasks} tone="attention" onClick={() => toggleKpi('open')} selected={activeKpiId === 'open'} />
                    <KpiFilterCard label={t('kpiOverdue')} value={overdueTasks} tone={overdueTasks > 0 ? 'critical' : 'default'} onClick={() => toggleKpi('overdue')} selected={activeKpiId === 'overdue'} />
                    <KpiFilterCard label={t('kpiDueWeek')} value={dueWeekTasks} tone="attention" onClick={() => toggleKpi('dueWeek')} selected={activeKpiId === 'dueWeek'} />
                </div>
            }
            filters={{
                defs: liveFilters,
                searchId: 'farm-tasks-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            tableFooter={
                <TableLoadMoreFooter
                    hasMore={hasMore}
                    visibleCount={visibleRows.length}
                    totalCount={totalCount}
                    onLoadMore={loadMore}
                    resourceName="tasks"
                    testId="farm-tasks-load-more"
                />
            }
            table={{
                data: visibleRows,
                columns,
                loading: isLoading && !tasks,
                getRowId: (t) => t.id,
                mobileFallback: 'card',
                onRowClick: (row) => router.push(tenantHref(`/farm-tasks/${row.original.id}`)),
                onRowPrefetch: (row) => router.prefetch(tenantHref(`/farm-tasks/${row.original.id}`)),
                ...(canWrite
                    ? {
                          selectedRows,
                          onRowSelectionChange: (rowsSel) => setSelected(new Set(rowsSel.map((r) => r.original.id))),
                          selectionControls: () => (
                              <div className="flex items-center gap-compact flex-wrap">
                                  <Combobox
                                      hideSearch
                                      id="bulk-action-select"
                                      selected={bulkActionOptions.find((o) => o.value === bulkAction) ?? null}
                                      setSelected={(opt) => { setBulkAction(opt?.value ?? ''); setBulkValue(''); setBulkValueLabel(''); }}
                                      options={bulkActionOptions}
                                      placeholder={t('bulkChooseAction')}
                                      matchTriggerWidth
                                      buttonProps={{ className: 'text-sm' }}
                                  />
                                  {bulkAction === 'assign' && (
                                      <UserCombobox
                                          tenantSlug={tenantSlug}
                                          selectedId={bulkValue || null}
                                          onChange={(id, m) => { setBulkValue(id ?? ''); setBulkValueLabel(m?.name ?? m?.email ?? ''); }}
                                          forceDropdown
                                          matchTriggerWidth
                                          placeholder={t('unassigned')}
                                          className="w-full sm:w-44"
                                          id="bulk-value-input"
                                      />
                                  )}
                                  {bulkAction === 'status' && (
                                      <Combobox
                                          hideSearch
                                          id="bulk-value-input"
                                          selected={bulkStatusOptions.find((o) => o.value === bulkValue) ?? null}
                                          setSelected={(opt) => setBulkValue(opt?.value ?? '')}
                                          options={bulkStatusOptions}
                                          placeholder={t('bulkSelectStatus')}
                                          matchTriggerWidth
                                          buttonProps={{ className: 'text-sm' }}
                                      />
                                  )}
                                  {bulkAction === 'due' && (
                                      <DatePicker
                                          id="bulk-value-input"
                                          className="w-full sm:w-40 text-sm"
                                          placeholder={t('datePlaceholder')}
                                          clearable
                                          align="start"
                                          value={parseYMD(bulkValue)}
                                          onChange={(next) => setBulkValue(toYMD(next) ?? '')}
                                          disabledDays={{ before: startOfUtcDay(new Date()) }}
                                          aria-label={t('bulkDueAria')}
                                      />
                                  )}
                                  <Button
                                      variant="primary"
                                      size="sm"
                                      id="bulk-apply-btn"
                                      disabled={!bulkAction || (bulkAction === 'status' && !bulkValue) || bulkBusy}
                                      loading={bulkBusy}
                                      onClick={() => void handleBulkSubmit()}
                                  >
                                      {te('ui.apply')}
                                  </Button>
                                  <Button
                                      variant="destructive"
                                      size="sm"
                                      id="bulk-delete-btn"
                                      disabled={selected.size === 0}
                                      onClick={() => bulkDelete.triggerByIds([...selected])}
                                  >
                                      {t('bulkDelete')}
                                  </Button>
                              </div>
                          ),
                      }
                    : {}),
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('filteredEmptyTitle')}
                        description={t('filteredEmptyDescription')}
                        secondaryAction={{ label: t('clearFilters'), onClick: () => clearAll() }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        primaryAction={canWrite ? { label: t('emptyAction'), onClick: openCreate } : undefined}
                    />
                ),
                resourceName: (p) => (p ? 'tasks' : 'task'),
                'data-testid': 'farm-tasks-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            <PullToRefresh onRefresh={() => mutate()} />
            <ScrollToTop />
            {bulkDelete.dialog}
            <Fab
                onClick={goToFieldMap}
                label={t('openFieldMap')}
                icon={<Plus aria-hidden className="h-6 w-6" />}
            />
            <Modal
                showModal={isCreateOpen}
                setShowModal={setIsCreateOpen}
                size="lg"
                title={t('modalTitle')}
                description={t('modalDescription')}
                preventDefaultClose={submitting}
                isDirty={
                    title.trim().length > 0 || farmTaskType.length > 0 || dueAt !== null ||
                    assigneeUserId !== null || locationIds.length > 0 || equipmentIds.length > 0
                }
            >
                <Modal.Header title={t('modalTitle')} description={t('modalDescription')} />
                <Modal.Form
                    id="farm-task-form"
                    onSubmit={(e) => { e.preventDefault(); void submit(); }}
                >
                    <Modal.Body>
                        {error && (
                            <div role="alert" id="farm-task-error" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                                {error}
                            </div>
                        )}
                        <fieldset disabled={submitting} className="m-0 p-0 border-0 space-y-default">
                            <FormField label={t('fieldTitle')} required>
                                <Input id="farm-task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('titlePlaceholder')} />
                            </FormField>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                                <FormField label={t('fieldTaskType')} required>
                                    <Combobox
                                        id="farm-task-type"
                                        options={TYPE_OPTIONS}
                                        selected={TYPE_OPTIONS.find((o) => o.value === farmTaskType) ?? null}
                                        setSelected={(o) => setFarmTaskType(o?.value ?? '')}
                                        optionDescription={(o) => { const def = TYPE_BY_VALUE.get(o.value); return def ? categoryLabel(def.category) : null; }}
                                        placeholder={t('taskTypePlaceholder')}
                                        searchPlaceholder={t('taskTypeSearch')}
                                        aria-label={t('taskTypeAria')}
                                        matchTriggerWidth
                                    />
                                </FormField>
                                <FormField label={t('fieldPriority')}>
                                    <Combobox
                                        id="farm-task-priority"
                                        options={PRIORITY_OPTIONS}
                                        selected={PRIORITY_OPTIONS.find((o) => o.value === priority) ?? null}
                                        setSelected={(o) => setPriority((o?.value as Priority) ?? 'P2')}
                                        placeholder={t('priorityPlaceholder')}
                                        hideSearch
                                        aria-label={t('priorityAria')}
                                        matchTriggerWidth
                                    />
                                </FormField>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                                <FormField label={t('fieldDueDate')}>
                                    <DatePicker id="farm-task-due" className="w-full" value={dueAt} onChange={setDueAt} clearable placeholder={t('datePlaceholder')} aria-label={t('dueDateAria')} />
                                </FormField>
                                <FormField label={t('fieldAssignee')}>
                                    <UserCombobox id="farm-task-assignee" tenantSlug={tenantSlug} selectedId={assigneeUserId} onChange={(userId) => setAssigneeUserId(userId)} placeholder={t('unassigned')} forceDropdown={false} />
                                </FormField>
                            </div>
                            <FormField label={t('fieldLocations')}>
                                <Combobox
                                    id="farm-task-locations"
                                    multiple
                                    options={locationOptions}
                                    selected={locationOptions.filter((o) => locationIds.includes(o.value))}
                                    setSelected={(opts) => setLocationIds(opts.map((o) => o.value))}
                                    placeholder={locationOptions.length ? t('locationsPlaceholder') : t('locationsEmpty')}
                                    aria-label={t('locationsAria')}
                                    matchTriggerWidth
                                />
                            </FormField>
                            <FormField label={t('fieldEquipment')}>
                                <Combobox
                                    id="farm-task-equipment"
                                    multiple
                                    options={equipmentOptions}
                                    selected={equipmentOptions.filter((o) => equipmentIds.includes(o.value))}
                                    setSelected={(opts) => setEquipmentIds(opts.map((o) => o.value))}
                                    placeholder={equipmentOptions.length ? t('equipmentPlaceholder') : t('equipmentEmpty')}
                                    aria-label={t('equipmentAria')}
                                    matchTriggerWidth
                                />
                            </FormField>
                        </fieldset>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setIsCreateOpen(false)} disabled={submitting} id="farm-task-cancel">
                            {t('cancel')}
                        </Button>
                        <Button variant="primary" size="sm" type="submit" loading={submitting} disabled={!canSubmit} id="farm-task-submit">
                            {t('create')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>
        </EntityListPage>
    );
}
