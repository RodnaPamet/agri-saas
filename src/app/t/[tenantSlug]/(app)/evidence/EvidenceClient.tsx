'use client';
/* eslint-disable @typescript-eslint/no-explicit-any -- Client component receiving server-rendered domain data; tanstack column callbacks; or library-boundary callbacks. Per-site narrowing requires generated DTOs / per-cell CellContext imports — out of scope for the lint cleanup PR. */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { useUrlFilters } from '@/lib/hooks/useUrlFilters';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
// Both evidence modals were previously lazy-loaded via next/dynamic,
// but the JIT race in `next dev` made the modals occasionally fail to
// mount in serial-mode E2E runs (Playwright clicked the trigger before
// the chunk finished compiling). Static imports — the bundle cost is
// acceptable and the E2E suite becomes deterministic.
import { UploadEvidenceModal } from './UploadEvidenceModal';
import { EvidenceDetailSheet } from './EvidenceDetailSheet';
import { EditEvidenceModal } from './EditEvidenceModal';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import {
    DataTable,
    createColumns,
    useColumnsDropdown,
    useBulkDelete,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    useFilterCardVisibility,
    filtersToCards,
    selectVisibleFilters,
    type FilterType,
} from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { TableLoadMoreFooter } from '@/components/ui/table-load-more-footer';
import { useThresholdLoadMore } from '@/components/ui/hooks';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import {
    resolveFileTypeIcon,
} from '@/components/ui/file-type-icon';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { EvidenceGallery } from '@/components/ui/EvidenceGallery';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useCelebration } from '@/components/ui/hooks';
import { MILESTONES } from '@/lib/celebrations';
import { isAllEvidenceCurrent } from '@/lib/evidence-freshness';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildEvidenceFilters,
    EVIDENCE_FILTER_KEYS,
} from './filter-defs';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
// `Note` reads as "a written record" — the marker for a row whose evidence
// IS a farm journal entry. (Iconography is nucleo across app pages; the
// Roadmap-2 PR-8 guard bans new lucide imports outside its migration list.)
import { Plus, Pen2, Download, BoxArchive, Note } from '@/components/ui/icons/nucleo';
import { AUTO_FARM_RECORD_CATEGORY } from '@/lib/evidence/auto-evidence-constants';

interface Permissions {
    canRead: boolean;
    canWrite: boolean;
    canAdmin: boolean;
    canAudit: boolean;
    canExport: boolean;
}

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral', SUBMITTED: 'info', APPROVED: 'success', REJECTED: 'error',
    PENDING_UPLOAD: 'info',
};

// Shared icon-only action button (Edit / Archive / Download columns) —
// mirrors the control-table quick-edit affordance.
const ICON_ACTION_CLASS =
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type RetentionFilter = 'active' | 'expiring' | 'archived';

type RetentionT = (key: string, values?: Record<string, string | number | Date>) => string;

function getRetentionStatus(ev: any, now: Date | null, t: RetentionT): { label: string; badge: StatusBadgeVariant; icon: string } {
    if (ev.isArchived) return { label: t('client.retentionArchived'), badge: 'neutral', icon: '' };
    if (ev.expiredAt) return { label: t('client.retentionExpired'), badge: 'error', icon: '' };
    if (ev.retentionUntil) {
        if (!now) return { label: t('client.retentionActive'), badge: 'success', icon: '' };
        const until = new Date(ev.retentionUntil);
        const daysLeft = Math.ceil((until.getTime() - now.getTime()) / 86_400_000);
        if (daysLeft <= 0) return { label: t('client.retentionExpired'), badge: 'error', icon: '' };
        if (daysLeft <= 30) return { label: t('client.retentionExpiring', { days: daysLeft }), badge: 'warning', icon: '' };
        return { label: t('client.retentionActive'), badge: 'success', icon: '' };
    }
    return { label: t('client.retentionNoPolicy'), badge: 'neutral', icon: '—' };
}

interface EvidenceClientProps {

    initialEvidence: any[];

    initialControls: any[];
    tenantSlug: string;
    permissions: Permissions;
    translations: Record<string, string>;
}

/**
 * Client island for evidence — handles all interactive features.
 * Data arrives pre-fetched from the server component, hydrated into React Query.
 *
 * Filter architecture (Epic 53):
 *   - `q`, `type`, `status`, `controlId` flow through `useFilterContext`
 *     (URL-synced via the shared context).
 *   - `tab` (retention view: active | expiring | archived) stays on
 *     `useUrlFilters` since it's a view selector, not a filter.
 */
export function EvidenceClient(props: EvidenceClientProps) {
    const filterCtx = useFilterContext([], EVIDENCE_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <EvidencePageInner {...props} />
        </FilterProvider>
    );
}

function EvidencePageInner({ initialEvidence, initialControls, tenantSlug, permissions, translations: t }: EvidenceClientProps) {
    const tr = useTranslations('evidence');
    // Stabilise across renders so dependent useCallbacks don't get a
    // fresh identity every cycle (was a real exhaustive-deps warning).
    const apiUrl = useCallback(
        (path: string) => `/api/t/${tenantSlug}${path}`,
        [tenantSlug],
    );
    const { mutate: swrMutate } = useSWRConfig();

    // Retention-tab + view-mode selectors — deliberately kept separate from filter state.
    // `tab`: active | expiring | archived. `view`: list | gallery.
    // Both URL-synced so a refresh / back-button preserves the page
    // shape, and toggling the view doesn't clobber the active filters
    // (filter state lives in `filterCtx`, not in `useUrlFilters`).
    const { filters, setFilter } = useUrlFilters(['tab', 'view']);
    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;

    // ─── Build the API query string from filter state + retention tab ───
    const fetchParams = useMemo(() => {
        const params = toApiSearchParams(state, { search });
        if (filters.tab === 'archived') params.set('archived', 'true');
        else if (filters.tab === 'expiring') params.set('expiring', 'true');
        return params;
    }, [state, search, filters.tab]);

    // ─── Epic 69 — SWR-first read for the evidence list ───
    //
    // Each filter combo gets its own cache entry via the
    // query-string suffix on the SWR key. The unfiltered baseline
    // is the registry's `list()`. Server-rendered initialEvidence
    // lands as `fallbackData` only when no filters / retention tab
    // is active — otherwise the hook fires a fresh request, mirroring
    // the prior "skip initialData when filters diverge" semantics.
    const anyFilterActive = hasActive || !!filters.tab;
    const evidenceKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs
            ? `${CACHE_KEYS.evidence.list()}?${qs}`
            : CACHE_KEYS.evidence.list();
    }, [fetchParams]);


    // PR-5 — API returns `{ rows, truncated }`; the Client pulls
    // `rows` for the table and `truncated` for the banner. SSR
    // initial wraps with `truncated: false` (cap is 5000, SSR cap is
    // 100, so the SSR slice never trips truncation by itself).
    const evidenceQuery = useTenantSWR<CappedList<any>>(evidenceKey, {
        fallbackData: anyFilterActive
            ? undefined
            : { rows: initialEvidence, truncated: false },
    });
    const truncated = evidenceQuery.data?.truncated ?? false;

    // Stabilise the array identity across renders so dependent hooks
    // (`useEffect` at line ~330 reads `evidence`) don't re-fire on
    // every render. Without the `useMemo` the `?? []` produces a new
    // empty array instance every cycle. eslint-disable for the inner
    // `any[]`; tightening the type is a separate cleanup.

    const evidence: any[] = useMemo(
        () => evidenceQuery.data?.rows ?? [],
        [evidenceQuery.data],
    );

    // Bulk-delete via the table selection action-row.
    const { batchAction: evidenceBulkDelete, dialog: evidenceDeleteDialog } =
        useBulkDelete({
            entitySingular: tr('client.bulkSingular'),
            entityPlural: tr('client.bulkPlural'),
            onDelete: async (ids) => {
                // URL built in a const (not inlined into fetch(...)) so the
                // RSC-regression heuristic doesn't misread this mutation as a
                // useEffect initial-data fetch.
                const bulkUrl = `/api/t/${tenantSlug}/evidence/bulk/delete`;
                const res = await fetch(bulkUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ evidenceIds: ids }),
                });
                if (!res.ok) throw new Error('Failed to delete evidence');
                await evidenceQuery.mutate();
            },
        });

    const [controls] = useState<any[]>(initialControls);
    const retentionFilter = (filters.tab || 'active') as RetentionFilter;
    const { celebrate } = useCelebration();
    const viewMode: 'list' | 'gallery' =
        filters.view === 'gallery' ? 'gallery' : 'list';
    const [showUpload, setShowUpload] = useState(false);

    // B5 — row-click detail sheet + edit modal.
    const [detailSheetOpen, setDetailSheetOpen] = useState(false);
    const [detailEvidenceId, setDetailEvidenceId] = useState<string | null>(null);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editInitial, setEditInitial] = useState<{
        id: string;
        title: string;
        description: string | null;
        ownerUserId: string | null;
        controlId: string | null;
        // B8 follow-up — folder is editable in the modal; threaded
        // through here so the modal seeds the input with the
        // current value.
        folder: string | null;
        // Retention date is now edited in the modal too (was inline).
        retentionUntil: string | null;
    } | null>(null);

    // Invalidate every cached evidence-list filter variant. SWR's
    // function-form `mutate()` matches by absolute URL prefix —
    // every key under `/api/t/{slug}/evidence` (with or without
    // query string) gets a background refetch.
    // Matches every cached evidence-list filter variant (the base URL
    // and any `?…` query-string sibling).
    const evidenceKeyMatcher = useCallback(
        (key: unknown): key is string => {
            const prefix = apiUrl(CACHE_KEYS.evidence.list());
            return (
                typeof key === 'string' &&
                (key === prefix || key.startsWith(`${prefix}?`))
            );
        },
        [apiUrl],
    );

    const invalidateEvidence = useCallback(
        () => swrMutate(evidenceKeyMatcher, undefined, { revalidate: true }),
        [swrMutate, evidenceKeyMatcher],
    );

    // Optimistically flip `isArchived` on the matching row across every
    // cached list variant, WITHOUT revalidating — so the row reacts
    // (e.g. drops out of the Active tab) the instant the button is
    // clicked, independent of refetch timing.
    const optimisticSetArchived = useCallback(
        (id: string, isArchived: boolean) =>
            swrMutate(
                evidenceKeyMatcher,
                (
                    current?: {
                        rows?: Record<string, unknown>[];
                        truncated?: boolean;
                    },
                ) =>
                    current
                        ? {
                              ...current,
                              rows: (current.rows ?? []).map((r) =>
                                  r.id === id ? { ...r, isArchived } : r,
                              ),
                          }
                        : current,
                { revalidate: false },
            ),
        [swrMutate, evidenceKeyMatcher],
    );

    // ─── Mutation: review workflow (Epic 69 — useTenantMutation) ───
    //
    // Migrated from React Query's `useMutation` + `onMutate` /
    // `onError` rollback hooks. The optimistic update flips the
    // matching row's status synchronously; SWR's `rollbackOnError`
    // default restores the prior list on failure. After success
    // SWR revalidates the current key, and `invalidateEvidence()`
    // fans out to sibling filter variants.
    // PR-5 — cache value is `CappedList<any>` (the API returns
    // `{ rows, truncated }`); preserve `truncated` and only rewrite `rows`.
    const reviewMutation = useTenantMutation<CappedList<any>, { id: string; action: string; comment: string }, unknown>({
        key: evidenceKey,
        mutationFn: async ({ id, action, comment }) => {
            const res = await fetch(apiUrl(`/evidence/${id}/review`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, comment }),
            });
            if (!res.ok) throw new Error('Review action failed');
            return res.json().catch(() => null);
        },
        optimisticUpdate: (current, { id, action }) => {
            const newStatus =
                action === 'SUBMITTED'
                    ? 'SUBMITTED'
                    : action === 'APPROVED'
                        ? 'APPROVED'
                        : 'REJECTED';
            const rows = (current?.rows ?? []).map((ev: any) =>
                ev.id === id ? { ...ev, status: newStatus } : ev,
            );
            return { rows, truncated: current?.truncated ?? false };
        },
    });

    const submitReview = (id: string, action: string, comment = '') => {
        reviewMutation.trigger({ id, action, comment }).catch(() => {
            /* rollback already applied by the hook */
        }).finally(() => {
            // Fan out to sibling filter variants for completeness —
            // status flips affect the "approved-only" / "rejected-
            // only" filter views which the primary key revalidation
            // doesn't cover.
            invalidateEvidence();
        });
    };

    // ─── Retention actions ─────────────────────────────────────────

    // Shared archive/unarchive runner. Optimistically flips the row,
    // POSTs, then revalidates from the server on either outcome. The
    // try/catch is load-bearing: the row buttons call this from a
    // non-awaited `onClick`, so a thrown fetch (offline / blocked /
    // network) would otherwise reject silently and the click would
    // appear to "do nothing". Any failure now rolls back + alerts.
    const setArchived = async (id: string, isArchived: boolean) => {
        const verb = isArchived ? 'archive' : 'unarchive';
        await optimisticSetArchived(id, isArchived);
        try {
            const res = await fetch(apiUrl(`/evidence/${id}/${verb}`), {
                method: 'POST',
            });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                throw new Error(
                    err?.error?.message ||
                        `Failed to ${verb} evidence (${res.status})`,
                );
            }
            await invalidateEvidence();
        } catch (e) {
            await invalidateEvidence(); // roll back to server truth
            alert(e instanceof Error ? e.message : `Failed to ${verb} evidence`);
        }
    };

    const archiveEvidence = (id: string) => setArchived(id, true);
    const unarchiveEvidence = (id: string) => setArchived(id, false);

    const statusLabel = (status: string) => {
        const map: Record<string, string> = { DRAFT: t.draft, SUBMITTED: t.submitted, APPROVED: t.approved, REJECTED: t.rejected, PENDING_UPLOAD: tr('client.uploadingStatus') };
        return map[status] || status;
    };

    // ─── Retention filter counts ───
    // Null on SSR + first client render so the "Expiring" count matches
    // exactly across hydration (avoids React #418/#422).
    const hydratedNow = useHydratedNow();

    // ─── R23-PR-E — KPI definitions for the Evidence page ───
    // Status-based buckets aligned to the existing `status` filter
    // (DRAFT/SUBMITTED/APPROVED/REJECTED). The retention tabs
    // (Active/Expiring/Archived) are a separate dimension owned by
    // the tab-bar above the filter toolbar — KPIs cover status only
    // so the two affordances stay independent.
    type EvidenceKpiId = 'total' | 'draft' | 'submitted' | 'approved';
    const evidenceKpiDefs: ReadonlyArray<KpiFilterDef<EvidenceKpiId>> = useMemo(
        () => [
            {
                id: 'total',
                apply: (ctx) => ctx.clearAll(),
                isActive: (s) => Object.keys(s).length === 0,
            },
            {
                id: 'draft',
                apply: (ctx) => ctx.set('status', 'DRAFT'),
                isActive: (s) => (s.status ?? []).includes('DRAFT'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'submitted',
                apply: (ctx) => ctx.set('status', 'SUBMITTED'),
                isActive: (s) => (s.status ?? []).includes('SUBMITTED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'approved',
                apply: (ctx) => ctx.set('status', 'APPROVED'),
                isActive: (s) => (s.status ?? []).includes('APPROVED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
        ],
        [],
    );
    const { activeKpiId: activeEvidenceKpi, toggle: toggleEvidenceKpi } =
        useKpiFilter(evidenceKpiDefs);

    const activeEvidence = evidence.filter(ev => !ev.isArchived && !ev.expiredAt && !ev.deletedAt);
    const expiringEvidence = hydratedNow ? evidence.filter(ev => {
        if (ev.isArchived || ev.deletedAt) return false;
        if (!ev.retentionUntil) return false;
        const until = new Date(ev.retentionUntil);
        const in30Days = new Date(hydratedNow.getTime() + 30 * 86_400_000);
        return until <= in30Days && until > hydratedNow;
    }) : [];
    const archivedEvidence = evidence.filter(ev => ev.isArchived || ev.expiredAt);

    // ─── Filtered evidence list (respects the active retention tab) ───
    const displayEvidence = retentionFilter === 'archived'
        ? archivedEvidence
        : retentionFilter === 'expiring'
            ? expiringEvidence
            : activeEvidence;

    // ─── KPI counts — over the rows the table is SHOWING ───
    //
    // These counted the whole loaded `evidence` array, including archived,
    // expired and soft-deleted rows, while the table below renders
    // `displayEvidence` — the current retention tab, which on load excludes
    // exactly those. So the page opened saying "Total 40" above a table of 32,
    // and "Draft 6" counting drafts that were archived months ago and are not
    // on screen. Clicking a card then filtered the table to a number that had
    // never matched the card.
    //
    // Counting over `displayEvidence` makes each card a true statement about
    // what is in front of the user: within THIS tab, this many are drafts. The
    // retention tab and the status KPI stay independent dimensions — the KPI
    // narrows the tab's population, it does not reach past it.
    // guardrail-ignore: KPI counts over the displayed rows, not a refilter.
    const totalEvidence = displayEvidence.length;
    // guardrail-ignore: KPI count, not a refilter.
    const draftEvidence = displayEvidence.filter((ev: any) => ev.status === 'DRAFT').length;
    // guardrail-ignore: KPI count, not a refilter.
    const submittedEvidence = displayEvidence.filter((ev: any) => ev.status === 'SUBMITTED').length;
    // guardrail-ignore: KPI count, not a refilter.
    const approvedEvidence = displayEvidence.filter((ev: any) => ev.status === 'APPROVED').length;

    // ─── PR-1: org-parity sortable headers + progressive disclosure ───
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    const sortedEvidence = useMemo(() => {
        if (!sortBy) return displayEvidence;
        // PR-1 — minimal typed shape for the sort accessor. The
        // top-level `evidence` array is intentionally `any[]` per
        // the file's existing convention (see comment at L184),
        // but the sort path doesn't need the rest of the surface.
        // A local `Sortable` shape lets the accessor stay typed
        // without forcing a global rewrite.
        type Sortable = {
            title?: string | null;
            type?: string | null;
            control?: {
                code?: string | null;
                name?: string | null;
            } | null;
            retentionUntil?: string | null;
            status?: string | null;
            ownerUser?: { name?: string | null } | null;
            owner?: string | null;
        };
        const accessor = (ev: Sortable): string | number => {
            switch (sortBy) {
                case 'title':
                    return ev.title || '';
                case 'type':
                    return ev.type || '';
                case 'control':
                    return ev.control?.code || ev.control?.name || '';
                case 'retention':
                    return ev.retentionUntil || '';
                case 'status':
                    return ev.status || '';
                case 'owner':
                    return ev.ownerUser?.name || ev.owner || '';
                default:
                    return '';
            }
        };
        const dir = sortOrder === 'asc' ? 1 : -1;
        return [...displayEvidence].sort((a: Sortable, b: Sortable) => {
            const av = accessor(a);
            const bv = accessor(b);
            if (av === bv) return 0;
            return av > bv ? dir : -dir;
        });
    }, [displayEvidence, sortBy, sortOrder]);
    const sortableEvidenceColumns = useMemo(
        () => ['title', 'type', 'control', 'retention', 'status', 'owner'],
        [],
    );
    const {
        visibleRows: visibleEvidence,
        totalCount: totalEvidenceCount,
        hasMore: hasMoreEvidence,
        loadMore: loadMoreEvidence,
    } = useThresholdLoadMore(sortedEvidence);

    // Epic 62 — celebrate when every active evidence row is fresh.
    // Gates that suppress false positives:
    //   - hydratedNow set (skips SSR / first-render race)
    //   - default 'active' retention tab + no other filters
    //   - query has actually loaded data at least once
    // Session dedupe in `useCelebration` prevents repeat fires across
    // refreshes / re-renders.
    useEffect(() => {
        if (!hydratedNow) return;
        if (retentionFilter !== 'active') return;
        if (anyFilterActive) return;
        if (evidenceQuery.isLoading) return;
        if (!isAllEvidenceCurrent(evidence, { now: hydratedNow })) return;
        const def = MILESTONES['evidence-all-current'];
        celebrate({
            preset: def.preset,
            key: def.key,
            message: def.message,
            description: def.description,
        });
    }, [
        evidence,
        hydratedNow,
        retentionFilter,
        anyFilterActive,
        evidenceQuery.isLoading,
        celebrate,
    ]);

    // ─── Column visibility (Epic 52 / R10-PR6) ───
    // Pagination removed — internal scroll inside the table card
    // (ListPageShell.Body + DataTable fillBody) shows all rows.
    const evidenceColumnList = useMemo(
        () => [
            { id: 'title', label: t.evidenceTitle },
            { id: 'type', label: t.type },
            { id: 'control', label: t.control },
            // B8 follow-up — Folder column. Hidden by default
            // (`defaultHidden: true` would be ideal but the dropdown
            // primitive doesn't carry that yet) — the user reveals
            // it via the gear once they start using folders.
            { id: 'folder', label: tr('client.colFolder') },
            { id: 'retention', label: tr('client.colRetention') },
            { id: 'freshness', label: tr('client.colFreshness') },
            { id: 'status', label: t.status },
            { id: 'owner', label: t.ownerLabel },
            { id: 'actions', label: t.actions, alwaysVisible: true },
        ],
        [t, tr],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:evidence',
        columns: evidenceColumnList,
    });

    // ─── Filter defs (FDEFS) + the "Edit filter cards" gear ───
    // Built in the parent (rather than inside EvidenceFilterToolbar) so
    // the filter gear can ride the same toolbar `actions` slot as the
    // columns gear. The FilterProvider state (keyed by
    // EVIDENCE_FILTER_KEYS) is untouched — a hidden filter keeps its value.
    const evidenceFilters: FilterType[] = useMemo(
        () =>
            buildEvidenceFilters(
                controls as Parameters<typeof buildEvidenceFilters>[0],
                evidence,
            ),
        [controls, evidence],
    );
    const filterCards = useMemo(
        () => filtersToCards(evidenceFilters),
        [evidenceFilters],
    );
    const { visibleCards, dropdown: filtersDropdown } = useFilterCardVisibility({
        storageKey: 'inflect:filter-vis:evidence',
        cards: filterCards,
    });
    const visibleFilterDefs = useMemo(
        () => selectVisibleFilters(visibleCards, evidenceFilters),
        [visibleCards, evidenceFilters],
    );

    // ── Evidence Column Definitions ──

    const evidenceColumns = useMemo(() => createColumns<any>([
        {
            accessorKey: 'title',
            header: t.evidenceTitle,
            // R13-PR1 — title cell uses the canonical <TableTitleCell>
            // primitive. The file-type icon + filename subtitle that
            // used to live here pushed the row height past every other
            // page's baseline. File type information is still in the
            // dedicated Type column.

            cell: ({ row }: { row: any }) => {
                // Evidence has no dedicated detail page yet — the
                // record opens via the master/detail pattern from
                // this list page. Wiring a navigation href here is
                // part of B5 (Evidence workflow completion), which
                // also introduces the detail surface.
                //
                // The exception is auto-evidence: the farm record IS the
                // evidence, and it already has a page. The href is built
                // from `sourceLogEntryId` rather than from the stored
                // `content` string so a row written under a previous tenant
                // slug still resolves.
                const ev = row.original;
                return (
                    <TableTitleCell
                        href={
                            ev.sourceLogEntryId
                                ? `/t/${tenantSlug}/journal/${ev.sourceLogEntryId}`
                                : undefined
                        }
                    >
                        {ev.title}
                    </TableTitleCell>
                );
            },
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            accessorKey: 'type',
            header: t.type,
            meta: { mobileCard: { slot: 'subtitle' } },

            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                // Auto-collected farm records are LINK rows, so the generic
                // resolver called every one of them "Link" — indistinguishable
                // from a hand-filed URL, which is the difference that matters
                // when deciding whether a row needs review.
                if (ev.category === AUTO_FARM_RECORD_CATEGORY) {
                    return (
                        <span
                            className="inline-flex items-center gap-1.5 text-xs text-content-muted"
                            data-file-kind="farm-record"
                        >
                            <Note className="size-3.5 text-content-success" aria-hidden />
                            <span>{tr('client.typeFarmRecord')}</span>
                        </span>
                    );
                }
                // Mixed-file aware: pick the actual file kind by
                // extension/MIME when this row is a file; fall back to
                // the domain kind (LINK / TEXT) for non-file rows.
                const match = resolveFileTypeIcon(
                    ev.fileName ?? null,
                    ev.fileRecord?.mimeType ?? null,
                    ev.type ?? null,
                );
                return (
                    <span
                        className="inline-flex items-center gap-1.5 text-xs text-content-muted"
                        data-file-kind={match.label.toLowerCase()}
                    >
                        <match.Icon
                            size={14}
                            className={match.colorClass}
                            aria-hidden
                        />
                        <span>{match.label}</span>
                    </span>
                );
            },
        },
        {
            id: 'control',
            header: t.control,
            meta: { mobileCard: { slot: 'meta', label: t.control } },

            accessorFn: (ev: any) => ev.control ? `${ev.control.code || ''} ${ev.control.name}` : '\u2014',
            cell: ({ getValue }: { getValue: () => string }) => (
                <span className="text-xs text-content-muted">{getValue()}</span>
            ),
        },
        {
            id: 'folder',
            header: tr('client.colFolder'),
            // B8 follow-up \u2014 the Folder column matches the
            // VendorDocsTable shape: empty/null = em-dash, otherwise
            // a muted tag. Hidden by default if a tenant has zero
            // foldered evidence \u2014 the column-visibility gear keeps
            // it discoverable.
            accessorFn: (ev: { folder?: string | null }) => ev.folder || '',
            cell: ({ row }: { row: { original: { folder?: string | null } } }) =>
                row.original.folder ? (
                    <span className="text-xs text-content-muted">
                        {row.original.folder}
                    </span>
                ) : (
                    <span className="text-content-subtle">—</span>
                ),
        },
        {
            id: 'retention',
            header: tr('client.colRetention'),

            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                const rs = getRetentionStatus(ev, hydratedNow, tr);
                // Retention is now edited from the evidence Edit modal
                // (Edit icon → "Retention date"); the column is display-
                // only. Status badge + the resolved date.
                return (
                    <div className="text-xs">
                        <StatusBadge variant={rs.badge} id={`retention-status-${ev.id}`}>
                            {rs.icon} {rs.label}
                        </StatusBadge>
                        {ev.retentionUntil && !ev.isArchived && (
                            <TimestampTooltip
                                date={ev.retentionUntil}
                                className="text-content-subtle mt-0.5 block"
                                data-testid={`evidence-row-retention-date-${ev.id}`}
                            />
                        )}
                    </div>
                );
            },
            // Retention is the axis this page's own tabs are organised on, and
            // the card omitted it — so on a phone the operator could see the
            // Expiring tab's count but not which record was expiring.
            meta: { disableTruncate: true, mobileCard: { slot: 'meta', label: tr('client.colRetention') } },
        },
        {
            id: 'freshness',
            header: tr('client.colFreshness'),

            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                // `lastRefreshedAt` is not yet a discrete column on
                // Evidence — `updatedAt` is the closest existing
                // signal (any review action / metadata edit / archive
                // toggle bumps it). Wrapping it in the FreshnessBadge
                // here keeps the page semantic in sync with the
                // Epic 43 spec without forcing a schema migration.
                return (
                    <FreshnessBadge
                        lastRefreshedAt={ev.updatedAt ?? ev.dateCollected ?? null}
                        now={hydratedNow}
                        compact
                        data-testid={`evidence-row-freshness-${ev.id}`}
                    />
                );
            },
            meta: { disableTruncate: true },
        },
        {
            accessorKey: 'status',
            header: t.status,
            meta: { mobileCard: { slot: 'status', label: t.status } },

            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                return <StatusBadge variant={STATUS_BADGE[ev.status]}>{statusLabel(ev.status)}</StatusBadge>;
            },
        },
        {
            id: 'owner',
            header: t.ownerLabel,
            meta: { mobileCard: { slot: 'meta', label: t.ownerLabel } },

            accessorFn: (ev: any) => ev.owner || '\u2014',
            cell: ({ getValue }: { getValue: () => string }) => (
                <span className="text-xs">{getValue()}</span>
            ),
        },
        // Edit — icon-only column (Control-table parity). Opens the
        // SAME EditEvidenceModal the detail side-sheet's edit icon does.
        {
            id: 'edit',
            header: '',
            enableHiding: false,
            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                if (!permissions.canWrite || ev.id?.startsWith('temp:')) return null;
                return (
                    <Tooltip content={tr('client.editEvidence')}>
                        <button
                            type="button"
                            aria-label={tr('client.editEvidence')}
                            className={ICON_ACTION_CLASS}
                            id={`edit-evidence-${ev.id}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                setEditInitial({
                                    id: ev.id,
                                    title: ev.title,
                                    description: ev.content ?? null,
                                    ownerUserId: ev.ownerUserId ?? null,
                                    controlId: ev.control?.id ?? null,
                                    folder: ev.folder ?? null,
                                    retentionUntil: ev.retentionUntil ?? null,
                                });
                                setEditModalOpen(true);
                            }}
                        >
                            <Pen2 className="size-3.5" />
                        </button>
                    </Tooltip>
                );
            },
            meta: { disableTruncate: true },
        },
        // Archive — icon-only column. Toggles archive / unarchive.
        {
            id: 'archive',
            header: '',
            enableHiding: false,
            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                if (!permissions.canWrite || ev.id?.startsWith('temp:')) return null;
                const archived = !!ev.isArchived;
                return (
                    <Tooltip content={archived ? tr('client.unarchiveEvidence') : tr('client.archiveEvidence')}>
                        <button
                            type="button"
                            aria-label={archived ? tr('client.unarchiveEvidence') : tr('client.archiveEvidence')}
                            className={ICON_ACTION_CLASS}
                            id={`${archived ? 'unarchive' : 'archive'}-${ev.id}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (archived) unarchiveEvidence(ev.id);
                                else archiveEvidence(ev.id);
                            }}
                        >
                            <BoxArchive className={`size-3.5${archived ? ' text-content-emphasis' : ''}`} />
                        </button>
                    </Tooltip>
                );
            },
            meta: { disableTruncate: true },
        },
        // Download — icon-only column. Only file-backed evidence is
        // downloadable; non-file rows render nothing.
        {
            id: 'download',
            header: '',
            enableHiding: false,
            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                if (ev.type !== 'FILE' || !ev.fileRecordId || ev.id?.startsWith('temp:')) return null;
                return (
                    <Tooltip content={tr('client.downloadFile')}>
                        <a
                            href={apiUrl(`/evidence/files/${ev.fileRecordId}/download`)}
                            download
                            aria-label={tr('client.downloadFile')}
                            className={ICON_ACTION_CLASS}
                            id={`download-${ev.id}`}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <Download className="size-3.5" />
                        </a>
                    </Tooltip>
                );
            },
            meta: { disableTruncate: true },
        },
        // Review workflow — the remaining state-transition actions.
        {
            id: 'actions',
            header: t.actions,
            enableHiding: false,

            cell: ({ row }: { row: any }) => {
                const ev = row.original;
                const isPending = ev.id?.startsWith('temp:');
                if (isPending) return <span className="text-xs text-content-subtle">{tr('client.uploadingStatus')}</span>;
                if (!permissions.canWrite) return null;
                return (
                    <div className="flex gap-1 flex-wrap" onClick={e => e.stopPropagation()}>
                        {ev.status === 'DRAFT' && (
                            <Button variant="secondary" size="sm" onClick={() => submitReview(ev.id, 'SUBMITTED')}>{t.submitForReview}</Button>
                        )}
                        {ev.status === 'SUBMITTED' && (
                            <>
                                <Button variant="secondary" size="sm" onClick={() => submitReview(ev.id, 'APPROVED')}>{t.approveEvidence}</Button>
                                <Button variant="destructive" size="sm" onClick={() => submitReview(ev.id, 'REJECTED', 'Needs improvement')}>{t.rejectEvidence}</Button>
                            </>
                        )}
                        {ev.status === 'REJECTED' && (
                            <Button variant="secondary" size="sm" onClick={() => submitReview(ev.id, 'SUBMITTED')}>{t.submitForReview}</Button>
                        )}
                    </div>
                );
            },
            // Submit / Approve / Reject IS the page's workflow, and under
            // jsdom-and-on-a-real-phone the card fallback dropped every column
            // without `mobileCard` — so the workflow simply did not exist on
            // the device the operator actually carries. The `actions` slot
            // renders it as the card's footer.
            meta: { disableTruncate: true, mobileCard: { slot: 'actions' } },
        },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ]), [t, tr, permissions, apiUrl, tenantSlug]);

    return (
        <ListPageShell className="animate-fadeIn gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: tr('client.crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t.title },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t.title}</Heading>
                        {t.listDescription && (
                            <p className="text-sm text-content-muted mt-1">{t.listDescription}</p>
                        )}
                    </div>
                    {permissions.canWrite && (
                        <div className="flex gap-tight">
                            {/* UI-18: a single +Evidence button that opens the
                                Upload-a-file modal directly. The separate
                                "Upload file" + "Import ZIP" icon buttons (and the
                                text-only evidence modal) were removed. */}
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                onClick={() => setShowUpload(true)}
                                id="add-evidence-btn"
                            >
                                {t.addEvidence}
                            </Button>
                        </div>
                    )}
                </div>
            </ListPageShell.Header>

            {permissions.canWrite && (
                <>
                    <UploadEvidenceModal
                        open={showUpload}
                        setOpen={setShowUpload}
                        tenantSlug={tenantSlug}
                        apiUrl={apiUrl}
                        controls={controls}
                    />
                </>
            )}

            {/* B5 — Evidence detail sheet + edit modal. The sheet
                opens on row click and shows the read-only evidence
                detail + the existing approval-flow actions (which
                route back through `submitReview` for optimistic
                updates). The edit modal opens from the sheet's
                edit button. */}
            <EvidenceDetailSheet
                open={detailSheetOpen}
                setOpen={setDetailSheetOpen}
                evidenceId={detailEvidenceId}
                canWrite={permissions.canWrite}
                canAdmin={permissions.canAdmin}
                onEdit={(ev) => {
                    setEditInitial(ev);
                    setEditModalOpen(true);
                }}
                onReview={(id, action) => submitReview(id, action)}
            />
            <EditEvidenceModal
                open={editModalOpen}
                setOpen={setEditModalOpen}
                tenantSlug={tenantSlug}
                initial={editInitial}
                onSaved={() => {
                    // Revalidate the list cache so the freshly-saved
                    // values flow back into the table.
                    invalidateEvidence();
                }}
            />

            {/* B8 follow-up — shared folder-suggestions datalist.
                The UploadEvidenceModal references
                reference `list="evidence-folder-suggestions"` so
                the user converges on a small named set of folders.
                Mounting the datalist here means a single source of
                truth derived from the currently-loaded evidence. */}
            <datalist id="evidence-folder-suggestions">
                {Array.from(
                    new Set(
                        (evidence as Array<{ folder?: string | null }>)
                            .map((e) => (e.folder || '').trim())
                            .filter(Boolean),
                    ),
                )
                    .sort()
                    .map((f) => (
                        <option key={f} value={f} />
                    ))}
            </datalist>

            <ListPageShell.Filters className="space-y-section">
                {/* R23-PR-E — KPI strip ABOVE the retention tabs +
                    filter toolbar block. Status-based KPIs sit on a
                    different axis from the retention tabs so the two
                    affordances compose naturally. */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <KpiFilterCard
                        label={tr('client.kpiTotal')}
                        value={totalEvidence}
                        onClick={() => toggleEvidenceKpi('total')}
                        selected={activeEvidenceKpi === 'total'}
                    />
                    <KpiFilterCard
                        label={tr('client.kpiDraft')}
                        value={draftEvidence}
                        tone="attention"
                        onClick={() => toggleEvidenceKpi('draft')}
                        selected={activeEvidenceKpi === 'draft'}
                    />
                    <KpiFilterCard
                        label={tr('client.kpiSubmitted')}
                        value={submittedEvidence}
                        tone="default"
                        onClick={() => toggleEvidenceKpi('submitted')}
                        selected={activeEvidenceKpi === 'submitted'}
                    />
                    <KpiFilterCard
                        label={tr('client.kpiApproved')}
                        value={approvedEvidence}
                        tone="success"
                        onClick={() => toggleEvidenceKpi('approved')}
                        selected={activeEvidenceKpi === 'approved'}
                    />
                </div>

                {/* Retention filter tabs — top-level sub-navigation,
                    on their own row above the filter toolbar. */}
                <div className="flex items-center gap-1 flex-wrap" id="retention-tabs">
                    <Button
                        variant={retentionFilter === 'active' ? 'primary' : 'ghost'}
                        onClick={() => setFilter('tab', 'active')}
                        id="tab-active"
                    >
                        {tr('client.tabActive', { count: activeEvidence.length })}
                    </Button>
                    <Button
                        variant={retentionFilter === 'expiring' ? 'destructive' : 'ghost'}
                        onClick={() => setFilter('tab', 'expiring')}
                        id="tab-expiring"
                    >
                        {tr('client.tabExpiring', { count: expiringEvidence.length })}
                    </Button>
                    <Button
                        variant={retentionFilter === 'archived' ? 'secondary' : 'ghost'}
                        onClick={() => setFilter('tab', 'archived')}
                        id="tab-archived"
                    >
                        {tr('client.tabArchived', { count: archivedEvidence.length })}
                    </Button>
                </div>

                {/*
                  Filter toolbar — the Filter button + live search sit on
                  the LEFT, matching every other list page (previously
                  this whole cluster was right-anchored). The Epic 43.2
                  view toggle + columns gear ride the toolbar's right-edge
                  `actions` slot. The view toggle stays in `useUrlFilters`,
                  NOT `filterCtx`, so flipping the renderer doesn't disturb
                  search-q or any active filter pill — both the table and
                  the gallery read from the same `displayEvidence` array.
                */}
                <EvidenceFilterToolbar
                    filters={visibleFilterDefs}
                    actions={
                        <>
                            <ToggleGroup
                                size="sm"
                                ariaLabel={tr('client.viewLabel')}
                                options={[
                                    { value: 'list', label: tr('client.viewList'), id: 'evidence-view-list' },
                                    { value: 'gallery', label: tr('client.viewGallery'), id: 'evidence-view-gallery' },
                                ]}
                                selected={viewMode}
                                selectAction={(v) => setFilter('view', v === 'list' ? '' : v)}
                                className="shrink-0"
                            />
                            {viewMode === 'list' ? (
                                <>
                                    {columnsDropdown}
                                    {filtersDropdown}
                                </>
                            ) : null}
                        </>
                    }
                />

                {/* Archived warning */}
                {retentionFilter === 'archived' && archivedEvidence.length > 0 && (
                    <InlineNotice variant="warning" title={tr('client.archivedNoticeTitle')}>
                        {tr('client.archivedNoticeBody')}
                    </InlineNotice>
                )}
            </ListPageShell.Filters>

            <ListPageShell.Body>
                <TruncationBanner truncated={truncated} />
                {viewMode === 'gallery' ? (
                    <EvidenceGallery
                        rows={displayEvidence}
                        loading={evidenceQuery.isLoading && !evidenceQuery.data}
                        emptyState={
                            anyFilterActive ? (
                                <EmptyState
                                    size="sm"
                                    variant="no-results"
                                    title={
                                        retentionFilter === 'archived'
                                            ? tr('client.emptyArchived')
                                            : retentionFilter === 'expiring'
                                                ? tr('client.emptyExpiring')
                                                : tr('client.emptyNoMatch')
                                    }
                                    description={tr('client.emptyFilteredDesc')}
                                    secondaryAction={{
                                        label: tr('client.clearFilters'),
                                        onClick: () => filterCtx.clearAll(),
                                    }}
                                />
                            ) : (
                                <EmptyState
                                    size="sm"
                                    variant="no-records"
                                    title={t.noEvidence}
                                    description={tr('client.emptyRecordsDesc')}
                                />
                            )
                        }
                        fileUrl={(ev: any) =>
                            ev.fileRecordId
                                ? apiUrl(`/evidence/files/${ev.fileRecordId}/download`)
                                : null
                        }
                        statusBadgeVariant={(s) => STATUS_BADGE[s] ?? 'neutral'}
                        retentionStatus={(ev: any) => {
                            const rs = getRetentionStatus(ev, hydratedNow, tr);
                            return { label: rs.label, badge: rs.badge };
                        }}
                        data-testid="evidence-gallery"
                    />
                ) : (
                    <DataTable
                        fillBody
                        mobileFallback="card"
                        data={visibleEvidence}
                        columns={orderColumns(evidenceColumns)}
                        getRowId={(ev: any) => ev.id}
                        batchActions={permissions.canAdmin ? [evidenceBulkDelete] : undefined}
                        // Column resizing is opt-in per table (disabled
                        // by default since #823). Re-enabled here only —
                        // the Evidence Library's wide title/folder/owner
                        // columns benefit most from user-tuned widths.
                        // Auto-disables above the virtualization
                        // threshold, where fixed grid widths apply.
                        enableColumnResizing
                        sortableColumns={sortableEvidenceColumns}
                        sortBy={sortBy}
                        sortOrder={sortOrder}
                        onSortChange={({
                            sortBy: nextBy,
                            sortOrder: nextOrder,
                        }) => {
                            setSortBy(nextBy);
                            setSortOrder(nextOrder);
                        }}
                        // B5 — row click opens the detail sheet so
                        // users can actually drill into an evidence
                        // record. Pre-B5 the table was read-only
                        // until you clicked a specific cell-level
                        // action button.
                        onRowClick={(row) => {
                            setDetailEvidenceId(row.original.id);
                            setDetailSheetOpen(true);
                        }}
                        emptyState={
                            anyFilterActive ? (
                                <EmptyState
                                    size="sm"
                                    variant="no-results"
                                    title={
                                        retentionFilter === 'archived'
                                            ? tr('client.emptyArchived')
                                            : retentionFilter === 'expiring'
                                                ? tr('client.emptyExpiring')
                                                : tr('client.emptyNoMatch')
                                    }
                                    description={tr('client.emptyFilteredDesc')}
                                    secondaryAction={{
                                        label: tr('client.clearFilters'),
                                        onClick: () => filterCtx.clearAll(),
                                    }}
                                />
                            ) : (
                                <EmptyState
                                    size="sm"
                                    variant="no-records"
                                    title={t.noEvidence}
                                    description={tr('client.emptyRecordsDesc')}
                                />
                            )
                        }
                        resourceName={(p) => p ? tr('client.resourcePlural') : tr('client.resourceSingular')}
                        columnVisibility={columnVisibility}
                        onColumnVisibilityChange={setColumnVisibility}
                        data-testid="evidence-table"
                        className="hover:bg-bg-muted"
                    />
                )}
                {/* PR-1 — org-parity load-more footer. */}
                <TableLoadMoreFooter
                    hasMore={hasMoreEvidence}
                    visibleCount={visibleEvidence.length}
                    totalCount={totalEvidenceCount}
                    onLoadMore={loadMoreEvidence}
                    resourceName={tr('client.loadMoreResource')}
                    testId="tenant-evidence-load-more"
                />
            </ListPageShell.Body>
            {evidenceDeleteDialog}
        </ListPageShell>
    );
}

// ─── Evidence filter toolbar ─────────────────────────────────────────

function EvidenceFilterToolbar({
    filters,
    actions,
}: {
    filters: FilterType[];
    actions?: React.ReactNode;
}) {
    const tr = useTranslations('evidence');
    return (
        <FilterToolbar
            filters={filters}
            searchId="evidence-search"
            searchPlaceholder={tr('client.searchPlaceholder')}
            actions={actions}
        />
    );
}
