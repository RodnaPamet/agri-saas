'use client';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    filtersToCards,
    selectVisibleFilters,
    useFilterCardVisibility,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import { buildKnowledgeFilters, KNOWLEDGE_FILTER_KEYS } from './filter-defs';
import { NewArticleModal } from './NewArticleModal';
import {
    StatusBadge,
    type StatusBadgeVariant,
} from '@/components/ui/status-badge';

/** Article list row — the `GET /knowledge` payload shape. */
export interface ArticleRow {
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    category: string | null;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    source: string | null;
    language: string | null;
    currentVersionId: string | null;
    updatedAt: string;
    createdAt: string;
    owner: { id: string; name: string | null } | null;
}

// Status badge tone keyed off the article status enum. The label
// itself comes from KNOWLEDGE_STATUS_LABELS (single source of truth);
// this map only carries the visual treatment.
const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    PUBLISHED: 'success',
    ARCHIVED: 'warning',
};

interface KnowledgeClientProps {
    initialArticles: ArticleRow[];
    initialFilters?: Record<string, string>;
    tenantSlug: string;
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };
}

/**
 * Client island for the Knowledge Base list — handles filters, live
 * search, and the interactive table. Data arrives pre-fetched from the
 * server component, hydrated into SWR. Mirrors PoliciesClient (the
 * Knowledge feature is the policy feature's twin).
 */
export function KnowledgeClient(props: KnowledgeClientProps) {
    const filterCtx = useFilterContext([], KNOWLEDGE_FILTER_KEYS, {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <KnowledgePageInner {...props} />
        </FilterProvider>
    );
}

function KnowledgePageInner({
    initialArticles,
    initialFilters,
    tenantSlug,
    permissions,
}: KnowledgeClientProps) {
    const t = useTranslations('knowledge');
    const tFilters = useTranslations('knowledge.filters');
    const tStatus = useTranslations('knowledge.status');
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const router = useRouter();

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;
    const fetchParams = useMemo(
        () => toApiSearchParams(state, { search }),
        [state, search],
    );
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of fetchParams) obj[k] = v;
        return obj;
    }, [fetchParams]);

    const serverHadFilters =
        initialFilters && Object.keys(initialFilters).length > 0;
    const filtersMatchInitial = useMemo(() => {
        if (!serverHadFilters) return !hasActive;
        const keys = new Set([
            ...Object.keys(queryKeyFilters),
            ...Object.keys(initialFilters!),
        ]);
        for (const k of keys) {
            if ((queryKeyFilters[k] ?? '') !== (initialFilters![k] ?? '')) {
                return false;
            }
        }
        return true;
    }, [queryKeyFilters, initialFilters, serverHadFilters, hasActive]);

    // SWR read against a filter-aware cache key — each filter combination
    // is its own cache entry (qs suffix keeps them isolated). The
    // server-rendered list lands as `fallbackData` only when the active
    // filters match the server view; otherwise the hook fires a fresh
    // request immediately. The knowledge GET returns a bare ArticleRow[].
    const articlesKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs ? `/knowledge?${qs}` : '/knowledge';
    }, [fetchParams]);

    const articlesQuery = useTenantSWR<ArticleRow[]>(articlesKey, {
        fallbackData: filtersMatchInitial ? initialArticles : undefined,
    });

    const articles = articlesQuery.data ?? [];
    const loading = articlesQuery.isLoading && !articlesQuery.data;

    const liveFilters = useMemo(
        () => buildKnowledgeFilters(tFilters, tStatus, articles),
        [tFilters, tStatus, articles],
    );
    const filterCards = useMemo(() => filtersToCards(liveFilters), [liveFilters]);
    const { visibleCards, dropdown: filtersDropdown } = useFilterCardVisibility({
        storageKey: 'inflect:filter-vis:knowledge',
        cards: filterCards,
    });
    const visibleFilterDefs = useMemo(
        () => selectVisibleFilters(visibleCards, liveFilters),
        [visibleCards, liveFilters],
    );

    const columns = useMemo(
        () =>
            createColumns<ArticleRow>([
                {
                    accessorKey: 'title',
                    header: t('colTitle'),
                    cell: ({ row }) => (
                        <TableTitleCell
                            href={tenantHref(`/knowledge/${row.original.id}`)}
                        >
                            {row.original.title}
                        </TableTitleCell>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'category',
                    header: t('colCategory'),
                    accessorFn: (a) => a.category || '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">
                            {getValue<string>()}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => {
                        const status = row.original.status;
                        const variant = STATUS_BADGE[status] ?? 'neutral';
                        const label = tStatus(status);
                        return (
                            <StatusBadge
                                variant={variant}
                                data-testid={`knowledge-status-${row.original.id}`}
                            >
                                {label}
                            </StatusBadge>
                        );
                    },
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'source',
                    header: t('colSource'),
                    accessorFn: (a) => a.source || '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-subtle">
                            {getValue<string>()}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colSource') } },
                },
                {
                    id: 'updatedAt',
                    header: t('colUpdated'),
                    accessorFn: (a) => a.updatedAt,
                    cell: ({ getValue }) => (
                        <TimestampTooltip
                            date={getValue<string | null | undefined>()}
                            className="text-xs text-content-subtle"
                        />
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colUpdated') } },
                },
            ]),
        [tenantHref, t, tStatus],
    );

    return (
        <EntityListPage<ArticleRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: t('bcDashboard'), href: tenantHref('/dashboard') },
                    { label: t('bcKnowledge') },
                ],
                title: t('title'),
                description: t('description'),
                actions: permissions.canWrite ? (
                    <NewArticleModal
                        trigger={
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                id="new-article-btn"
                            >
                                {t('newArticle')}
                            </Button>
                        }
                        onCreated={(article) =>
                            router.push(
                                tenantHref(`/knowledge/${article.id}`),
                            )
                        }
                    />
                ) : null,
            }}
            filters={{
                defs: visibleFilterDefs,
                searchId: 'knowledge-search',
                searchPlaceholder: t('searchPlaceholder'),
                toolbarActions: filtersDropdown,
            }}
            table={{
                data: articles,
                columns,
                loading,
                getRowId: (a) => a.id,
                mobileFallback: 'card',
                onRowClick: (row) =>
                    router.push(tenantHref(`/knowledge/${row.original.id}`)),
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('emptyFilteredTitle')}
                        description={t('emptyFilteredDesc')}
                        secondaryAction={{
                            label: t('clearFilters'),
                            onClick: () => filterCtx.clearAll(),
                        }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDesc')}
                    />
                ),
                resourceName: (a) => (a ? 'articles' : 'article'),
                'data-testid': 'knowledge-table',
                className: 'hover:bg-bg-muted',
            }}
        />
    );
}
