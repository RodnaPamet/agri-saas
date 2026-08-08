'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { createColumns } from '@/components/ui/table';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { formatDate } from '@/lib/format-date';
import {
    SUPPORT_SCHEME_AUTHORITIES,
    SUPPORT_SCHEME_STATUSES,
} from '@/app-layer/schemas/support-scheme.schemas';

export interface SupportSchemeRow {
    id: string;
    title: string;
    summary: string | null;
    authority: string;
    measureCode: string | null;
    status: string;
    applicationOpensAt: string | null;
    applicationClosesAt: string | null;
    eligibilitySummary: string | null;
    sourceUrl: string | null;
    source: string;
    sourceTitle: string | null;
    confidence: number | null;
    extractedAt: string | null;
}

interface Props {
    tenantSlug: string;
    initialSchemes: SupportSchemeRow[];
}

const STATUS_TONE: Record<string, StatusBadgeVariant> = {
    open: 'success',
    'closing-soon': 'warning',
    announced: 'info',
    closed: 'neutral',
};

export function SchemesClient(props: Props) {
    const filterCtx = useFilterContext([], ['authority', 'status'], {});
    return (
        <FilterProvider value={filterCtx}>
            <SupportSchemesInner {...props} />
        </FilterProvider>
    );
}

function SupportSchemesInner({ initialSchemes }: Props) {
    const t = useTranslations('supportSchemes');
    const { search, hasActive, clearAll } = useFilters();

    const query = useTenantSWR<SupportSchemeRow[]>(CACHE_KEYS.schemes.list(), {
        fallbackData: initialSchemes,
    });
    const all = query.data ?? initialSchemes;

    const rows = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return all;
        return all.filter(
            (s) =>
                s.title.toLowerCase().includes(q) ||
                (s.measureCode ?? '').toLowerCase().includes(q) ||
                s.authority.toLowerCase().includes(q),
        );
    }, [all, search]);

    const columns = useMemo(
        () =>
            createColumns<SupportSchemeRow>([
                {
                    accessorKey: 'title',
                    header: t('colTitle'),
                    cell: ({ row }) => (
                        <TableTitleCell id={`support-scheme-${row.original.id}`}>
                            {row.original.title}
                        </TableTitleCell>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    accessorKey: 'authority',
                    header: t('colAuthority'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.authority}
                            {row.original.measureCode ? ` · ${row.original.measureCode}` : ''}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_TONE[row.original.status] ?? 'neutral'}>
                            {t(`status_${row.original.status.replace('-', '_')}`)}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'window',
                    header: t('colWindow'),
                    cell: ({ row }) => {
                        const { applicationOpensAt: o, applicationClosesAt: c } = row.original;
                        if (!o && !c) return <span className="text-content-subtle">—</span>;
                        return (
                            <span className="text-xs text-content-muted tabular-nums">
                                {o ? formatDate(o) : '—'} → {c ? formatDate(c) : '—'}
                            </span>
                        );
                    },
                    meta: { mobileCard: { slot: 'meta', label: t('colWindow') } },
                },
                {
                    id: 'provenance',
                    header: t('colSource'),
                    // The disclosure that matters. An AI reading of a news
                    // article and an official ДФЗ announcement are different
                    // kinds of claim, and a farmer about to act on a deadline
                    // needs to see which one they are looking at — with the
                    // source link and the extraction date, not just a label.
                    cell: ({ row }) => {
                        const s = row.original;
                        const isAi = s.source === 'ai-news';
                        return (
                            <div className="flex flex-col gap-0.5">
                                <StatusBadge
                                    variant={isAi ? 'warning' : 'info'}
                                    id={`support-scheme-source-${s.id}`}
                                >
                                    {t(`source_${s.source.replace('-', '_')}`)}
                                </StatusBadge>
                                {s.sourceUrl && (
                                    <a
                                        href={s.sourceUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-[var(--brand-default)] underline"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {t('sourceLink')}
                                    </a>
                                )}
                                {isAi && s.extractedAt && (
                                    <span className="text-xs text-content-subtle">
                                        {t('extractedOn', { date: formatDate(s.extractedAt) })}
                                    </span>
                                )}
                            </div>
                        );
                    },
                    meta: {
                        disableTruncate: true,
                        mobileCard: { slot: 'meta', label: t('colSource') },
                    },
                },
            ]),
        [t],
    );

    const filterDefs = useMemo(
        () => [
            {
                key: 'authority',
                label: t('filterAuthority'),
                options: SUPPORT_SCHEME_AUTHORITIES.map((a) => ({ value: a, label: a })),
                multiple: false as const,
            },
            {
                key: 'status',
                label: t('filterStatus'),
                options: SUPPORT_SCHEME_STATUSES.map((s) => ({
                    value: s,
                    label: t(`status_${s.replace('-', '_')}`),
                })),
                multiple: false as const,
            },
        ],
        [t],
    );

    return (
        <EntityListPage<SupportSchemeRow>
            className="animate-fadeIn gap-section"
            header={{
                title: t('title'),
                description: t('listDescription'),
            }}
            filters={{
                defs: filterDefs as never,
                searchId: 'support-scheme-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: rows,
                columns,
                getRowId: (s) => s.id,
                mobileFallback: 'card',
                // No batch actions here, so selection would cost a click and
                // give nothing back.
                selectionEnabled: false,
                error: query.error && rows.length === 0 ? t('loadFailed') : undefined,
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('noResultsTitle')}
                        description={t('noResultsDescription')}
                        secondaryAction={{ label: t('clearFilters'), onClick: () => clearAll() }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                    />
                ),
                resourceName: (p) => (p ? t('schemePlural') : t('schemeSingular')),
                'data-testid': 'schemes-table',
            }}
        />
    );
}
