'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useCursorPagination, PullToRefresh } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useOfflineSync } from '@/lib/offline/use-offline-sync';
import { OfflineSyncBar } from '@/components/offline/OfflineSyncBar';
import { Button } from '@/components/ui/button';
import { Plus, Trash } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { DeletedJournalView } from './DeletedJournalView';
import { Fab } from '@/components/ui/fab';
import { createColumns } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildJournalFilters,
    JOURNAL_FILTER_KEYS,
    LOG_ENTRY_TYPE_LABELS,
    FIELD_OPERATION_TYPES,
    CROP_FILTER_LABELS,
} from './filter-defs';
import { JournalEntryModal, type OptimisticJournalEntry } from './JournalEntryModal';

/** List-row shape returned by GET /journal (see JournalRepository.list). */
interface JournalRow {
    id: string;
    type: string;
    title: string;
    status: string;
    occurredAt: string;
    notes?: string | null;
    /** БАБХ cert snapshot captured on completion (operator / agronomist). */
    conditionsJson?: { operatorCertNo?: string; agronomistName?: string; agronomistCertNo?: string } | null;
    locations?: Array<{ location?: { id: string; name: string } | null }>;
    _count?: { quantities?: number; files?: number };
    /** The linked spray/operation line — the dnevnik agronomic columns (#10). */
    operationParcel?: {
        doseValue?: string | number | null;
        parcel?: { name?: string | null; cropType?: string | null; areaHa?: string | number | null } | null;
        product?: { name?: string | null; activeIngredient?: string | null; quarantinePeriodDays?: number | null } | null;
        doseUnit?: { symbol?: string | null } | null;
        task?: { operationType?: string | null; applicationTechnique?: string | null } | null;
    } | null;
}

/**
 * Roadmap-6 P3 — the bounded first-page size. Server-renders this many
 * rows and each "Load more" fetches another page over the cursor path,
 * replacing the old flat take:200 nested-row cold-start payload.
 */
export const JOURNAL_PAGE_SIZE = 50;

/** Paginated shape the `/journal?limit&cursor` route returns. */
interface JournalPageResponse {
    rows: JournalRow[];
    nextCursor: string | null;
}

interface JournalClientProps {
    initialEntries: JournalRow[];
    /** Cursor for page 2 of the server-rendered first page (null if last). */
    initialNextCursor: string | null;
    initialFilters: Record<string, string>;
    tenantSlug: string;
    permissions: { canWrite: boolean; canAdmin: boolean };
    /** GRAIN module on — enables the harvest entry's "also record as yield"
     *  option. Resolved server-side in page.tsx (the module read is
     *  admin-gated, and a mechanisator authoring a harvest is not one). */
    grainEnabled?: boolean;
}

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    PLANNED: 'info',
    DONE: 'success',
};

export function JournalClient(props: JournalClientProps) {
    const filterCtx = useFilterContext([], JOURNAL_FILTER_KEYS, {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <JournalPageInner {...props} />
        </FilterProvider>
    );
}

function JournalPageInner({ initialEntries, initialNextCursor, initialFilters, tenantSlug, permissions, grainEnabled }: JournalClientProps) {
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const router = useRouter();
    const buildApiUrl = useTenantApiUrl();
    const prefetchData = usePrefetchTenant();
    const t = useTranslations('journal');
    const te = useTranslations('journalEnums');
    const tTrash = useTranslations('journal.trash');
    // B1 — in-page ADMIN Trash (no new navbar entry).
    const [showDeleted, setShowDeleted] = useState(false);
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;
    const fetchParams = useMemo(() => toApiSearchParams(state, { search }), [state, search]);
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of fetchParams) obj[k] = v;
        return obj;
    }, [fetchParams]);

    const serverHadFilters = initialFilters && Object.keys(initialFilters).length > 0;
    const filtersMatchInitial = useMemo(() => {
        if (!serverHadFilters) return !hasActive;
        const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initialFilters)]);
        for (const k of keys) {
            if ((queryKeyFilters[k] ?? '') !== (initialFilters[k] ?? '')) return false;
        }
        return true;
    }, [queryKeyFilters, initialFilters, serverHadFilters, hasActive]);

    // Roadmap-6 P3 — the first page is an SWR entry keyed by the active
    // filters (bounded to JOURNAL_PAGE_SIZE); "Load more" pages forward
    // over the cursor path via `useCursorPagination`. The old flat
    // take:200 nested-row payload is gone — cold start now downloads one
    // bounded page, and ETag/304 makes revalidation cheap on rural LTE.
    const page1Key = useMemo(() => {
        const p = new URLSearchParams(fetchParams);
        p.set('limit', String(JOURNAL_PAGE_SIZE));
        return `${CACHE_KEYS.journal.list()}?${p.toString()}`;
    }, [fetchParams]);

    const fallbackPage = useMemo<JournalPageResponse | undefined>(
        () =>
            filtersMatchInitial
                ? { rows: initialEntries, nextCursor: initialNextCursor }
                : undefined,
        [filtersMatchInitial, initialEntries, initialNextCursor],
    );

    const page1Query = useTenantSWR<JournalPageResponse>(page1Key, {
        fallbackData: fallbackPage,
    });

    const fetchUrl = useCallback(
        (cursor: string) => {
            const p = new URLSearchParams(fetchParams);
            p.set('limit', String(JOURNAL_PAGE_SIZE));
            p.set('cursor', cursor);
            return buildApiUrl(`/journal?${p.toString()}`);
        },
        [fetchParams, buildApiUrl],
    );

    const pagination = useCursorPagination<JournalRow>({
        initialRows: fallbackPage?.rows ?? page1Query.data?.rows ?? [],
        initialNextCursor: fallbackPage?.nextCursor ?? page1Query.data?.nextCursor ?? null,
        fetchUrl,
    });
    const { reload: reloadPagination } = pagination;

    // Reseed the accumulator whenever the first page's CONTENT changes —
    // a filter switch, a focus/reconnect revalidation that returns
    // different rows, or an optimistic prepend. Keyed on a content
    // signature (row ids + cursor) so an identity-only change (SWR
    // returning the same rows) never discards pages the user loaded.
    const page1 = page1Query.data;
    const page1Signature = page1
        ? `${page1.rows.map((r) => r.id).join(',')}|${page1.nextCursor ?? ''}`
        : null;
    const lastSignatureRef = useRef<string | null>(null);
    useEffect(() => {
        if (page1 == null || page1Signature == null) return;
        if (lastSignatureRef.current === page1Signature) return;
        lastSignatureRef.current = page1Signature;
        reloadPagination(page1.rows, page1.nextCursor);
    }, [page1, page1Signature, reloadPagination]);

    const entries = pagination.rows;
    const loading = page1Query.isLoading && !page1Query.data;

    // Offline-capable journal-entry create. One shared hook so a create queued
    // from the modal is reflected in this page's OfflineSyncBar pending count.
    const { online, pending, submit: offlineSubmit, flush } = useOfflineSync();
    const handleEntryCreated = (queued: boolean, optimistic: OptimisticJournalEntry) => {
        // Prepend an optimistic row so the just-logged entry shows at once.
        // Online (!queued): revalidate to swap it for the server row. Offline
        // (queued): keep it until the outbox delivers on reconnect (deduped by
        // Idempotency-Key), when SWR's reconnect revalidation replaces it. The
        // mutate changes page 1's signature, so the accumulator reseeds and the
        // optimistic row surfaces at the top immediately.
        void page1Query.mutate(
            (cur) => ({
                rows: [optimistic as JournalRow, ...(cur?.rows ?? [])],
                nextCursor: cur?.nextCursor ?? null,
            }),
            { revalidate: !queued },
        );
    };

    const liveFilters = useMemo(() => buildJournalFilters(te), [te]);

    const columns = useMemo(
        () =>
            createColumns<JournalRow>([
                // Date — the regulated ДНЕВНИК leads with when the work happened.
                {
                    id: 'occurredAt',
                    header: t('colDate'),
                    accessorFn: (e) => e.occurredAt,
                    cell: ({ getValue }) => (
                        <TimestampTooltip
                            date={getValue() as string | null | undefined}
                            className="text-xs text-content-muted"
                        />
                    ),
                    meta: { disableTruncate: true, mobileCard: { slot: 'meta', label: t('colDate') } },
                },
                // Parcel / Culture — the field + its crop. Doubles as the
                // keyboard-accessible link to the entry detail. Falls back to
                // the logged location name for free-hand entries.
                {
                    id: 'parcelCulture',
                    header: t('colParcelCulture'),
                    accessorFn: (e) =>
                        e.operationParcel?.parcel?.name ??
                        e.locations?.[0]?.location?.name ??
                        e.title,
                    cell: ({ row, getValue }) => {
                        const culture = row.original.operationParcel?.parcel?.cropType;
                        const cultureLabel = culture
                            ? culture in CROP_FILTER_LABELS
                                ? te(`crop.${culture}`)
                                : culture
                            : null;
                        return (
                            <TableTitleCell
                                href={tenantHref(`/journal/${row.original.id}`)}
                                id={`journal-link-${row.original.id}`}
                            >
                                <span>{getValue() as string}</span>
                                {cultureLabel ? (
                                    <span className="ml-1 text-xs text-content-muted">· {cultureLabel}</span>
                                ) : null}
                            </TableTitleCell>
                        );
                    },
                    meta: { mobileCard: { slot: 'title' } },
                },
                // Operation — the БАБХ operation type when present, else the
                // journal entry kind.
                {
                    id: 'operation',
                    header: t('colOperation'),
                    // The primary branch is the FieldOperationType enum
                    // (SPRAY/FERTILIZE/SEED/OTHER) — localized like the
                    // fallback rather than printed raw.
                    accessorFn: (e) => {
                        const op = e.operationParcel?.task?.operationType;
                        if (op) {
                            return op in FIELD_OPERATION_TYPES
                                ? te(`operationType.${op}`)
                                : String(op).replace(/_/g, ' ');
                        }
                        return e.type in LOG_ENTRY_TYPE_LABELS
                            ? te(`logType.${e.type}`)
                            : String(e.type).replace(/_/g, ' ');
                    },
                    cell: ({ getValue }) => (
                        <StatusBadge variant="info" size="sm">
                            {String(getValue()).replace(/_/g, ' ')}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                // Product + active ingredient.
                {
                    id: 'product',
                    header: t('colProduct'),
                    accessorFn: (e) => e.operationParcel?.product?.name ?? '',
                    cell: ({ row, getValue }) => {
                        const ai = row.original.operationParcel?.product?.activeIngredient;
                        const name = getValue() as string;
                        if (!name) return <span className="text-content-subtle">—</span>;
                        return (
                            <span className="text-sm">
                                {name}
                                {ai ? <span className="block text-xs text-content-muted">{ai}</span> : null}
                            </span>
                        );
                    },
                    meta: { mobileCard: { slot: 'meta', label: t('colProduct') } },
                },
                // Dose / rate.
                {
                    id: 'dose',
                    header: t('colDose'),
                    accessorFn: (e) => {
                        const op = e.operationParcel;
                        if (op?.doseValue == null) return '—';
                        return `${Number(op.doseValue)}${op.doseUnit?.symbol ? ` ${op.doseUnit.symbol}` : ''}`;
                    },
                    cell: ({ getValue }) => (
                        <span className="text-xs tabular-nums text-content-muted">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colDose') } },
                },
                // Treated area — Parcel.areaHa in decares (дка = ha × 10), the
                // regulated Bulgarian unit.
                {
                    id: 'areaDka',
                    header: t('colTreatedArea'),
                    accessorFn: (e) => {
                        const ha = e.operationParcel?.parcel?.areaHa;
                        if (ha == null) return '—';
                        return (Number(ha) * 10).toFixed(1);
                    },
                    cell: ({ getValue }) => (
                        <span className="text-xs tabular-nums text-content-muted">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colTreatedArea') } },
                },
                // PHI — pre-harvest interval (карантинен срок), days.
                {
                    id: 'phi',
                    header: t('colPhi'),
                    accessorFn: (e) => {
                        const d = e.operationParcel?.product?.quarantinePeriodDays;
                        return d == null ? '—' : String(d);
                    },
                    cell: ({ getValue }) => (
                        <span className="text-xs tabular-nums text-content-muted">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colPhi') } },
                },
                // Operator — the applicator / agronomist captured on completion.
                {
                    id: 'operator',
                    header: t('colOperator'),
                    accessorFn: (e) =>
                        e.conditionsJson?.agronomistName ??
                        e.conditionsJson?.operatorCertNo ??
                        '—',
                    cell: ({ getValue }) => (
                        <span className="text-xs text-content-muted">{getValue() as string}</span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colOperator') } },
                },
                // Status.
                {
                    accessorKey: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => {
                        const status = row.original.status;
                        return (
                            <StatusBadge variant={STATUS_BADGE[status] ?? 'neutral'} size="sm">
                                {status in STATUS_BADGE ? te(`status.${status}`) : status}
                            </StatusBadge>
                        );
                    },
                    meta: { mobileCard: { slot: 'status' } },
                },
                // Notes.
                {
                    id: 'notes',
                    header: t('colNotes'),
                    accessorFn: (e) => e.notes ?? '',
                    cell: ({ getValue }) => {
                        const n = getValue() as string;
                        return n ? (
                            <span className="text-xs text-content-muted">{n}</span>
                        ) : (
                            <span className="text-content-subtle">—</span>
                        );
                    },
                    meta: { mobileCard: { slot: 'meta', label: t('colNotes') } },
                },
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tenantSlug, t, te],
    );

    // Swap the whole surface into the Trash view. Placed after every hook so
    // hook order stays stable.
    if (showDeleted && permissions.canAdmin) {
        return <DeletedJournalView tenantSlug={tenantSlug} onBack={() => setShowDeleted(false)} />;
    }

    return (
        <EntityListPage<JournalRow>
            className="gap-section"
            header={{
                breadcrumbs: [
                    { label: t('dashboard'), href: tenantHref('/dashboard') },
                    { label: t('breadcrumb') },
                ],
                title: t('title'),
                description: t('description'),
                actions: (
                    <>
                        {/* Trash — ADMIN-only, matching restore/purge. */}
                        {permissions.canAdmin && (
                            <Tooltip content={tTrash('title')}>
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    onClick={() => setShowDeleted(true)}
                                    id="journal-trash-btn"
                                    aria-label={tTrash('title')}
                                >
                                    <Trash className="size-4" />
                                </Button>
                            </Tooltip>
                        )}
                        {permissions.canWrite && (
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                onClick={() => setIsCreateOpen(true)}
                                id="new-journal-btn"
                            >
                                {t('addEntry')}
                            </Button>
                        )}
                    </>
                ),
            }}
            filters={{
                defs: liveFilters,
                searchId: 'journal-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: entries,
                columns,
                loading,
                getRowId: (e) => e.id,
                // <sm: render each entry as a tappable card; taps through to
                // the journal detail via onRowClick below.
                mobileFallback: 'card',
                // An optimistic (queued-offline) row has a client temp id with
                // no server detail page yet — don't navigate until it delivers.
                onRowClick: (row) => {
                    if (row.original.id.startsWith('optimistic-')) return;
                    router.push(tenantHref(`/journal/${row.original.id}`));
                },
                onRowPrefetch: (row) => {
                    if (row.original.id.startsWith('optimistic-')) return;
                    router.prefetch(tenantHref(`/journal/${row.original.id}`)); prefetchData(CACHE_KEYS.journal.detail(row.original.id));
                },
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('filteredEmptyTitle')}
                        description={t('filteredEmptyDescription')}
                        secondaryAction={{ label: t('clearFilters'), onClick: () => filterCtx.clearAll() }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        primaryAction={
                            permissions.canWrite
                                ? { label: t('emptyAction'), onClick: () => setIsCreateOpen(true) }
                                : undefined
                        }
                    />
                ),
                resourceName: (p) => (p ? 'entries' : 'entry'),
                'data-testid': 'journal-table',
                className: 'hover:bg-bg-muted',
            }}
            tableFooter={
                pagination.hasMore ? (
                    <div className="flex flex-col items-center gap-tight pt-3">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            id="journal-load-more"
                            onClick={() => void pagination.loadMore()}
                            disabled={pagination.loading}
                        >
                            {pagination.loading ? t('loadingMore') : t('loadMore')}
                        </Button>
                        {pagination.error && (
                            <span role="alert" className="text-sm text-content-error">
                                {t('loadError')}
                            </span>
                        )}
                    </div>
                ) : null
            }
        >
            {permissions.canWrite && (
                <>
                    <JournalEntryModal
                        open={isCreateOpen}
                        setOpen={setIsCreateOpen}
                        tenantSlug={tenantSlug}
                        offlineSubmit={offlineSubmit}
                        onCreated={handleEntryCreated}
                        grainEnabled={grainEnabled}
                    />
                    {/* Surfaces a queued (offline) create + a "Sync now" when
                        back online. Hidden while online with nothing pending. */}
                    {(!online || pending > 0) && (
                        <OfflineSyncBar
                            online={online}
                            pending={pending}
                            onSyncNow={() => void flush()}
                            className="fixed inset-x-0 bottom-0 z-40 md:left-auto md:right-4 md:bottom-4 md:max-w-sm"
                        />
                    )}
                    <PullToRefresh onRefresh={() => page1Query.mutate()} />
                    <ScrollToTop />
                    <Fab
                        onClick={() => setIsCreateOpen(true)}
                        label={t('fabLabel')}
                        icon={<Plus aria-hidden className="h-6 w-6" />}
                    />
                </>
            )}
        </EntityListPage>
    );
}
