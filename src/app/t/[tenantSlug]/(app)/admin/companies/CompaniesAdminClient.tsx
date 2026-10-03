'use client';

/**
 * Supplier catalogue — the support console (#12).
 *
 * Suppliers are created implicitly from the promotions form (type a name that
 * isn't on file and it is find-or-created), so this page is deliberately
 * edit-only: its job is holding the CONTACT details the lead digest sends to,
 * which the promotions form has no business collecting.
 *
 * This is the one surface in the product that renders decrypted supplier
 * contact PII. It is reachable only inside the platform tenant.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPatch } from '@/lib/api-client';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';

interface CompanyRow {
    id: string;
    name: string;
    eik: string | null;
    websiteUrl: string | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    notes: string | null;
    promotionCount: number;
}

export function CompaniesAdminClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('admin.companies');
    const tc = useTranslations('common');
    const buildUrl = useTenantApiUrl();

    const q = useTenantSWR<{ companies: CompanyRow[] }>('/admin/companies');
    const rows = q.data?.companies ?? [];

    const [editing, setEditing] = useState<CompanyRow | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState<Partial<CompanyRow>>({});

    const openEdit = (row: CompanyRow) => {
        setEditing(row);
        setForm({
            name: row.name,
            eik: row.eik,
            websiteUrl: row.websiteUrl,
            contactName: row.contactName,
            contactEmail: row.contactEmail,
            contactPhone: row.contactPhone,
            notes: row.notes,
        });
        setError(null);
    };

    const field = (k: keyof CompanyRow) => (v: string) =>
        setForm((f) => ({ ...f, [k]: v.trim() === '' ? null : v }));

    const save = async () => {
        if (!editing) return;
        setBusy(true);
        setError(null);
        try {
            await apiPatch(buildUrl(`/admin/companies/${editing.id}`), form);
            await q.mutate();
            setEditing(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const columns = useMemo(
        () =>
            createColumns<CompanyRow>([
        {
            id: 'name',
            header: t('colName'),
            cell: ({ row }) => (
                <span className="text-sm text-content-default">{row.original.name}</span>
            ),
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            id: 'contact',
            header: t('colContact'),
            // The digest can't run without this, so an empty cell is a task,
            // not just a blank — say so rather than rendering a dash.
            cell: ({ row }) =>
                row.original.contactEmail ? (
                    <span className="text-sm text-content-muted">{row.original.contactEmail}</span>
                ) : (
                    <span className="text-sm text-content-warning">{t('noContact')}</span>
                ),
            meta: { mobileCard: { slot: 'meta', label: t('colContact') } },
        },
        {
            id: 'promotions',
            header: t('colPromotions'),
            accessorFn: (c) => String(c.promotionCount),
            meta: { mobileCard: { slot: 'meta', label: t('colPromotions') } },
        },
        {
            id: 'actions',
            header: t('colActions'),
            cell: ({ row }) => (
                <div className="flex justify-end">
                    <Button
                        variant="secondary"
                        size="xs"
                        id={`edit-company-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            openEdit(row.original);
                        }}
                    >
                        {tc('edit')}
                    </Button>
                </div>
            ),
            meta: { mobileCard: { slot: 'actions' as const } },
        },
            ]),
        [t, tc],
    );

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
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
            </ListPageShell.Header>

            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data-testid="companies-table"
                    data={rows}
                    columns={columns}
                    getRowId={(c: CompanyRow) => c.id}
                    loading={q.isLoading && !q.data}
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
                showModal={editing !== null}
                setShowModal={(v) => {
                    if (!v) setEditing(null);
                }}
                size="lg"
                title={t('editTitle')}
                description={t('editDescription')}
                preventDefaultClose={busy}
            >
                <Modal.Header title={t('editTitle')} description={t('editDescription')} />
                <Modal.Body>
                    <div className="space-y-default">
                        {error && (
                            <p role="alert" className="text-sm text-content-error">
                                {error}
                            </p>
                        )}
                        <FormField label={t('fieldName')}>
                            <Input
                                id="company-name"
                                value={form.name ?? ''}
                                onChange={(e) => field('name')(e.target.value)}
                            />
                        </FormField>
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('fieldEik')}>
                                <Input
                                    id="company-eik"
                                    value={form.eik ?? ''}
                                    onChange={(e) => field('eik')(e.target.value)}
                                />
                            </FormField>
                            <FormField label={t('fieldWebsite')}>
                                <Input
                                    id="company-website"
                                    value={form.websiteUrl ?? ''}
                                    onChange={(e) => field('websiteUrl')(e.target.value)}
                                    placeholder={t('urlPlaceholder')}
                                />
                            </FormField>
                        </div>

                        <p className="text-xs text-content-muted">{t('contactHint')}</p>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            <FormField label={t('fieldContactName')}>
                                <Input
                                    id="company-contact-name"
                                    value={form.contactName ?? ''}
                                    onChange={(e) => field('contactName')(e.target.value)}
                                />
                            </FormField>
                            <FormField label={t('fieldContactEmail')}>
                                <Input
                                    id="company-contact-email"
                                    type="email"
                                    value={form.contactEmail ?? ''}
                                    onChange={(e) => field('contactEmail')(e.target.value)}
                                />
                            </FormField>
                        </div>
                        <FormField label={t('fieldContactPhone')}>
                            <Input
                                id="company-contact-phone"
                                value={form.contactPhone ?? ''}
                                onChange={(e) => field('contactPhone')(e.target.value)}
                            />
                        </FormField>
                        <FormField label={t('fieldNotes')}>
                            <Textarea
                                id="company-notes"
                                rows={3}
                                value={form.notes ?? ''}
                                onChange={(e) => field('notes')(e.target.value)}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditing(null)}
                        disabled={busy}
                    >
                        {tc('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        id="save-company-btn"
                        loading={busy}
                        onClick={() => void save()}
                    >
                        {tc('save')}
                    </Button>
                </Modal.Actions>
            </Modal>
        </ListPageShell>
    );
}

export default CompaniesAdminClient;
