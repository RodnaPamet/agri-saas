'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useCursorPagination } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import type { NonPerformingPracticeRow } from '@/app-layer/schemas/portfolio';
import { Heading } from '@/components/ui/typography';

interface Props {
    rows: NonPerformingPracticeRow[];
    /** Encoded cursor for the next page returned by the server's first
     *  `listNonPerformingPractices` call. Null when the first page is
     *  also the last. */
    nextCursor?: string | null;
    /** Org slug used to build the API endpoint for client-side
     *  Load-more requests. Required when `nextCursor` is non-null. */
    orgSlug?: string;
}

const STATUS_VARIANTS: Record<NonPerformingPracticeRow['status'], 'warning' | 'info' | 'error'> = {
    NOT_STARTED: 'error',
    PLANNED: 'warning',
    IN_PROGRESS: 'info',
    IMPLEMENTING: 'info',
    NEEDS_REVIEW: 'warning',
};

function StatusBadgeForPractice({ status }: { status: NonPerformingPracticeRow['status'] }) {
    const variant = STATUS_VARIANTS[status];
    return <StatusBadge variant={variant}>{status.replace(/_/g, ' ')}</StatusBadge>;
}

export function PracticesTable({ rows: initialRows, nextCursor: initialNextCursor, orgSlug }: Props) {
    const t = useTranslations('practices');
    const [sortBy, setSortBy] = useState<string>('tenantName');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

    // Epic E — Load-more accumulator. Server-rendered initial page +
    // client-side fetched subsequent pages. Replaces the older
    // `<Link href="?cursor=...">` pattern that REPLACED rather than
    // accumulated, capping the dedicated drill-down at 50 rows.
    const pagination = useCursorPagination<NonPerformingPracticeRow>({
        initialRows,
        initialNextCursor: initialNextCursor ?? null,
        fetchUrl: (cursor) =>
            `/api/org/${orgSlug ?? ''}/portfolio?view=practices&cursor=${encodeURIComponent(cursor)}`,
    });

    const sorted = useMemo(() => {
        const copy = [...pagination.rows];
        copy.sort((a, b) => {
            const dir = sortOrder === 'asc' ? 1 : -1;
            switch (sortBy) {
                case 'name':
                    return dir * a.name.localeCompare(b.name);
                case 'code':
                    return dir * (a.code ?? '').localeCompare(b.code ?? '');
                case 'status':
                    return dir * a.status.localeCompare(b.status);
                case 'updatedAt':
                    return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
                case 'tenantName':
                default:
                    return dir * a.tenantName.localeCompare(b.tenantName) || a.name.localeCompare(b.name);
            }
        });
        return copy;
    }, [pagination.rows, sortBy, sortOrder]);

    const columns = useMemo(
        () =>
            createColumns<NonPerformingPracticeRow>([
                {
                    id: 'tenantName',
                    header: t('orgTable.colTenant'),
                    cell: ({ row }) => (
                        <span
                            className="text-xs font-medium text-content-muted"
                            data-testid={`org-practice-tenant-${row.original.tenantSlug}`}
                        >
                            {row.original.tenantName}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'name',
                    header: t('orgTable.colPractice'),
                    cell: ({ row }) => (
                        <Link
                            href={row.original.drillDownUrl}
                            className="font-medium text-content-emphasis hover:text-content-info hover:underline"
                            data-testid={`org-practice-link-${row.original.practiceId}`}
                        >
                            {row.original.name}
                        </Link>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'code',
                    header: t('orgTable.colCode'),
                    cell: ({ row }) => (
                        <span className="font-mono text-xs text-content-muted">
                            {row.original.code ?? '—'}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('orgTable.colCode') } },
                },
                {
                    id: 'status',
                    header: t('orgTable.colStatus'),
                    cell: ({ row }) => <StatusBadgeForPractice status={row.original.status} />,
                    meta: { mobileCard: { slot: 'status', label: t('orgTable.colStatus') } },
                },
                {
                    id: 'updatedAt',
                    header: t('orgTable.colUpdated'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle tabular-nums">
                            {formatDate(row.original.updatedAt)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('orgTable.colUpdated') } },
                },
            ]),
        [t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div>
                    <Heading level={1}>
                        {t('orgTable.heading')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('orgTable.summary', { count: pagination.rows.length })}
                        {pagination.hasMore ? t('orgTable.moreAvailable') : ''}
                    </p>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<NonPerformingPracticeRow>
                    fillBody
                    mobileFallback="card"
                    // Epic 68 — Practices is the canonical opt-out site
                    // for auto-virtualization. The bespoke load-more
                    // pagination + per-row affordances rely on the
                    // standard non-virtualized DataTable layout. Per
                    // product directive, card scrolling on Practices
                    // stays as it is.
                    virtualize={false}
                    data={sorted}
                    columns={columns}
                    getRowId={(r) => r.practiceId}
                    sortableColumns={['tenantName', 'name', 'code', 'status', 'updatedAt']}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={(p) => {
                        if (p.sortBy) setSortBy(p.sortBy);
                        if (p.sortOrder) setSortOrder(p.sortOrder);
                    }}
                    resourceName={(plural) => (plural ? 'practices' : 'practice')}
                    emptyState={
                        <TableEmptyState
                            title={t('orgTable.emptyTitle')}
                            description={t('orgTable.emptyDescription')}
                            icon={<ShieldCheck className="size-10" />}
                        />
                    }
                    data-testid="org-practices-table"
                />
                {pagination.hasMore && orgSlug && (
                    <div className="flex flex-col items-center gap-tight pt-3">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="org-practices-load-more"
                            onClick={() => {
                                void pagination.loadMore();
                            }}
                            disabled={pagination.loading}
                        >
                            {pagination.loading ? t('orgTable.loadingMore') : t('orgTable.loadMore')}
                        </Button>
                        {pagination.error && (
                            <span
                                className="text-content-error text-sm"
                                role="alert"
                                data-testid="org-practices-load-error"
                            >
                                {t('orgTable.loadError')}
                            </span>
                        )}
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
