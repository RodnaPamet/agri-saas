'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@/components/ui/icons/nucleo';
import { Button } from '@/components/ui/button';
import {
    StatusBadge,
    type StatusBadgeVariant,
} from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
// The canonical task-create modal (the SAME one the Tasks page "+ Task"
// button opens). Reused here so a task created from a control / asset /
// risk detail page is identical to a standalone task — full fields, and
// it lands in the global Tasks table (visible in the Tasks list) linked
// back to this entity via TaskLink.
import { NewTaskModal } from '@/components/tasks/NewTaskModal';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Mirrors the Tasks page (TasksClient) maps so the control / asset /
// risk Tasks tab renders the SAME columns + tones as the global table.
const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    OPEN: 'neutral', TRIAGED: 'info', IN_PROGRESS: 'info',
    BLOCKED: 'error', RESOLVED: 'success', CLOSED: 'neutral', CANCELED: 'neutral',
};
const SEVERITY_BADGE: Record<string, StatusBadgeVariant> = {
    INFO: 'neutral', LOW: 'neutral', MEDIUM: 'warning',
    HIGH: 'error', CRITICAL: 'error',
};

interface LinkedTask {
    id: string;
    key?: string | null;
    title: string;
    type?: string | null;
    status: string;
    severity?: string | null;
    dueAt?: string | null;
    updatedAt?: string | null;
    assignee?: { name?: string | null } | null;
}

interface LinkedTasksPanelProps {
    apiBase: string;
    /**
     * Domain entity the listed tasks are linked to. Drives the filter
     * query AND (when `canWrite`) the entityType passed into the create
     * modal. Canonical values: `'ASSET' | 'CONTROL'`.
     */
    entityType: string;
    entityId: string;
    tenantHref: (path: string) => string;
    /**
     * When true, surface the create affordance + row multi-select.
     * READER roles see only the read-only table.
     */
    canWrite?: boolean;
}

export default function LinkedTasksPanel({
    apiBase,
    entityType,
    entityId,
    tenantHref,
    canWrite = false,
}: LinkedTasksPanelProps) {
    const router = useRouter();
    const te = useTranslations('taskEnums');
    const statusLabel = (s: string) => (te.has(`status.${s}`) ? te(`status.${s}`) : s);
    const typeLabel = (ty: string) => (te.has(`type.${ty}`) ? te(`type.${ty}`) : ty);
    const severityLabel = (s: string) => (te.has(`severity.${s}`) ? te(`severity.${s}`) : s);
    const [tasks, setTasks] = useState<LinkedTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);

    const loadTasks = useCallback(async () => {
        setLoading(true);
        try {
            // `apiBase` is `apiUrl('')` (trailing slash). Strip it so the
            // request stays same-origin (see prior //tasks 308 bug).
            const base = apiBase.replace(/\/+$/, '');
            const res = await fetch(
                `${base}/tasks?linkedEntityType=${encodeURIComponent(entityType)}&linkedEntityId=${encodeURIComponent(entityId)}`,
            );
            const data: unknown = res.ok ? await res.json() : { rows: [] };
            if (Array.isArray(data)) setTasks(data as LinkedTask[]);
            else if (
                data &&
                typeof data === 'object' &&
                Array.isArray((data as { rows?: unknown }).rows)
            ) {
                setTasks((data as { rows: LinkedTask[] }).rows);
            } else setTasks([]);
        } catch {
            setTasks([]);
        } finally {
            setLoading(false);
        }
    }, [apiBase, entityType, entityId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadTasks();
    }, [loadTasks]);

    const canonicalEntityType: 'ASSET' | 'CONTROL' | null =
        entityType === 'ASSET' || entityType === 'CONTROL' ? entityType : null;
    const showCreate = canWrite && canonicalEntityType !== null;

    // Columns mirror the Tasks page table so this tab reads identically.
    const columns = useMemo(
        () =>
            createColumns<LinkedTask>([
                {
                    id: 'title',
                    header: te('ui.colTitle'),
                    accessorFn: (t) => t.title,
                    // Title is a link to the task detail page — same UX
                    // as the global Tasks table. Normal truncation so a
                    // long name can't overrun the next column.
                    cell: ({ row }) => (
                        <TableTitleCell
                            href={tenantHref(`/farm-tasks/${row.original.id}`)}
                        >
                            {row.original.title}
                        </TableTitleCell>
                    ),
                },
                {
                    id: 'type',
                    header: te('ui.colType'),
                    accessorFn: (t) => t.type ?? '',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue<string>() ? typeLabel(getValue<string>()) : '—'}
                        </span>
                    ),
                },
                {
                    id: 'severity',
                    header: te('ui.colSeverity'),
                    accessorFn: (t) => t.severity ?? '',
                    cell: ({ row }) =>
                        row.original.severity ? (
                            <StatusBadge
                                variant={SEVERITY_BADGE[row.original.severity] || 'neutral'}
                            >
                                {severityLabel(row.original.severity)}
                            </StatusBadge>
                        ) : (
                            <span className="text-content-subtle">—</span>
                        ),
                },
                {
                    id: 'status',
                    header: te('ui.colStatus'),
                    accessorFn: (t) => t.status,
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={STATUS_BADGE[row.original.status] || 'neutral'}
                        >
                            {statusLabel(row.original.status)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'assignee',
                    header: te('ui.colAssignee'),
                    accessorFn: (t) => t.assignee?.name || '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue<string>()}
                        </span>
                    ),
                },
                {
                    id: 'dueAt',
                    header: te('ui.colDueDate'),
                    cell: ({ row }) => (
                        <TimestampTooltip
                            date={row.original.dueAt ?? null}
                            className="text-xs text-content-muted"
                        />
                    ),
                },
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tenantHref, te],
    );

    return (
        <div className="space-y-default">
            {showCreate && (
                <>
                    <div className="flex justify-end">
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setCreating(true)}
                            id="linked-task-create-btn"
                            data-testid="linked-task-create-btn"
                            text={te('ui.task')}
                            icon={<Plus className="size-4" aria-hidden="true" />}
                        />
                    </div>
                    <NewTaskModal
                        open={creating}
                        setOpen={setCreating}
                        initialPendingLinks={[
                            {
                                entityType: canonicalEntityType,
                                entityId,
                            },
                        ]}
                        onCreated={() => void loadTasks()}
                    />
                </>
            )}

            <DataTable<LinkedTask>
                data={tasks}
                columns={columns}
                getRowId={(t) => t.id}
                loading={loading}
                // Same UX as the global Tasks table: row select +
                // navigate to the full task detail page on click.
                selectionEnabled={canWrite}
                onRowClick={(row) =>
                    router.push(tenantHref(`/farm-tasks/${row.original.id}`))
                }
                resourceName={(plural) => (plural ? 'tasks' : 'task')}
                emptyState={te('ui.noLinkedTasks')}
                data-testid="linked-tasks-table"
            />
        </div>
    );
}
