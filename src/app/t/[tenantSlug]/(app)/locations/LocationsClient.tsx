'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { Fab } from '@/components/ui/fab';
import { PullToRefresh } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { Plus } from '@/components/ui/icons/nucleo';

interface LocationItem {
    id: string;
    name: string;
    description?: string | null;
    status: string;
    _count?: { parcels?: number };
}

export function LocationsClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('locations');
    const tCommon = useTranslations('common');
    const buildUrl = useTenantApiUrl();
    const prefetchData = usePrefetchTenant();
    const router = useRouter();
    // FIELD-kind only. A Location row is a growing field OR a grain bin/store
    // depending on `kind`, and this page's columns describe fields — a bin
    // rendered here shows "0 parcels" and a Status that does not apply to it.
    // Bins have their own page (/grain/bins) with capacity and fill.
    const { data, mutate, isLoading } = useTenantSWR<LocationItem[]>(
        '/locations?kind=FIELD',
    );

    const [showNew, setShowNew] = useState(false);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await apiPost(buildUrl('/locations'), { name });
            setShowNew(false);
            setName('');
            await mutate();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create location');
        } finally {
            setBusy(false);
        }
    };

    const columns = useMemo(
        () => createColumns<LocationItem>([
            {
                accessorKey: 'name',
                header: t('colName'),
                cell: ({ row }) => (
                    // The whole row is clickable (onRowClick), but the name
                    // stays a real <Link> so keyboard/focus users can Tab to it
                    // and Enter to open. stopPropagation avoids a double-trigger
                    // when a pointer user clicks the link itself.
                    <Link
                        href={`/t/${tenantSlug}/locations/${row.original.id}`}
                        className="font-medium text-content-link hover:underline"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {row.original.name}
                    </Link>
                ),
                meta: { mobileCard: { slot: 'title' } },
            },
            { accessorKey: 'status', header: t('colStatus'), meta: { mobileCard: { slot: 'status', label: t('colStatus') } } },
            {
                id: 'parcels',
                header: t('colParcels'),
                cell: ({ row }) => row.original._count?.parcels ?? 0,
                meta: { mobileCard: { slot: 'meta', label: t('colParcels') } },
            },
        ]),
        [tenantSlug, t],
    );

    const rows = data ?? [];

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('bcDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t('bcLocations') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t('title')}</Heading>
                        <p className="text-sm text-content-secondary">{t('description')}</p>
                    </div>
                    <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>{t('newLocation')}</Button>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data-testid="locations-table"
                    data={rows}
                    columns={columns}
                    loading={isLoading && !data}
                    getRowId={(l) => l.id}
                    // Hover-warm the detail SWR cache (the row's title Link
                    // already prefetches the route) so list→detail is instant.
                    onRowPrefetch={(row) => prefetchData(`/locations/${row.original.id}`)}
                    // Single click anywhere on a row opens the location — no
                    // selection checkboxes. The name cell keeps its own <Link>
                    // (keyboard path); the row handler is the pointer path.
                    onRowClick={(row) => router.push(`/t/${tenantSlug}/locations/${row.original.id}`)}
                    emptyState={(
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('emptyTitle')}
                            description={t('emptyDesc')}
                            primaryAction={{ label: t('newLocation'), onClick: () => setShowNew(true) }}
                        />
                    )}
                />
            </ListPageShell.Body>

            <Modal showModal={showNew} setShowModal={setShowNew} size="md" title={t('modalTitle')} description={t('modalDescription')}>
                <Modal.Header title={t('modalTitle')} description={t('modalHeaderDescription')} />
                <Modal.Form id="new-location-form" onSubmit={create}>
                    <Modal.Body>
                        {error && (
                            <div role="alert" className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error">
                                {error}
                            </div>
                        )}
                        <FormField label={t('fieldName')} required>
                            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fieldNamePlaceholder')} />
                        </FormField>
                    </Modal.Body>
                    <Modal.Actions>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setShowNew(false)}>{tCommon('cancel')}</Button>
                        <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!name || busy}>{tCommon('create')}</Button>
                    </Modal.Actions>
                </Modal.Form>
            </Modal>

            {/* Mobile-only pull-to-refresh + scroll-to-top affordances. */}
            <PullToRefresh onRefresh={() => mutate()} />
            <ScrollToTop />

            {/* Mobile-only FAB — the primary create action in the thumb
                zone (md:hidden; the header button is the desktop affordance). */}
            <Fab
                onClick={() => setShowNew(true)}
                label={t('fabLabel')}
                icon={<Plus aria-hidden className="h-6 w-6" />}
            />
        </ListPageShell>
    );
}
