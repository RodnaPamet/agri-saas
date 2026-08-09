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
import { useMemo, useState } from 'react';
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
import { Plus } from '@/components/ui/icons/nucleo';
import { useToast } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
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
    publishedAt: string | null;
    validFrom: string | null;
    validTo: string | null;
    status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED';
    leadCount: number;
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

function isoToDate(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function PromotionsAdminClient({ tenantSlug }: { tenantSlug: string }) {
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
        setValidFrom(isoToDate(row.validFrom));
        setValidTo(isoToDate(row.validTo));
        setMediaUrl(row.mediaUrl);
        setError(null);
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
                validFrom: validFrom ? validFrom.toISOString() : null,
                validTo: validTo ? validTo.toISOString() : null,
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
        [t, tc],
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
                        <p className="text-sm text-content-secondary">{t('description')}</p>
                    </div>
                    <Button
                        variant="primary"
                        icon={<Plus />}
                        onClick={openCreate}
                        id="new-promotion-btn"
                    >
                        {t('entity')}
                    </Button>
                </div>
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
                            <p role="alert" className="text-sm text-content-danger">
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
