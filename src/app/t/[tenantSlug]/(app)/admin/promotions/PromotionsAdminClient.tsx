'use client';

/**
 * The support console for the global promotions feed (#12).
 *
 * The workflow this is shaped around: a company emails support asking to
 * advertise, support types it up as a DRAFT, checks it, then publishes. Nothing
 * here writes straight to a live feed — `createPromotion` always produces a
 * draft, and publishing is a deliberate second action.
 *
 * Status is derived, not stored: DRAFT (never published) → SCHEDULED (published
 * but the window hasn't opened) → LIVE → EXPIRED. See
 * `derivePromotionStatus`.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost, apiPatch, apiDelete } from '@/lib/api-client';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Plus, ScanText } from '@/components/ui/icons/nucleo';
import { useToast } from '@/components/ui/hooks';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { PROMOTION_CATEGORIES } from '@/app-layer/schemas/promotion-admin.schemas';
import { PromotionImageField } from './PromotionImageField';

interface PromotionRow {
    id: string;
    companyId: string;
    companyName: string;
    title: string;
    body: string | null;
    mediaUrl: string | null;
    category: string;
    ctaUrl: string | null;
    pppRegistrationNo: string | null;
    /** The leaflet this was read from, or null — never read from one (#2750). */
    sourceFileId: string | null;
    publishedAt: string | null;
    validFrom: string | null;
    validTo: string | null;
    status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED';
    leadCount: number;
}

/** One offer the reader proposed. Never saved as-is — see `acceptOffer`. */
interface LeafletOffer {
    productName: string;
    priceText: string | null;
    validityText: string | null;
    note: string | null;
}

interface LeafletScan {
    fileId: string;
    companyName: string | null;
    offers: LeafletOffer[];
    unreadableOfferCount: number;
}

interface CompanyRow {
    id: string;
    name: string;
}

const STATUS_VARIANT: Record<PromotionRow['status'], 'neutral' | 'info' | 'success' | 'warning'> = {
    DRAFT: 'neutral',
    SCHEDULED: 'info',
    LIVE: 'success',
    EXPIRED: 'warning',
};

/**
 * A `YYYY-MM-DD` day key as the Date the picker should SHOW for that day
 * (#2752).
 *
 * Built from the key's PARTS as local midnight, not `new Date(key)` — that
 * parses a bare day key as UTC midnight, which a browser east of the farm's
 * zone renders as the previous day. The operator is in Bulgaria so the
 * difference is theoretical today; building from parts removes the class
 * rather than relying on where they sit.
 *
 * Tolerates a full instant, so a row not yet normalised or a response held in
 * the client cache still opens on the right day.
 */
function dayKeyToPickerDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return isoToDate(v);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * The calendar day the operator picked, read from the picker's LOCAL parts.
 *
 * This replaced `validFrom.toISOString()`, which was the client-side half of
 * #2752: it produced local midnight, so «2 Nov» went to the server as
 * `2026-11-01T22:00:00Z`. The conversion now happens nowhere — the wire
 * carries the day the operator saw, and the server owns what instant labels
 * it.
 */
function pickerDateToDayKey(d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

function isoToDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function PromotionsAdminClient({ tenantSlug }: { tenantSlug: string }) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('admin.promotions');
    const tc = useTranslations('common');
    const buildUrl = useTenantApiUrl();
    const toast = useToast();

    const promos = useTenantSWR<{ promotions: PromotionRow[] }>('/admin/promotions');
    const companies = useTenantSWR<{ companies: CompanyRow[] }>('/admin/companies');
    const rows = promos.data?.promotions ?? [];

    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<PromotionRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<PromotionRow | null>(null);
    const [busy, setBusy] = useState(false);

    // Form state
    const [companyId, setCompanyId] = useState<string | null>(null);
    const [companyName, setCompanyName] = useState<string | null>(null);
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [category, setCategory] = useState<string>('service');
    const [ctaUrl, setCtaUrl] = useState('');
    const [pppRegistrationNo, setPppRegistrationNo] = useState('');

    // «Прочети брошура» (#2664). The read creates NOTHING — it returns a
    // proposal, the operator accepts one into the form, saving writes a DRAFT,
    // and publishing is a third action. That chain is the whole safety
    // argument: a misread price or end date would otherwise be repeated to
    // farmers as fact by the assistant.
    const leafletInputRef = useRef<HTMLInputElement>(null);
    /**
     * The leaflet a draft was read from (#2750), carried from the scan into
     * the write so the source stays reachable from the row it produced.
     *
     * Separate from `scan`, which is cleared the moment a proposal is
     * accepted — the id has to outlive the modal that proposed it.
     */
    const [sourceFileId, setSourceFileId] = useState<string | null>(null);
    const [scanBusy, setScanBusy] = useState(false);
    const [scan, setScan] = useState<LeafletScan | null>(null);
    const [scanError, setScanError] = useState<string | null>(null);
    const [validFrom, setValidFrom] = useState<Date | null>(null);
    const [validTo, setValidTo] = useState<Date | null>(null);
    const [mediaUrl, setMediaUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const companyOptions = useMemo(
        () => (companies.data?.companies ?? []).map((c) => ({ value: c.id, label: c.name })),
        [companies.data],
    );
    const categoryOptions = useMemo(
        () => PROMOTION_CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) })),
        [t],
    );

    const openCreate = () => {
        setEditing(null);
        setCompanyId(null);
        setCompanyName(null);
        setTitle('');
        setBody('');
        setCategory('service');
        setCtaUrl('');
        setPppRegistrationNo('');
        // Typed from scratch, so there is no source document. NOT '' — null is
        // "never read from a leaflet", which the read path tells apart from a
        // source that was held and has since been swept.
        setSourceFileId(null);
        setValidFrom(null);
        setValidTo(null);
        setMediaUrl(null);
        setError(null);
        setOpen(true);
    };

    const openEdit = (row: PromotionRow) => {
        setEditing(row);
        setCompanyId(row.companyId);
        setCompanyName(null);
        setTitle(row.title);
        setBody(row.body ?? '');
        setCategory(row.category);
        setCtaUrl(row.ctaUrl ?? '');
        setPppRegistrationNo(row.pppRegistrationNo ?? '');
        setSourceFileId(row.sourceFileId);
        setValidFrom(dayKeyToPickerDate(row.validFrom));
        setValidTo(dayKeyToPickerDate(row.validTo));
        setMediaUrl(row.mediaUrl);
        setError(null);
        setOpen(true);
    };

    /**
     * Read a leaflet. Multipart, so a raw `fetch` rather than `apiPost` — the
     * same shape `PromotionImageField` uses, and for the same reason: there is
     * no generic upload endpoint in this repo.
     *
     * The refusal shows the SERVER's message, which is this repo's web idiom —
     * `PromotionImageField` does the same three components away, and for the
     * same reason: those sentences distinguish outcomes an operator must act on
     * differently. A 415 means the file is STORED and the offers must be typed
     * in; a 422 means it is stored and was not a leaflet; a 503 means try later
     * or raise a ceiling. A single local string would collapse all three.
     *
     * NOT rendered from the `code` via the `errors` catalogue, deliberately.
     * All five codes have entries there from #2664a — but that namespace holds
     * 329 keys and NOTHING in the web app reads it by key; it is maintained for
     * the native client, which filters non-Cyrillic server prose. Making this
     * its first web consumer is a mechanism change, not a feature, and it does
     * not belong in this PR.
     */
    const runScan = async (file: File) => {
        setScanBusy(true);
        setScanError(null);
        setScan(null);
        try {
            const body = new FormData();
            body.append('file', file);
            const res = await fetch(buildUrl('/admin/promotions/leaflet-scan'), {
                method: 'POST',
                body,
            });
            if (!res.ok) {
                const detail = (await res.json().catch(() => null)) as
                    | { error?: string }
                    | null;
                setScanError(detail?.error ?? t('leafletReadFailed'));
                return;
            }
            setScan((await res.json()) as LeafletScan);
        } catch {
            setScanError(t('leafletReadFailed'));
        } finally {
            setScanBusy(false);
            // So picking the SAME file again re-reads it. Without this a
            // retry after a transient 503 silently does nothing, because the
            // input's value has not changed.
            if (leafletInputRef.current) leafletInputRef.current.value = '';
        }
    };

    /**
     * Carry one proposed offer into the create form. It SAVES NOTHING.
     *
     * `pppRegistrationNo` is deliberately left EMPTY. The reader has no slot
     * for it — held by `promotion-read-proposes-no-ppp-number` — because a
     * misread registration number would silently reclassify a pesticide as a
     * fertiliser, and that is the one error in this feature that matters. The
     * reviewer types it, against the БАБХ register, looking at the leaflet.
     * Prefilling anything here would be the start of that error.
     */
    const acceptOffer = (offer: LeafletOffer) => {
        setEditing(null);
        setCompanyId(null);
        setCompanyName(scan?.companyName ?? null);
        setTitle(offer.productName);
        setBody([offer.priceText, offer.validityText, offer.note].filter(Boolean).join(' — '));
        setCategory('products');
        setCtaUrl('');
        setPppRegistrationNo('');
        // The one thing the read DOES contribute beyond the form fields.
        // Read from `scan` here, before `setScan(null)` below — the state is
        // cleared when the proposals modal closes and the id must survive it.
        setSourceFileId(scan?.fileId ?? null);
        setValidFrom(null);
        setValidTo(null);
        setMediaUrl(null);
        setError(null);
        setScan(null);
        setOpen(true);
    };

    const save = async () => {
        setError(null);
        setBusy(true);
        try {
            // Exactly one of companyId / companyName — a freshly typed supplier
            // is find-or-created server-side.
            const companyRef = companyName ? { companyName } : { companyId: companyId ?? undefined };
            const payload = {
                ...companyRef,
                title: title.trim(),
                body: body.trim() ? body.trim() : null,
                category,
                ctaUrl: ctaUrl.trim() ? ctaUrl.trim() : null,
                // Empty means "not a ПРЗ" and must travel as null, never ''.
                // `normalisePppRegistrationNo` server-side folds it anyway;
                // sending null keeps the two ends agreeing on one spelling.
                pppRegistrationNo: pppRegistrationNo.trim() ? pppRegistrationNo.trim() : null,
                sourceFileId,
                validFrom: validFrom ? pickerDateToDayKey(validFrom) : null,
                validTo: validTo ? pickerDateToDayKey(validTo) : null,
            };
            if (editing) {
                await apiPatch(buildUrl(`/admin/promotions/${editing.id}`), payload);
            } else {
                await apiPost(buildUrl('/admin/promotions'), payload);
            }
            await promos.mutate();
            await companies.mutate();
            setOpen(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const setPublished = async (row: PromotionRow, published: boolean) => {
        try {
            // No `apiPut` helper exists (the client exposes POST/PATCH/DELETE),
            // and publish is deliberately its own verb rather than a PATCH
            // field — so this one call goes over fetch directly.
            const res = await fetch(buildUrl(`/admin/promotions/${row.id}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ published }),
            });
            if (!res.ok) {
                const detail = await res.json().catch(() => null);
                throw new Error(detail?.error ?? t('publishFailed'));
            }
            await promos.mutate();
            toast.success(published ? t('publishedToast') : t('unpublishedToast'));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const doDelete = async (row: PromotionRow) => {
        try {
            await apiDelete(buildUrl(`/admin/promotions/${row.id}`));
            await promos.mutate();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const columns = useMemo(
        () =>
            createColumns<PromotionRow>([
        {
            id: 'title',
            header: t('colTitle'),
            cell: ({ row }) => (
                <div className="min-w-0">
                    <p className="truncate text-sm text-content-default">{row.original.title}</p>
                    <p className="truncate text-sm text-content-muted">{row.original.companyName}</p>
                </div>
            ),
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            id: 'status',
            header: t('colStatus'),
            cell: ({ row }) => (
                <StatusBadge variant={STATUS_VARIANT[row.original.status]} size="sm">
                    {t(`status.${row.original.status}`)}
                </StatusBadge>
            ),
            meta: { mobileCard: { slot: 'status', label: t('colStatus') } },
        },
        {
            id: 'window',
            header: t('colWindow'),
            accessorFn: (p) =>
                [
                    p.validFrom ? formatDate(p.validFrom) : '—',
                    p.validTo ? formatDate(p.validTo) : '—',
                ].join(' → '),
            meta: { mobileCard: { slot: 'meta', label: t('colWindow') } },
        },
        {
            id: 'leads',
            header: t('colLeads'),
            accessorFn: (p) => String(p.leadCount),
            meta: { mobileCard: { slot: 'meta', label: t('colLeads') } },
        },
        {
            id: 'actions',
            header: t('colActions'),
            cell: ({ row }) => (
                <div className="flex justify-end gap-tight">
                    <Button
                        variant="secondary"
                        size="xs"
                        id={`edit-promo-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            openEdit(row.original);
                        }}
                    >
                        {tc('edit')}
                    </Button>
                    <Button
                        variant="secondary"
                        size="xs"
                        id={`publish-promo-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            void setPublished(row.original, !row.original.publishedAt);
                        }}
                    >
                        {row.original.publishedAt ? t('unpublish') : t('publish')}
                    </Button>
                    <Button
                        variant="destructive-outline"
                        size="xs"
                        id={`delete-promo-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(row.original);
                        }}
                    >
                        {tc('delete')}
                    </Button>
                </div>
            ),
            meta: { mobileCard: { slot: 'actions' as const } },
        },
            ]),
        // `t` is stable per render pass; the row-action closures read state
        // through setters, so the defs don't need to churn on every keystroke
        // in the modal.
        [t, tc, formatDate],
    );

    const heading = editing ? t('editTitle') : t('newTitle');

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('breadcrumbAdmin'), href: `/t/${tenantSlug}/admin` },
                                { label: t('title') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t('title')}</Heading>
                        <p className="text-sm text-content-muted">{t('description')}</p>
                    </div>
                    <div className="flex items-center gap-default">
                        {/*
                          * «Прочети брошура» (#2664). The read route shipped in
                          * #2709 with ZERO client callers — built, gated,
                          * tested, in the spec, and unreachable. This is the
                          * half that makes it a feature.
                          */}
                        <input
                            ref={leafletInputRef}
                            type="file"
                            accept="application/pdf,image/*,.xlsx,.xls"
                            className="hidden"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) void runScan(f);
                            }}
                        />
                        <Button
                            variant="secondary"
                            icon={<ScanText />}
                            disabled={scanBusy}
                            onClick={() => leafletInputRef.current?.click()}
                            id="read-leaflet-btn"
                        >
                            {scanBusy ? t('leafletReading') : t('leafletRead')}
                        </Button>
                        <Button
                            variant="primary"
                            icon={<Plus />}
                            onClick={openCreate}
                            id="new-promotion-btn"
                        >
                            {t('entity')}
                        </Button>
                    </div>
                </div>
                {scanError && (
                    <InlineNotice
                        variant="error"
                        id="leaflet-scan-error"
                        onDismiss={() => setScanError(null)}
                    >
                        {scanError}
                    </InlineNotice>
                )}
            </ListPageShell.Header>

            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data-testid="promotions-table"
                    data={rows}
                    columns={columns}
                    getRowId={(p: PromotionRow) => p.id}
                    loading={promos.isLoading && !promos.data}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('emptyTitle')}
                            description={t('emptyDescription')}
                        />
                    }
                />
            </ListPageShell.Body>

            <Modal
                showModal={open}
                setShowModal={setOpen}
                size="lg"
                title={heading}
                description={t('formDescription')}
                preventDefaultClose={busy}
            >
                <Modal.Header title={heading} description={t('formDescription')} />
                <Modal.Body>
                    <div className="space-y-default">
                        {error && (
                            <p role="alert" className="text-sm text-content-error">
                                {error}
                            </p>
                        )}

                        <FormField label={t('fieldCompany')}>
                            <Combobox
                                id="promo-company"
                                options={companyOptions}
                                selected={
                                    companyName
                                        ? { value: '__new__', label: companyName }
                                        : (companyOptions.find((o) => o.value === companyId) ?? null)
                                }
                                setSelected={(o) => {
                                    setCompanyId(o?.value ?? null);
                                    setCompanyName(null);
                                }}
                                placeholder={t('companyPlaceholder')}
                                searchPlaceholder={t('companySearchPlaceholder')}
                                matchTriggerWidth
                                // Support types a supplier that isn't on file yet;
                                // the server find-or-creates it on save.
                                onCreate={async (search) => {
                                    const v = search.trim();
                                    if (!v) return false;
                                    setCompanyName(v);
                                    setCompanyId(null);
                                    return true;
                                }}
                                createLabel={(search) =>
                                    t('companyCreate', { search: search.trim() })
                                }
                            />
                        </FormField>

                        <FormField label={t('fieldTitle')}>
                            <Input
                                id="promo-title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                            />
                        </FormField>

                        <FormField label={t('fieldBody')}>
                            <Textarea
                                id="promo-body"
                                rows={3}
                                value={body}
                                onChange={(e) => setBody(e.target.value)}
                            />
                        </FormField>

                        <FormField label={t('fieldCategory')}>
                            <Combobox
                                id="promo-category"
                                options={categoryOptions}
                                selected={categoryOptions.find((o) => o.value === category) ?? null}
                                setSelected={(o) => setCategory(o?.value ?? 'service')}
                                matchTriggerWidth
                            />
                        </FormField>

                        <FormField label={t('fieldCtaUrl')}>
                            <Input
                                id="promo-cta"
                                value={ctaUrl}
                                onChange={(e) => setCtaUrl(e.target.value)}
                                placeholder={t('urlPlaceholder')}
                            />
                        </FormField>

                        {/*
                          * The review-time ПРЗ classification (#2664). Typed by
                          * the reviewer and deliberately never prefilled from a
                          * leaflet read: a misread registration number would
                          * silently reclassify a pesticide as a fertiliser.
                          */}
                        <FormField
                            label={t('fieldPppRegistrationNo')}
                            description={t('pppRegistrationNoDesc')}
                        >
                            <Input
                                id="promo-ppp-no"
                                value={pppRegistrationNo}
                                onChange={(e) => setPppRegistrationNo(e.target.value)}
                                placeholder={t('pppPlaceholder')}
                            />
                        </FormField>

                        {/*
                          * «Виж брошурата» (#2750). Shown only when a source is
                          * recorded, because it is the artefact that answers
                          * "where did this text come from?" while the reviewer
                          * is typing the ПРЗ number above against it.
                          *
                          * A plain link rather than a fetch: the response is
                          * bytes with `Content-Disposition: inline`, so the
                          * browser previews a PDF or an image itself. A
                          * swept source answers 404 with
                          * `PROMOTION_SOURCE_NOT_HELD` — handled by the browser
                          * rather than swallowed here, which keeps "it WAS read
                          * and the file is gone" visible instead of silent.
                          */}
                        {sourceFileId ? (
                            <p className="text-sm">
                                <a
                                    id="promo-open-source"
                                    className="text-content-link underline"
                                    href={buildUrl(`/admin/promotions/${editing?.id ?? ''}/source`)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    {t('openLeaflet')}
                                </a>
                            </p>
                        ) : null}

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('fieldValidFrom')}>
                                <DatePicker
                                    id="promo-valid-from"
                                    value={validFrom}
                                    onChange={setValidFrom}
                                />
                            </FormField>
                            <FormField label={t('fieldValidTo')}>
                                <DatePicker
                                    id="promo-valid-to"
                                    value={validTo}
                                    onChange={setValidTo}
                                />
                            </FormField>
                        </div>

                        <FormField label={t('fieldImage')}>
                            {/*
                              * Artwork attaches to a SAVED promotion — the storage
                              * key is derived from its id, which does not exist
                              * until the draft is created. Saying so beats a
                              * disabled practice with no explanation.
                              */}
                            <PromotionImageField
                                promotionId={editing?.id ?? null}
                                mediaUrl={mediaUrl}
                                onChange={(url) => {
                                    setMediaUrl(url);
                                    void promos.mutate();
                                }}
                            />
                        </FormField>

                        {!editing && (
                            <p className="text-xs text-content-muted">{t('createsDraftHint')}</p>
                        )}
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setOpen(false)}
                        disabled={busy}
                    >
                        {tc('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        id="save-promotion-btn"
                        loading={busy}
                        disabled={!title.trim() || (!companyId && !companyName)}
                        onClick={() => void save()}
                    >
                        {editing ? t('saveChanges') : t('createDraft')}
                    </Button>
                </Modal.Actions>
            </Modal>

            {/*
              * The PROPOSAL, which is not a promotion. Accepting one fills the
              * form; saving writes a DRAFT; publishing is a third action. The
              * modal says so, because an operator who thinks this created
              * something will not look for the draft.
              */}
            <Modal
                showModal={scan !== null}
                setShowModal={(v) => {
                    if (!v) setScan(null);
                }}
                className="max-w-2xl"
            >
                <Modal.Header
                    title={t('leafletProposalTitle')}
                    description={t('leafletProposalDescription')}
                />
                <Modal.Body>
                    <div className="space-y-default">
                        {scan?.companyName && (
                            <p className="text-sm text-content-muted">
                                {t('leafletCompanyRead', { company: scan.companyName })}
                            </p>
                        )}

                        {/*
                          * SURFACED, not swallowed. The read reports offers it
                          * SAW and could not parse, because a six-offer leaflet
                          * read as four is otherwise indistinguishable from a
                          * four-offer leaflet — and the operator is the only
                          * one who can open the file and check.
                          */}
                        {!!scan?.unreadableOfferCount && (
                            <InlineNotice variant="warning" id="leaflet-unreadable">
                                {t('leafletUnreadable', { count: scan.unreadableOfferCount })}
                            </InlineNotice>
                        )}

                        {scan?.offers.length === 0 ? (
                            <p className="text-sm text-content-muted">{t('leafletNoOffers')}</p>
                        ) : (
                            <ul className="space-y-compact">
                                {scan?.offers.map((offer, i) => (
                                    <li
                                        key={`${offer.productName}-${i}`}
                                        className="flex items-start justify-between gap-default rounded-md border border-border-subtle p-default"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate font-[560]">{offer.productName}</p>
                                            {offer.priceText && (
                                                <p className="text-sm text-content-muted">{offer.priceText}</p>
                                            )}
                                            {offer.validityText && (
                                                <p className="text-xs text-content-muted">{offer.validityText}</p>
                                            )}
                                            {offer.note && (
                                                <p className="text-xs text-content-muted">{offer.note}</p>
                                            )}
                                        </div>
                                        <Button
                                            variant="secondary"
                                            size="xs"
                                            id={`accept-offer-${i}`}
                                            onClick={() => acceptOffer(offer)}
                                        >
                                            {t('leafletAccept')}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </Modal.Body>
            </Modal>

            <ConfirmDialog
                showModal={deleteTarget !== null}
                setShowModal={(v) => {
                    if (!v) setDeleteTarget(null);
                }}
                tone="danger"
                title={t('deleteTitle')}
                description={t('deleteDescription', { title: deleteTarget?.title ?? '' })}
                confirmLabel={t('deleteConfirm')}
                onConfirm={async () => {
                    if (deleteTarget) await doDelete(deleteTarget);
                    setDeleteTarget(null);
                }}
            />
        </ListPageShell>
    );
}

export default PromotionsAdminClient;
