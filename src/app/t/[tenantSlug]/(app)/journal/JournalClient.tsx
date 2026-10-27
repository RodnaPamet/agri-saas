'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { PullToRefresh, useCursorPagination, useToast, useToastWithUndo } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useOfflineSync, type ConflictResolution } from '@/lib/offline/use-offline-sync';
import { OfflineConflictBanner } from '@/components/offline/OfflineConflictBanner';
import { OfflineSyncBar } from '@/components/offline/OfflineSyncBar';
import { Button } from '@/components/ui/button';
import { CloudUpload, Download, Plus, Trash } from '@/components/ui/icons/nucleo';
import { apiDelete } from '@/lib/api-client';
import { parseContentDispositionFilename } from '@/lib/http/content-disposition';
import { Tooltip } from '@/components/ui/tooltip';
import { journalSwipeKind } from './swipe-eligibility';
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
} from './filter-defs';
import { TreatmentEntryModal, type TreatmentSaved } from './TreatmentEntryModal';

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
    /**
     * The folded treatment this row stands for (#1740), when it stands for
     * one. `parcelCount > 0` means the row represents a TREATMENT over that
     * many parcels; 0 means a free-hand entry that folds to itself.
     */
    treatment?: {
        treatmentGroupId: string;
        productName?: string | null;
        parcelCount: number;
        totalAreaHa: number;
        blockNames: string[];
        /**
         * Whether THIS caller may withdraw it (#2175). Server-computed,
         * because the rule is creator-or-admin AND single authorship and the
         * second arm binds admins too — no field on one row can express it.
         *
         * Optional, and absent means PERMITTED: this list reads through the
         * persistent SWR cache, so a row written before the field existed
         * would otherwise hide the control from the person who recorded the
         * treatment. A stale permit costs one 403; a stale denial costs a
         * farmer their own entry.
         */
        mayDelete?: boolean;
    } | null;
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
    const toast = useToast();
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

    /**
     * Rows inside an open undo window (#2175).
     *
     * Held in local state rather than mutated into the SWR cache because
     * `entries` is a cursor ACCUMULATOR fed by `reloadPagination` — a page-1
     * cache edit is overwritten by the next revalidation, which can land while
     * the five seconds are still running and make a withdrawn row reappear
     * mid-countdown.
     */
    const [withdrawing, setWithdrawing] = useState<string[]>([]);
    const unhide = useCallback(
        (id: string) => setWithdrawing((cur) => cur.filter((x) => x !== id)),
        [],
    );

    // What the list actually renders: everything except rows inside an open
    // undo window. See `withdrawing` below.
    const visibleEntries = useMemo(
        () => (withdrawing.length ? entries.filter((e) => !withdrawing.includes(e.id)) : entries),
        [entries, withdrawing],
    );
    const loading = page1Query.isLoading && !page1Query.data;

    // Offline-capable journal-entry create. One shared hook so a create queued
    // from the modal is reflected in this page's OfflineSyncBar pending count.
    const { online, pending, readable, queueGrowing, foreign, durability, submit: offlineSubmit, flush, conflicts, resolveConflict } = useOfflineSync();
    const [resolvingId, setResolvingId] = useState<string | null>(null);
    const [pdfBusyFor, setPdfBusyFor] = useState<string | null>(null);
    const [driveBusyFor, setDriveBusyFor] = useState<string | null>(null);
    /**
     * Both halves of the server's gate, mirrored so the control is ABSENT
     * rather than refusing (#2019).
     *
     * The flag comes from the tenant layout — there is no client-side flags
     * hook, and it is resolved once there rather than per page. The permission
     * is the caller's own. Offering this on the flag alone would offer a 403 to
     * every writer; on admin alone it would offer a 404 to every tenant
     * without the integration, which is most of them since the flag is
     * default-OFF.
     */
    const { googleIntegrationEnabled } = useTenantContext();
    const driveExportEnabled = !!googleIntegrationEnabled && permissions.canAdmin;
    const onResolveConflict = useCallback(
        async (id: string, resolution: ConflictResolution) => {
            setResolvingId(id);
            try {
                await resolveConflict(id, resolution);
                // take-server discarded the queued edit; keep-mine has just
                // applied it. Either way the list on screen is now behind.
                await page1Query.mutate();
            } finally {
                setResolvingId(null);
            }
        },
        [resolveConflict, page1Query],
    );
    /**
     * The per-treatment ДНЕВНИК, for one folded row.
     *
     * Offered on the ROW rather than as a post-save screen, deliberately. A
     * confirmation step would carry the document for the treatment just
     * recorded and for no other, so a farmer who closed the modal — or who
     * recorded it on the phone — would have no way back to it. On the row it
     * is reachable for every treatment the register holds.
     *
     * Shown only where `parcelCount > 0`: the route answers 404
     * `TREATMENT_NOT_FOUND` for a treatment with no lines rather than
     * returning an empty document, and a free-hand entry has no treatment to
     * document. The whole-farm ДНЕВНИК for a date range is a different
     * document and lives on the entry detail page.
     *
     * The blob dance (Content-Disposition, anchor, revoke) is the same one
     * `journal/[id]/page.tsx` uses for the location farm-record — one idiom
     * for both, so a filename served by the API wins over a guessed one.
     */
    const downloadTreatmentPdf = useCallback(
        async (treatmentGroupId: string) => {
            setPdfBusyFor(treatmentGroupId);
            try {
                const res = await fetch(
                    buildApiUrl(`/journal/treatments/${treatmentGroupId}/farm-record`),
                );
                if (!res.ok) throw new Error(String(res.status));
                const blob = await res.blob();
                // One parser, shared with the builder that writes the header
                // (#1833). This logic was inline here and the other two
                // download sites each did something different.
                const named = parseContentDispositionFilename(
                    res.headers.get('Content-Disposition'),
                );
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = named ?? `dnevnik-${treatmentGroupId}.pdf`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch {
                toast.error(t('treatmentPdfFail'));
            } finally {
                setPdfBusyFor(null);
            }
        },
        [buildApiUrl, t, toast],
    );

    /**
     * Send the same document to the farm's Google Drive (#2019).
     *
     * No blob dance — the bytes never come here. The server renders the
     * document, puts it in Drive and answers where it landed, so the only
     * thing to do with a success is say so.
     *
     * ## Each refusal gets its own sentence
     *
     * The route answers four distinct coded failures and every one of them has
     * a different action behind it: connect an account, re-grant Drive,
     * reconnect a revoked grant, or free up Drive storage. Collapsing them into
     * one "export failed" would leave an admin with nothing to do — and the
     * reason the server sends codes rather than Bulgarian prose is so this
     * mapping can live here, where the copy is translated.
     *
     * `GOOGLE_DRIVE_NOT_GRANTED` and `GOOGLE_DRIVE_REFUSED` both arrive as a
     * 403 from Google and are deliberately NOT merged: telling a farmer to
     * reconnect when their Drive is simply full is wrong advice confidently
     * given.
     */
    const exportTreatmentToDrive = useCallback(
        async (treatmentGroupId: string) => {
            setDriveBusyFor(treatmentGroupId);
            try {
                const res = await fetch(
                    buildApiUrl(`/journal/treatments/${treatmentGroupId}/farm-record/drive`),
                    { method: 'POST' },
                );
                if (!res.ok) {
                    // Read leniently: a failure to parse the envelope must not
                    // turn into a second, less useful failure.
                    const body = (await res.json().catch(() => null)) as
                        | { code?: string }
                        | null;
                    const byCode: Record<string, string> = {
                        GOOGLE_NOT_CONNECTED: 'treatmentDriveNotConnected',
                        GOOGLE_DRIVE_NOT_GRANTED: 'treatmentDriveNoAccess',
                        GOOGLE_GRANT_REVOKED: 'treatmentDriveRevoked',
                        GOOGLE_DRIVE_REFUSED: 'treatmentDriveRefused',
                    };
                    const key = (body?.code && byCode[body.code]) || 'treatmentDriveFail';
                    toast.error(t(key));
                    return;
                }
                toast.success(t('treatmentDriveOk'));
            } catch {
                toast.error(t('treatmentDriveFail'));
            } finally {
                setDriveBusyFor(null);
            }
        },
        [buildApiUrl, t, toast],
    );

    /**
     * After a treatment is recorded, RELOAD rather than inserting a row.
     *
     * A folded ДНЕВНИК row is a server-side aggregate over the treatment's N
     * entries — the handle, the parcel count, the total area, the block
     * names, the earliest-harvest day. Building a convincing one here would
     * be a second implementation of the fold, and it would be the one the
     * farmer sees first.
     */
    const handleTreatmentSaved = (saved: TreatmentSaved) => {
        if (saved.delivery === 'queued') {
            // QUEUED: there is no server row to fetch, so prepend an
            // optimistic one and do NOT revalidate — a revalidation offline
            // fails, and online it would replace this row before the outbox
            // has delivered it. The outbox's own reconnect drain is what
            // eventually makes the real row appear, via SWR's reconnect
            // revalidation.
            //
            // The row carries NO `treatment` object, which is exactly right
            // rather than a shortcut: the aggregate does not exist yet, and
            // its absence is what keeps «Изтегли дневник (PDF)» off a
            // treatment the server has never seen. A button there would 404.
            void page1Query.mutate(
                (cur) => ({
                    rows: [
                        {
                            id: `optimistic-${Date.now()}`,
                            type: 'INPUT_APPLICATION',
                            // The farmer's own word for it. The server
                            // composes the real title (`{product} — {parcel}`)
                            // per line, and the folded row prefers the product
                            // name anyway — so this reads the same before and
                            // after delivery.
                            title: saved.productName ?? '',
                            status: 'DONE',
                            occurredAt: `${saved.occurredOn}T00:00:00.000Z`,
                        } as JournalRow,
                        ...(cur?.rows ?? []),
                    ],
                    nextCursor: cur?.nextCursor ?? null,
                }),
                { revalidate: false },
            );
            return;
        }
        // SENT: revalidating page 1 is what reseeds the accumulator — the
        // effect above compares the content signature and calls
        // `reloadPagination(rows, nextCursor)` with the SERVER's rows. No
        // optimistic row, because a folded ДНЕВНИК row is a server-side
        // aggregate (handle, parcel count, total area, block names, earliest
        // harvest day) and building a convincing one here would be a second
        // implementation of the fold — the one the farmer sees first.
        //
        // 'conflict' lands here too: the item is parked for the
        // OfflineConflictBanner this page already renders, and revalidating
        // shows whatever the server actually holds.
        void page1Query.mutate();
    };

    const triggerUndoToast = useToastWithUndo();

    /**
     * Swiping a journal row removes what that row IS, which is two different
     * writes (#2175).
     *
     * A folded row with `parcelCount > 0` stands for a TREATMENT — N tasks and
     * N register lines across its blocks — so the honest action is the
     * treatment withdrawal, and the toast names the count because the row
     * looks like one line and is not. A row with no treatment is one entry,
     * and the entry delete that has existed since #338 is correct for it.
     *
     * The register is why this matters: its treatment rows are built from
     * `operationParcel` and never read `LogEntry`, so deleting the ENTRY under
     * a treatment row would leave every printed line in place. Only the
     * withdrawal reaches them.
     */
    const withdrawRow = useCallback(
        (entry: JournalRow) => {
            const tr = entry.treatment;
            // The same function the gate used, not a second reading of the
            // same fields — two spellings of "is this a treatment" is how the
            // control and the write end up disagreeing about what it does.
            const isTreatment =
                journalSwipeKind(entry, { canWrite: permissions.canWrite }) === 'treatment';
            setWithdrawing((cur) => [...cur, entry.id]);
            triggerUndoToast({
                message: isTreatment
                    ? t('swipe.withdrewTreatment', {
                          rows: tr!.parcelCount,
                          blocks: tr!.blockNames.length,
                      })
                    : t('swipe.withdrewEntry'),
                undoMessage: t('swipe.undo'),
                action: async () => {
                    await apiDelete(
                        buildApiUrl(
                            isTreatment
                                ? `/journal/treatments/${tr!.treatmentGroupId}`
                                : `/journal/${entry.id}`,
                        ),
                    );
                    await page1Query.mutate();
                },
                // The row is already gone from the server's answer by the time
                // the revalidation lands, so the local hide has done its job.
                onCommit: () => unhide(entry.id),
                undoAction: () => unhide(entry.id),
                onError: (err) => {
                    unhide(entry.id);
                    toast.error(err instanceof Error ? err.message : t('swipe.failed'));
                },
            });
        },
        [buildApiUrl, page1Query, permissions.canWrite, t, toast, triggerUndoToast, unhide],
    );

    /**
     * Who gets the gesture. `null` means the row does not swipe at all, which
     * is the right answer for a control that would refuse: `mayDelete` is
     * false for a treatment this caller did not record, and for one recorded
     * by more than one person (which refuses admins too).
     *
     * `mayDelete === false` rather than `!mayDelete`, because an ABSENT flag
     * is a cached row from before the field existed and must permit — the
     * server re-checks either way.
     */
    const swipeAction = useCallback(
        (row: { original: JournalRow }) => {
            const entry = row.original;
            if (!journalSwipeKind(entry, { canWrite: permissions.canWrite })) return null;
            return {
                label: t('swipe.delete'),
                icon: <Trash className="size-4" />,
                onAction: () => withdrawRow(entry),
            };
        },
        [permissions.canWrite, t, withdrawRow],
    );

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
                // Title — what the entry IS, and the only route to its
                // detail page.
                //
                // This column WAS deleted by the first pass of this change,
                // because it was named `parcelCulture` and the owner's list
                // said to drop parcel and culture. Its accessor was
                // `parcel.name ?? location.name ?? title`, so the task-fed
                // half was only the FIRST branch: deleting it took the
                // entry's own title, the row's link, and — since it held
                // `mobileCard: { slot: 'title' }` — the phone card's heading,
                // leaving a journal of untitled rows nobody could open.
                //
                // `journal-offline-create.spec.ts` caught it on both mobile
                // projects, 3 of 3 attempts, asserting the optimistic row
                // shows its title. The lesson is in the naming: a column's
                // ID described its first branch, and classifying by that name
                // instead of by what it RENDERED dropped three things the
                // ruling never mentioned.
                //
                // What the ruling asked for is honoured — no parcel name and
                // no `cropType` suffix. `LogEntry.title` is `String`, not
                // nullable, so there is nothing to fall back to.
                {
                    id: 'entryTitle',
                    header: t('colTitle'),
                    // A FOLDED treatment row must not be titled by one of
                    // its parcels (#1740).
                    //
                    // The row IS the group's representative entry, and an
                    // INPUT_APPLICATION title is `{product} — {parcel}`,
                    // written per line. So a treatment over 30 parcels read as
                    // «Тестов препарат — Парцел 7» — one parcel's record, with
                    // nothing saying it covered 29 more. Found by agrent-ios,
                    // which titles its own rows by the product and shows the
                    // counts beneath, so only the web was exposed.
                    //
                    // Fixed HERE rather than by overriding `title` in the
                    // fold, for two reasons. The row is documented as an
                    // honest copy of a real entry, and an overridden title
                    // would differ from the one the entry-detail page shows
                    // when you tap it. And composing "30 парцела · 120 дка"
                    // server-side would be server-authored Bulgarian copy,
                    // which `no-server-authored-user-copy` ratchets down and
                    // which the message catalogues exist to hold.
                    accessorFn: (e) =>
                        (e.treatment && e.treatment.parcelCount > 0
                            ? e.treatment.productName
                            : null) ?? e.title,
                    cell: ({ row, getValue }) => {
                        const tr = row.original.treatment;
                        const folded = tr && tr.parcelCount > 0 ? tr : null;
                        return (
                            <TableTitleCell
                                href={tenantHref(`/journal/${row.original.id}`)}
                                id={`journal-link-${row.original.id}`}
                            >
                                <span>{getValue() as string}</span>
                                {folded ? (
                                    <span className="block text-[0.72rem] text-content-muted">
                                        {t('treatmentSummary', {
                                            // Hectares on the wire, дка on the
                                            // screen — the conversion belongs
                                            // where the number is displayed.
                                            area: Math.round(folded.totalAreaHa * 10 * 10) / 10,
                                            count: folded.parcelCount,
                                        })}
                                        {folded.blockNames.length > 0
                                            ? ` · ${t('treatmentBlocks', {
                                                  blocks: folded.blockNames.join(', '),
                                              })}`
                                            : ''}
                                    </span>
                                ) : null}
                            </TableTitleCell>
                        );
                    },
                    meta: { mobileCard: { slot: 'title' } },
                },
                // Type — the journal's OWN vocabulary (Наблюдение, Третиране).
                //
                // The deleted `operation` column preferred
                // `operationParcel.task.operationType` and fell back to
                // `e.type`; only the first branch was task-fed. Kept as the
                // entry kind alone, because it is the phone card's `subtitle`
                // slot and a list whose rows do not say what kind of entry
                // they are is harder to scan rather than tidier.
                {
                    id: 'entryType',
                    header: t('colType'),
                    accessorFn: (e) =>
                        e.type in LOG_ENTRY_TYPE_LABELS
                            ? te(`logType.${e.type}`)
                            : String(e.type).replace(/_/g, ' '),
                    cell: ({ getValue }) => (
                        <StatusBadge variant="info" size="sm">
                            {String(getValue()).replace(/_/g, ' ')}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'subtitle' } },
                },
                // The six task-fed columns — parcel, culture, product (with
                // its active ingredient), dose, treated area and PHI — were
                // REMOVED here (owner ruling 2026-10-10).
                //
                // Every one read through `e.operationParcel`, and the journal
                // no longer lists entries that have one (#1562), so each would
                // render an em dash on every row for ever. That spray data
                // lives under tasks and in the ДНЕВНИК PDF, which reads the
                // operation lines directly rather than through this list.
                //
                // The columns that REMAIN read the entry itself — title, type,
                // occurredAt, operator (`conditionsJson.agronomistName`),
                // status and notes — which is why `operator` survives a
                // "drop the task columns" sweep that looks like it should
                // take it too.
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
                {
                    id: 'actions',
                    header: '',
                    enableHiding: false,
                    cell: ({ row }) => {
                        const tr = row.original.treatment;
                        // Only a row that STANDS FOR a treatment. On a
                        // free-hand entry the route would 404, so offering
                        // the button there would be offering a failure.
                        if (!tr || tr.parcelCount === 0) return null;
                        const busy = pdfBusyFor === tr.treatmentGroupId;
                        const driveBusy = driveBusyFor === tr.treatmentGroupId;
                        return (
                            <div className="flex items-center justify-end gap-tight">
                                <Tooltip content={t('treatmentPdf')}>
                                    <button
                                        type="button"
                                        aria-label={t('treatmentPdf')}
                                        disabled={busy}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                        data-testid={`treatment-pdf-${tr.treatmentGroupId}`}
                                        onClick={(e) => {
                                            // The row itself navigates to the
                                            // entry, so without this the PDF
                                            // click also leaves the page.
                                            e.stopPropagation();
                                            void downloadTreatmentPdf(tr.treatmentGroupId);
                                        }}
                                    >
                                        <Download className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                </Tooltip>
                                {/*
                                  * Absent unless the caller is an admin AND
                                  * the integration flag is on — both resolved
                                  * on the server, because there is no
                                  * client-side flags hook. Offering this to a
                                  * writer would be offering a 403, and
                                  * offering it without the flag would be
                                  * offering a 404.
                                  */}
                                {driveExportEnabled && (
                                    <Tooltip content={t('treatmentDrive')}>
                                        <button
                                            type="button"
                                            aria-label={t('treatmentDrive')}
                                            disabled={driveBusy}
                                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                            data-testid={`treatment-drive-${tr.treatmentGroupId}`}
                                            onClick={(e) => {
                                                // The row navigates to the
                                                // entry, so without this the
                                                // export click leaves the page
                                                // too — same reason the
                                                // download button stops it.
                                                e.stopPropagation();
                                                void exportTreatmentToDrive(tr.treatmentGroupId);
                                            }}
                                        >
                                            <CloudUpload className="h-3.5 w-3.5" aria-hidden />
                                        </button>
                                    </Tooltip>
                                )}
                            </div>
                        );
                    },
                },
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- read 2026-10-17 for #1730: no state value is omitted. `pdfBusyFor` and `downloadTreatmentPdf` ARE listed, which is what keeps the per-row PDF button from firing a stale handler (#2033 is the sibling that was not so lucky)
        [tenantSlug, t, te, pdfBusyFor, downloadTreatmentPdf, driveBusyFor, exportTreatmentToDrive, driveExportEnabled],
    );

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
                data: visibleEntries,
                columns,
                loading,
                getRowId: (e) => e.id,
                // <sm: render each entry as a tappable card; taps through to
                // the journal detail via onRowClick below.
                mobileFallback: 'card',
                swipeAction,
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
                    {/* «Нов запис» records a TREATMENT, not a free-form note
                        (#1740). The free-form form is replaced rather than
                        hidden behind a flag: the owner ruled it replaced, and
                        a flag would leave two ways to write a journal entry
                        with different semantics — which is the web/phone
                        divergence this closes, reproduced inside the web. */}
                    <TreatmentEntryModal
                        open={isCreateOpen}
                        setOpen={setIsCreateOpen}
                        offlineSubmit={offlineSubmit}
                        onSaved={handleTreatmentSaved}
                    />
                    {/* 409 conflicts — a queued journal write the server refused
                        because the entry moved on. Mounted UNCONDITIONALLY (it
                        self-hides when empty) and OUTSIDE the sync bar's gate:
                        `pending` excludes parked conflicts, so `!online ||
                        pending > 0` is false in exactly the state that needs
                        showing, and until #921 a refused edit was invisible on
                        every journal surface while no drain would ever re-send
                        it. */}
                    <OfflineConflictBanner conflicts={conflicts} onResolve={onResolveConflict} busyId={resolvingId} />
                    {/* Surfaces a queued (offline) create + a "Sync now" when
                        back online. Hidden while online with nothing pending. */}
                    {(!online || pending > 0) && (
                        <OfflineSyncBar
                            readable={readable}
                            online={online}
                            pending={pending}
                            queueGrowing={queueGrowing} foreign={foreign}
                            storagePersisted={durability?.persisted ?? null}
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
