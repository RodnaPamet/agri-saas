'use client';
/* eslint-disable @typescript-eslint/no-explicit-any -- Client component receiving server-rendered domain data; tanstack column callbacks carry implicit-any on `row` / `getValue` and the per-cell narrowing requires importing CellContext generics from tanstack — outside the scope of this layout move. */
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { useMemo } from 'react';
import { DataTable, createColumns } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { StatusBadge } from '@/components/ui/status-badge';

interface AuditLogClientProps {
    auditLog: any[];
    translations: {
        time: string;
        user: string;
        action: string;
        entity: string;
        details: string;
        noEntries: string;
    };
}

/**
 * R13-PR10 — Audit log table extracted from the admin landing
 * (formerly the "Audit log" tab inside `AdminClient.tsx`) into a
 * dedicated page so admin landing reads as a pure pill-nav surface.
 */
export function AuditLogClient({ auditLog, translations: t }: AuditLogClientProps) {
    const { formatDateTime } = useDateFormat();
    const logColumns = useMemo(() => createColumns<any>([
        {
            id: 'time',
            header: t.time,
            accessorFn: (e: any) => e.createdAt,
            cell: ({ getValue }: any) => <span className="whitespace-nowrap">{formatDateTime(getValue())}</span>,
            meta: { mobileCard: { slot: 'meta', label: t.time } },
        },
        {
            id: 'user',
            header: t.user,
            accessorFn: (e: any) => e.user?.name || '—',
            cell: ({ getValue }: any) => <span>{getValue()}</span>,
            meta: { mobileCard: { slot: 'subtitle' } },
        },
        {
            accessorKey: 'action',
            header: t.action,
            cell: ({ getValue }: any) => <StatusBadge variant="info">{getValue()}</StatusBadge>,
            meta: { mobileCard: { slot: 'status', label: t.action } },
        },
        {
            accessorKey: 'entity',
            header: t.entity,
            cell: ({ getValue }: any) => <span>{getValue()}</span>,
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            accessorKey: 'details',
            header: t.details,
            cell: ({ getValue }: any) => <span className="text-content-muted max-w-xs truncate">{getValue()}</span>,
            meta: { mobileCard: { slot: 'meta', label: t.details } },
        },
    ]), [t, formatDateTime]);

    return (
        <ListPageShell.Body>
            <DataTable
                fillBody
                mobileFallback="card"
                data={auditLog}
                columns={logColumns}
                getRowId={(e: any) => e.id}
                emptyState={t.noEntries}
                resourceName={(p) => (p ? 'log entries' : 'log entry')}
                data-testid="audit-log-table"
            />
        </ListPageShell.Body>
    );
}
