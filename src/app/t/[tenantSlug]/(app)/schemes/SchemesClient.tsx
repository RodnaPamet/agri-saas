'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { StatusBadge } from '@/components/ui/status-badge';
import { NewSchemeModal } from './NewSchemeModal';

/** List-row shape returned by GET /schemes (a global AG_SCHEME framework). */
export interface SchemeRow {
    id: string;
    key: string;
    name: string;
    description: string | null;
    /** Demo/partial catalogue rather than the full standard. */
    isDemo?: boolean;
    /** e.g. "7 of ~200+ control points". */
    coverageNote?: string | null;
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
    const router = useRouter();
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    const { search, hasActive, clearAll } = useFilters();

    const schemesQuery = useTenantSWR<SchemeRow[]>(CACHE_KEYS.schemes.list(), {
        fallbackData: initialSchemes,
    });
    const allSchemes = schemesQuery.data ?? [];
    // `fallbackData` is always supplied by the server component, so
    // `schemesQuery.data` is never undefined and the old
    // `isLoading && !data` was permanently false — the table could never
    // show a loading state. With server-rendered initial data there is
    // nothing to wait for on first paint; a REVALIDATION is the only real
    // loading, and only when it has nothing to show yet.
    const loading = schemesQuery.isValidating && allSchemes.length === 0;
    // A failed refetch must not fall through to the empty state — that reads
    // as "this platform has no certification schemes", which is a very
    // different claim from "the request failed".
    const error = schemesQuery.error && allSchemes.length === 0
        ? t('loadFailed')
        : undefined;

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
                    id: 'scope',
                    header: t('colScope'),
                    // The disclosure. The catalogues are 3-8% stubs and the
                    // YAMLs say so, but the list fetched `description` and
                    // never rendered it — the only in-UI signal was a
                    // parenthetical in the name. A farmer who maps their
                    // practices to 7 control points and sees "GlobalG.A.P."
                    // will believe they are covered.
                    cell: ({ row }) =>
                        row.original.isDemo ? (
                            <div className="flex flex-col gap-0.5">
                                <StatusBadge
                                    variant="warning"
                                    id={`scheme-demo-${row.original.id}`}
                                >
                                    {t('demoBadge')}
                                </StatusBadge>
                                {row.original.coverageNote && (
                                    <span className="text-xs text-content-subtle">
                                        {row.original.coverageNote}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-content-subtle">—</span>
                        ),
                    meta: {
                        disableTruncate: true,
                        mobileCard: { slot: 'status', label: t('colScope') },
                    },
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
                error,
                getRowId: (s) => s.id,
                // The row style has always promised a click
                // (`hover:bg-bg-muted`) and there was nothing to click
                // through to — no onRowClick, no [schemeKey] route. Both now
                // exist.
                onRowClick: (row) => router.push(tenantHref(`/schemes/${row.original.key}`)),
                // Load-bearing. DataTable defaults selection ON, and with
                // selection on a SINGLE click toggles it while the row action
                // moves to double-click. This list has no batch actions, so
                // selection would cost a click and give nothing — and the row
                // renders `cursor-pointer`, promising that one click opens the
                // scheme. It now does.
                selectionEnabled: false,
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
