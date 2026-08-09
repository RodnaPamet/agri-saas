'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useCursorPagination } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import type { OverdueEvidenceRow } from '@/app-layer/schemas/portfolio';
import { Heading } from '@/components/ui/typography';

interface Props {
    rows: OverdueEvidenceRow[];
    nextCursor?: string | null;
    orgSlug?: string;
}

const STATUS_VARIANTS: Record<OverdueEvidenceRow['status'], 'warning' | 'info' | 'error'> = {
    DRAFT: 'warning',
    SUBMITTED: 'info',
    REJECTED: 'error',
};

function OverdueBadge({ days }: { days: number }) {
    const t = useTranslations('evidence');
    // 30+ days → critical, 7+ → warning, otherwise pending.
    const variant = days >= 30 ? 'error' : days >= 7 ? 'warning' : 'warning';
    return (
        <StatusBadge variant={variant}>
            {t('overdue.daysOverdue', { days })}
        </StatusBadge>
    );
}

export function EvidenceTable({ rows: initialRows, nextCursor: initialNextCursor, orgSlug }: Props) {
    const t = useTranslations('evidence');
    const [sortBy, setSortBy] = useState<string>('daysOverdue');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Epic E — Load-more accumulator. See PracticesTable for design.
    const pagination = useCursorPagination<OverdueEvidenceRow>({
        initialRows,
        initialNextCursor: initialNextCursor ?? null,
        fetchUrl: (cursor) =>
            `/api/org/${orgSlug ?? ''}/portfolio?view=evidence&cursor=${encodeURIComponent(cursor)}`,
    });

    const sorted = useMemo(() => {
        const copy = [...pagination.rows];
        copy.sort((a, b) => {
            const dir = sortOrder === 'asc' ? 1 : -1;
            switch (sortBy) {
                case 'tenantName':
                    return dir * a.tenantName.localeCompare(b.tenantName);
                case 'title':
                    return dir * a.title.localeCompare(b.title);
                case 'status':
                    return dir * a.status.localeCompare(b.status);
                case 'nextReviewDate':
                    return dir * (new Date(a.nextReviewDate).getTime() - new Date(b.nextReviewDate).getTime());
                case 'daysOverdue':
                default:
                    return dir * (a.daysOverdue - b.daysOverdue) || a.tenantName.localeCompare(b.tenantName);
            }
        });
        return copy;
    }, [pagination.rows, sortBy, sortOrder]);

    const columns = useMemo(
        () =>
            createColumns<OverdueEvidenceRow>([
                {
                    id: 'tenantName',
                    header: t('overdue.colTenant'),
                    cell: ({ row }) => (
                        <span
                            className="text-xs font-medium text-content-muted"
                            data-testid={`org-evidence-tenant-${row.original.tenantSlug}`}
                        >
                            {row.original.tenantName}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'title',
                    header: t('overdue.colEvidence'),
                    cell: ({ row }) => (
                        <Link
                            href={row.original.drillDownUrl}
                            className="font-medium text-content-emphasis hover:text-content-info hover:underline"
                            data-testid={`org-evidence-link-${row.original.evidenceId}`}
                        >
                            {row.original.title}
                        </Link>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'daysOverdue',
                    header: t('overdue.colOverdue'),
                    cell: ({ row }) => <OverdueBadge days={row.original.daysOverdue} />,
                    meta: { mobileCard: { slot: 'meta', label: t('overdue.colOverdue') } },
                },
                {
                    id: 'status',
                    header: t('overdue.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANTS[row.original.status]}>
                            {row.original.status}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('overdue.colStatus') } },
                },
                {
                    id: 'nextReviewDate',
                    header: t('overdue.colReviewDue'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle tabular-nums">
                            {formatDate(row.original.nextReviewDate)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('overdue.colReviewDue') } },
                },
            ]),
        [t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div>
                    <Heading level={1}>
                        {t('overdue.title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('overdue.subtitle', { count: pagination.rows.length })}
                        {pagination.hasMore ? t('overdue.moreAvailable') : ''}
                    </p>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<OverdueEvidenceRow>
                    fillBody
                    mobileFallback="card"
                    data={sorted}
                    columns={columns}
                    getRowId={(r) => r.evidenceId}
                    sortableColumns={['tenantName', 'title', 'daysOverdue', 'status', 'nextReviewDate']}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={(p) => {
                        if (p.sortBy) setSortBy(p.sortBy);
                        if (p.sortOrder) setSortOrder(p.sortOrder);
                    }}
                    resourceName={(plural) => (plural ? t('overdue.resourcePlural') : t('overdue.resourceSingular'))}
                    emptyState={
                        <TableEmptyState
                            title={t('overdue.emptyTitle')}
                            description={t('overdue.emptyDescription')}
                            icon={<Paperclip className="size-10" />}
                        />
                    }
                    data-testid="org-evidence-table"
                />
                {pagination.hasMore && orgSlug && (
                    <div className="flex flex-col items-center gap-tight pt-3">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="org-evidence-load-more"
                            onClick={() => {
                                void pagination.loadMore();
                            }}
                            disabled={pagination.loading}
                        >
                            {pagination.loading ? t('overdue.loadingMore') : t('overdue.loadMore')}
                        </Button>
                        {pagination.error && (
                            <span
                                className="text-content-error text-sm"
                                role="alert"
                                data-testid="org-evidence-load-error"
                            >
                                {t('overdue.loadError')}
                            </span>
                        )}
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
