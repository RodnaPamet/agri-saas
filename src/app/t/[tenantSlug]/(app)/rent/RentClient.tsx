'use client';

/**
 * RentClient — the tenant-wide land-obligation surface (roadmap 3/3). Folds the
 * rent roll (leased area / rent / expiring contracts, via RentRollCard) and the
 * full аренда/наем register into one page: every lease across every parcel,
 * created / edited / removed here. A lease is parcel-bound, so create picks a
 * parcel via a Combobox. Honors a `?locationId` deep-link from a location page.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { DataTable, createColumns, useColumnsDropdown } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { RentRollCard, type RentRollData } from '@/components/ui/map/RentRollCard';
import { leaseExpiryTier, LEASE_EXPIRY_TONE, daysUntil } from '@/lib/agro/lease-expiry';
import { LeasePaymentsPanel } from '@/components/agro/LeasePaymentsPanel';
import {
    LeaseFormFields,
    EMPTY_LEASE_FORM,
    leaseToForm,
    leaseFormToBody,
    validateLeaseForm,
    type LeaseFormState,
} from '@/components/agro/LeaseFormFields';
import { Fab } from '@/components/ui/fab';
import { PullToRefresh, useToastWithUndo } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { Plus, PenWriting, Trash } from '@/components/ui/icons/nucleo';
import { formatDate } from '@/lib/format-date';

interface LeaseRow {
    id: string;
    parcelId: string;
    lessorName: string;
    lessorEik: string | null;
    kind: 'ARENDA' | 'NAEM';
    rentAmount: string | number | null;
    rentUnit: string | null;
    startDate: string | null;
    endDate: string | null;
    documentRef: string | null;
    notes: string | null;
    parcel: {
        id: string;
        name: string;
        areaHa: string | number | null;
        location: { id: string; name: string };
    };
}

interface ParcelOption {
    id: string;
    name: string;
    locationId: string;
    locationName: string;
}

// The lease field set lives in the shared <LeaseFormFields>; the Rent modal
// adds only `parcelId` (a lease is parcel-bound and the modal picks it).
type FormState = LeaseFormState & { parcelId: string };
const EMPTY_FORM: FormState = { ...EMPTY_LEASE_FORM, parcelId: '' };

export function RentClient({
    tenantSlug,
    permissions,
}: {
    tenantSlug: string;
    permissions: { canWrite: boolean };
}) {
    const t = useTranslations('ag.rent');
    const tl = useTranslations('ag.lease');
    const tc = useTranslations('common');
    const buildUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const triggerUndoToast = useToastWithUndo();

    const locationId = useSearchParams().get('locationId') ?? undefined;
    const scope = locationId ? `?locationId=${locationId}` : '';

    const leasesQ = useTenantSWR<{ leases: LeaseRow[] }>(`/leases${scope}`);
    const parcelsQ = useTenantSWR<{ parcels: ParcelOption[] }>('/leases/parcel-options');
    // Lifted the rent-roll SWR up from RentRollCard so every lease mutation
    // (save / undo-commit / pull-to-refresh) revalidates the KPI card too —
    // otherwise the card stays stale (and the first-lease card never appears).
    const rentRollQ = useTenantSWR<RentRollData>(`/reports/rent-roll${scope}`);
    const leases = useMemo(() => leasesQ.data?.leases ?? [], [leasesQ.data]);
    const parcelOptions = useMemo(() => parcelsQ.data?.parcels ?? [], [parcelsQ.data]);

    // The location name for the deep-linked filter chip. Read from the parcel
    // catalogue (already fetched, tenant-wide) rather than `leases[0]` — off a
    // row it disappears exactly when the location has no leases, which is when
    // the chip matters most.
    const locationName = locationId
        ? parcelOptions.find((p) => p.locationId === locationId)?.locationName
        : undefined;

    // „Неплатени" — narrow the register to lessors who still have outstanding
    // rent this season. Keyed by (lessor × unit) because the roll books each
    // unit separately: a lessor can be settled in лв but not in кг.
    const [unpaidOnly, setUnpaidOnly] = useState(false);
    const unpaidKeys = useMemo(() => {
        const set = new Set<string>();
        for (const row of rentRollQ.data?.byLessor ?? []) {
            if (row.outstanding > 0) set.add(`${row.lessorName}|${row.rentUnit ?? ''}`);
        }
        return set;
    }, [rentRollQ.data]);
    const visibleLeases = useMemo(
        () => (unpaidOnly ? leases.filter((l) => unpaidKeys.has(`${l.lessorName}|${l.rentUnit ?? ''}`)) : leases),
        [unpaidOnly, leases, unpaidKeys],
    );

    const [showModal, setShowModal] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
        setForm((f) => ({ ...f, [k]: v }));

    const openCreate = () => {
        setEditingId(null);
        setForm(EMPTY_FORM);
        setError(null);
        setShowModal(true);
    };
    const openEdit = (l: LeaseRow) => {
        setEditingId(l.id);
        setForm({ ...leaseToForm(l), parcelId: l.parcelId });
        setError(null);
        setShowModal(true);
    };

    const parcelComboOptions: ComboboxOption<ParcelOption>[] = useMemo(
        () =>
            // While a location filter is active, only its parcels are
            // selectable — creating a lease on an unrelated parcel from a
            // location-scoped view would silently leave the view.
            parcelOptions
                .filter((p) => !locationId || p.locationId === locationId)
                .map((p) => ({
                label: p.name,
                value: p.id,
                meta: p,
            })),
        [parcelOptions, locationId],
    );
    const selectedParcel = parcelComboOptions.find((o) => o.value === form.parcelId) ?? null;
    const selectedParcelName = parcelOptions.find((p) => p.id === form.parcelId)?.name ?? '';

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.parcelId) {
            setError(t('parcelRequired'));
            return;
        }
        const invalid = validateLeaseForm(form);
        if (invalid) {
            setError(tl(invalid));
            return;
        }
        const body = leaseFormToBody(form);
        setBusy(true);
        setError(null);
        try {
            if (editingId) await apiPatch(buildUrl(`/leases/${editingId}`), body);
            else await apiPost(buildUrl('/leases'), { ...body, parcelId: form.parcelId });
            setShowModal(false);
            await Promise.all([leasesQ.mutate(), rentRollQ.mutate()]);
        } catch (err) {
            setError(err instanceof Error ? err.message : tl('saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    const remove = (l: LeaseRow) => {
        if (!permissions.canWrite) return;
        // Epic 67 — optimistic remove + 5s undo window; the DELETE only fires
        // if the user doesn't hit Undo. SWR's `mutate` is referentially stable
        // and its functional updater sees the CURRENT cache, so this stays
        // correct even though the column cells that call it are memoised.
        let snapshot: LeaseRow[] = [];
        void leasesQ.mutate(
            (cur) => {
                snapshot = cur?.leases ?? [];
                return { leases: snapshot.filter((x) => x.id !== l.id) };
            },
            { revalidate: false },
        );
        const restore = () => {
            void leasesQ.mutate({ leases: snapshot }, { revalidate: false });
        };
        triggerUndoToast({
            action: () => apiDelete(buildUrl(`/leases/${l.id}`)),
            undoAction: restore,
            onCommit: () => {
                void leasesQ.mutate();
                void rentRollQ.mutate();
            },
            onError: restore,
            message: t('leaseRemoved'),
            undoMessage: t('undo'),
        });
    };

    const kindLabel = (k: 'ARENDA' | 'NAEM') => (k === 'ARENDA' ? tl('kindArenda') : tl('kindNaem'));
    const rentLabel = (l: LeaseRow) =>
        l.rentAmount != null ? `${l.rentAmount}${l.rentUnit ? ` ${l.rentUnit}` : ''}` : '—';
    const termLabel = (l: LeaseRow) => {
        const s = l.startDate ? formatDate(l.startDate) : null;
        const e = l.endDate ? formatDate(l.endDate) : null;
        if (s && e) return `${s} – ${e}`;
        if (e) return `→ ${e}`;
        if (s) return `${s} →`;
        return '—';
    };
    const statusBadge = (l: LeaseRow) => {
        if (!l.endDate) return <StatusBadge variant="success">{t('statusActive')}</StatusBadge>;
        const d = daysUntil(l.endDate);
        // One shared clock: the tier + tone come from lease-expiry so this badge
        // and the card's expiring list are identical functions of daysLeft.
        const tier = leaseExpiryTier(d);
        if (tier === 'expired') return <StatusBadge variant="neutral">{t('statusExpired')}</StatusBadge>;
        if (tier === 'ok') return <StatusBadge variant="success">{t('statusActive')}</StatusBadge>;
        return (
            <StatusBadge variant={LEASE_EXPIRY_TONE[tier]}>
                {t('statusExpiring', { days: d })}
            </StatusBadge>
        );
    };

    const columns = useMemo(
        () =>
            createColumns<LeaseRow>([
                {
                    accessorKey: 'lessorName',
                    header: t('colLessor'),
                    cell: ({ row }) => (
                        <span className="font-medium text-content-emphasis">{row.original.lessorName}</span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'parcel',
                    header: t('colParcel'),
                    cell: ({ row }) => (
                        <span className="text-content-secondary">
                            {row.original.parcel.name}
                            <span className="text-content-subtle"> · {row.original.parcel.location.name}</span>
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colParcel') } },
                },
                {
                    id: 'kind',
                    header: t('colKind'),
                    cell: ({ row }) => kindLabel(row.original.kind),
                    meta: { mobileCard: { slot: 'meta', label: t('colKind') } },
                },
                {
                    id: 'rent',
                    header: t('colRent'),
                    cell: ({ row }) => <span className="tabular-nums">{rentLabel(row.original)}</span>,
                    meta: { mobileCard: { slot: 'meta', label: t('colRent') } },
                },
                {
                    id: 'term',
                    header: t('colTerm'),
                    cell: ({ row }) => <span className="tabular-nums">{termLabel(row.original)}</span>,
                    meta: { mobileCard: { slot: 'meta', label: t('colTerm') } },
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => statusBadge(row.original),
                    meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
                },
                {
                    id: 'documentRef',
                    header: tl('documentRef'),
                    accessorFn: (l: LeaseRow) => l.documentRef || '—',
                    meta: { mobileCard: { slot: 'meta', label: tl('documentRef') } },
                },
                {
                    id: 'actions',
                    header: '',
                    // Read-only members get no row actions (the server asserts
                    // too — this just stops offering what would be refused).
                    cell: ({ row }) => (permissions.canWrite ? (
                        <div className="flex items-center justify-end gap-tight">
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openEdit(row.original);
                                }}
                                aria-label={tc('edit')}
                                className="text-content-subtle hover:text-content-default"
                            >
                                <PenWriting className="size-4" aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    remove(row.original);
                                }}
                                aria-label={tc('delete')}
                                className="text-content-subtle hover:text-content-error"
                            >
                                <Trash className="size-4" aria-hidden="true" />
                            </button>
                        </div>
                    ) : null),
                    meta: { mobileCard: { slot: 'actions' } },
                },
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [t, tc, tl, permissions.canWrite],
    );

    // Gear-toggleable columns — documentRef (Договор №) is off by default;
    // most operators scan by owner/parcel, not contract number.
    const { columnVisibility, setColumnVisibility, orderColumns, dropdown: columnsDropdown } =
        useColumnsDropdown({
            storageKey: 'inflect:col-vis:rent',
            columns: [
                { id: 'lessorName', label: t('colLessor') },
                { id: 'parcel', label: t('colParcel') },
                { id: 'kind', label: tl('kind') },
                { id: 'rent', label: tl('rent') },
                { id: 'term', label: t('colTerm') },
                { id: 'documentRef', label: tl('documentRef'), defaultVisible: false },
                { id: 'status', label: t('colStatus') },
            ],
        });

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('bcDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t('title') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t('title')}</Heading>
                        <p className="text-sm text-content-secondary">{t('description')}</p>
                        {rentRollQ.data?.truncated ? (
                            <p className="mt-1 text-sm text-content-warning" id="rent-truncated-hint">
                                {t('truncatedHint', { count: rentRollQ.data.leaseCap })}
                            </p>
                        ) : null}
                        {locationId ? (
                            <p className="mt-1 text-sm text-content-secondary">
                                {locationName ? t('filteredTo', { location: locationName }) : null}{' '}
                                <a href={tenantHref('/rent')} className="text-content-link hover:underline">
                                    {t('clearFilter')}
                                </a>
                            </p>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-tight">
                        <Button
                            variant={unpaidOnly ? 'primary' : 'secondary'}
                            size="sm"
                            onClick={() => setUnpaidOnly((v) => !v)}
                            id="rent-unpaid-filter"
                            aria-pressed={unpaidOnly}
                        >
                            {t('unpaidFilter')}
                        </Button>
                        {columnsDropdown}
                        {permissions.canWrite ? (
                            <Button variant="primary" size="sm" icon={<Plus />} onClick={openCreate}>
                                {tl('lease')}
                            </Button>
                        ) : null}
                    </div>
                </div>
            </ListPageShell.Header>

            <ListPageShell.Body>
                <div className="flex h-full min-h-0 flex-col gap-section">
                    {/* Summary stays anchored (shrink-0); the table body scrolls
                        beneath it via fillBody in the bounded flex column. */}
                    <div className="shrink-0">
                        <RentRollCard
                            locationId={locationId}
                            data={rentRollQ.data}
                            hasLeases={leases.length > 0}
                        />
                    </div>
                    <DataTable
                        fillBody
                        mobileFallback="card"
                        data-testid="rent-table"
                        data={visibleLeases}
                        columns={orderColumns(columns)}
                        columnVisibility={columnVisibility}
                        onColumnVisibilityChange={setColumnVisibility}
                        loading={leasesQ.isLoading && !leasesQ.data}
                        getRowId={(l) => l.id}
                        onRowClick={permissions.canWrite ? (row) => openEdit(row.original) : undefined}
                        emptyState={(
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t('emptyTitle')}
                                description={t('emptyDesc')}
                                primaryAction={permissions.canWrite ? { label: tl('lease'), onClick: openCreate } : undefined}
                            />
                        )}
                    />
                </div>
            </ListPageShell.Body>

            <Modal
                showModal={showModal}
                setShowModal={setShowModal}
                size="md"
                title={editingId ? t('modalEditTitle') : t('modalCreateTitle')}
            >
                <Modal.Header
                    title={editingId ? t('modalEditTitle') : t('modalCreateTitle')}
                    description={t('modalDescription')}
                />
                <Modal.Form id="lease-form" onSubmit={save}>
                    <Modal.Body>
                        {error ? (
                            <div
                                role="alert"
                                className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            >
                                {error}
                            </div>
                        ) : null}
                        <div className="space-y-default">
                            <FormField label={t('fieldParcel')} required>
                                {editingId ? (
                                    // Parcel is fixed once a lease exists (a lease belongs
                                    // to its parcel) — show it read-only.
                                    <Input value={selectedParcelName} disabled />
                                ) : (
                                    <Combobox<false, ParcelOption>
                                        selected={selectedParcel}
                                        setSelected={(o) => set('parcelId', o?.value ?? '')}
                                        // undefined while the options are still loading → the
                                        // Combobox shows a spinner instead of a premature "No matches".
                                        options={parcelsQ.data ? parcelComboOptions : undefined}
                                        loading={parcelsQ.isLoading}
                                        placeholder={t('parcelPlaceholder')}
                                        searchPlaceholder={t('parcelSearchPlaceholder')}
                                        optionDescription={(o) => o.meta?.locationName ?? ''}
                                        matchTriggerWidth
                                    />
                                )}
                            </FormField>
                            <LeaseFormFields
                                form={form}
                                setField={(k, v) => set(k, v as FormState[typeof k])}
                            />
                            {/* Settlement log — only for a saved lease (a payment
                                needs something to settle against). Revalidates the
                                roll so paid/outstanding stay live. */}
                            {editingId ? (
                                <LeasePaymentsPanel
                                    leaseId={editingId}
                                    rentUnit={form.rentUnit || null}
                                    canWrite={permissions.canWrite}
                                    onChanged={() => { void rentRollQ.mutate(); }}
                                />
                            ) : null}
                        </div>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setShowModal(false)}>
                            {tc('cancel')}
                        </Button>
                        <Button variant="primary" size="sm" type="submit" loading={busy} disabled={busy}>
                            {editingId ? tc('save') : t('createLease')}
                        </Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

            <PullToRefresh onRefresh={() => Promise.all([leasesQ.mutate(), rentRollQ.mutate()])} />
            <ScrollToTop />
            {permissions.canWrite ? (
                <Fab onClick={openCreate} label={tl('lease')} icon={<Plus aria-hidden className="h-6 w-6" />} />
            ) : null}
        </ListPageShell>
    );
}

export default RentClient;
