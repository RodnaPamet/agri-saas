'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { NewSchemeModal } from './NewSchemeModal';

/** List-row shape returned by GET /schemes (a global AG_SCHEME framework). */
export interface SchemeRow {
    id: string;
    key: string;
    name: string;
    description: string | null;
    _count?: { requirements?: number; packs?: number };
}

interface SchemesClientProps {
    initialSchemes: SchemeRow[];
    tenantSlug: string;
    permissions: {
        /**
         * May this session AUTHOR a scheme?
         *
         * Not the same as "is an admin". Authoring writes the global catalogue
         * every tenant reads, so it is platform-tenant work — `canAdmin` alone
         * would show every farm's owner a form the API refuses.
         */
        canAuthorScheme: boolean;
    };
}

export function SchemesClient(props: SchemesClientProps) {
    // No server-side filters — search is a live client-side filter over the
    // loaded list, so the filter context carries no defs / keys.
    const filterCtx = useFilterContext([], []);
    return (
        <FilterProvider value={filterCtx}>
            <SchemesPageInner {...props} />
        </FilterProvider>
    );
}

function SchemesPageInner({ initialSchemes, tenantSlug, permissions }: SchemesClientProps) {
    const t = useTranslations('schemes');
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    const { search, hasActive, clearAll } = useFilters();

    const schemesQuery = useTenantSWR<SchemeRow[]>(CACHE_KEYS.schemes.list(), {
        fallbackData: initialSchemes,
    });
    const allSchemes = schemesQuery.data ?? [];
    const loading = schemesQuery.isLoading && !schemesQuery.data;

    // Live, case-insensitive search over name + key.
    const schemes = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return allSchemes;
        return allSchemes.filter(
            (s) => s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q),
        );
    }, [allSchemes, search]);

    const columns = useMemo(
        () =>
            createColumns<SchemeRow>([
                {
                    accessorKey: 'name',
                    header: t('colName'),
                    cell: ({ row, getValue }) => (
                        <TableTitleCell id={`scheme-name-${row.original.id}`}>
                            {getValue() as string}
                        </TableTitleCell>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    accessorKey: 'key',
                    header: t('colKey'),
                    cell: ({ getValue }) => (
                        <span className="font-mono text-xs text-content-muted">
                            {getValue() as string}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                {
                    id: 'requirements',
                    header: t('colRequirements'),
                    accessorFn: (s) => s._count?.requirements ?? 0,
                    cell: ({ getValue }) => (
                        <span className="tabular-nums text-content-muted">
                            {getValue() as number}
                        </span>
                    ),
                    meta: { disableTruncate: true, mobileCard: { slot: 'meta', label: t('colRequirements') } },
                },
            ]),
        [t],
    );

    return (
        <EntityListPage<SchemeRow>
            className="animate-fadeIn gap-section"
            header={{
                breadcrumbs: [
                    { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('breadcrumbSchemes') },
                ],
                title: t('title'),
                description: t('listDescription'),
                actions: permissions.canAuthorScheme ? (
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={() => setIsCreateOpen(true)}
                        id="new-scheme-btn"
                    >
                        {t('addSchemeButton')}
                    </Button>
                ) : null,
            }}
            filters={{
                defs: [],
                searchId: 'scheme-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: schemes,
                columns,
                loading,
                getRowId: (s) => s.id,
                mobileFallback: 'card',
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('noResultsTitle')}
                        description={t('noResultsDescription')}
                        secondaryAction={{ label: t('clearSearch'), onClick: () => clearAll() }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        primaryAction={
                            permissions.canAuthorScheme
                                ? { label: t('addScheme'), onClick: () => setIsCreateOpen(true) }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? t('schemePlural') : t('schemeSingular')),
                'data-testid': 'schemes-table',
                className: 'hover:bg-bg-muted',
            }}
        >
            {permissions.canAuthorScheme && (
                <NewSchemeModal
                    open={isCreateOpen}
                    setOpen={setIsCreateOpen}
                    tenantSlug={tenantSlug}
                    onSaved={() => {
                        void schemesQuery.mutate();
                    }}
                />
            )}
        </EntityListPage>
    );
}
