'use client';

/**
 * Read-only evidence list for Asset / Risk detail pages. Evidence
 * attaches only to controls, so an asset/risk inherits it from the
 * controls it is mapped to. This panel fetches the aggregated rows
 * (each tagged with its owning control) and renders them — no
 * add/upload/unlink, since the evidence lives on the control.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';

interface ControlRef {
    id: string;
    code: string | null;
    name: string;
}
interface InheritedEvidenceRow {
    id: string;
    title: string;
    type: string;
    status: string | null;
    createdAt: string;
    control: ControlRef | null;
}

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral', SUBMITTED: 'info', APPROVED: 'success', REJECTED: 'error',
    PENDING_UPLOAD: 'info',
};

export function InheritedEvidencePanel({
    endpoint,
    tenantHref,
    entityLabel,
}: {
    /** Fully-qualified tenant API path, e.g. apiUrl('/assets/123/evidence'). */
    endpoint: string;
    tenantHref: (path: string) => string;
    /** 'asset' | 'risk' — used only in the explanatory copy. */
    entityLabel: string;
}) {
    const t = useTranslations('inherited.evidence');
    const [rows, setRows] = useState<InheritedEvidenceRow[]>([]);
    const [loading, setLoading] = useState(true);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await fetch(endpoint);
                const data = res.ok ? await res.json() : [];
                if (!cancelled) setRows(Array.isArray(data) ? data : []);
            } catch {
                if (!cancelled) setRows([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [endpoint]);

    const columns = createColumns<InheritedEvidenceRow>([
        {
            id: 'title',
            header: t('colEvidence'),
            accessorFn: (r) => r.title,
            cell: ({ row }) => <span className="text-sm text-content-default">{row.original.title}</span>,
        },
        {
            accessorKey: 'type',
            header: t('colType'),
            cell: ({ getValue }) => <span className="text-xs text-content-muted">{getValue<string>()}</span>,
        },
        {
            id: 'status',
            header: t('colStatus'),
            cell: ({ row }) =>
                row.original.status ? (
                    <StatusBadge variant={STATUS_BADGE[row.original.status] || 'neutral'} size="sm">
                        {row.original.status}
                    </StatusBadge>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'control',
            header: t('colControl'),
            cell: ({ row }) =>
                row.original.control ? (
                    <TableTitleCell href={tenantHref(`/controls/${row.original.control.id}`)}>
                        {row.original.control.code || row.original.control.name}
                    </TableTitleCell>
                ) : (
                    <span className="text-xs text-content-subtle">—</span>
                ),
        },
        {
            id: 'createdAt',
            header: t('colCollected'),
            cell: ({ row }) => (
                <TimestampTooltip date={row.original.createdAt} className="text-xs text-content-muted" />
            ),
        },
    ]);

    return (
        <div className="space-y-default">
            <InlineNotice variant="info">
                {t('notice', { entityLabel })}
            </InlineNotice>
            <DataTable<InheritedEvidenceRow>
                data={rows}
                columns={columns}
                loading={loading}
                getRowId={(r) => r.id}
                emptyState={
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDesc', { entityLabel })}
                    />
                }
            />
        </div>
    );
}
