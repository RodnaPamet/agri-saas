'use client';

/**
 * B2 — the assets Trash surface. Reached in-page from the assets list via
 * the ADMIN-only "Deleted" toggle (no new navbar entry). Lists soft-deleted
 * assets (via the existing `?includeDeleted=true` ADMIN route, filtered to
 * rows that actually carry a `deletedAt`) and offers Restore + a
 * typed-confirm permanent purge. All actions are ADMIN-gated at the route +
 * usecase layer; this view is only mounted for `canAdmin`.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { ChevronLeft } from '@/components/ui/icons/nucleo';
import { useDateFormat } from '@/lib/i18n/use-date-format';

interface DeletedAssetsViewProps {
    tenantSlug: string;
    onBack: () => void;
}

interface DeletedAssetRow {
    id: string;
    name: string;
    type: string;
    owner: string | null;
    ownerUser: { name: string | null } | null;
    deletedAt: string | null;
}

/** Typed-confirm permanent-delete dialog — the operator must type the asset's
 * name to enable the destructive button (cascading, irreversible). */
function PurgeAssetDialog({
    asset,
    open,
    setOpen,
    onPurge,
}: {
    asset: { id: string; name: string } | null;
    open: boolean;
    setOpen: (v: boolean) => void;
    onPurge: (id: string) => Promise<void>;
}) {
    const t = useTranslations('assets');
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const name = asset?.name ?? '';
    const armed = typed.trim() === name && name.length > 0;

    const close = () => {
        if (busy) return;
        setTyped('');
        setOpen(false);
    };

    return (
        <Modal
            showModal={open}
            setShowModal={(v) => (v ? setOpen(true) : close())}
            size="sm"
            title={t('purgeTitle')}
            description={t('purgeDescription')}
        >
            <Modal.Header title={t('purgeTitle')} description={t('purgeDescription')} />
            <Modal.Body>
                <FormField label={t('purgeTypePrompt', { name })}>
                    <Input
                        id="purge-confirm-input"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        autoComplete="off"
                    />
                </FormField>
            </Modal.Body>
            <Modal.Actions>
                <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
                    {t('cancel')}
                </Button>
                <Button
                    variant="destructive"
                    size="sm"
                    id="purge-confirm-btn"
                    disabled={!armed || busy}
                    onClick={async () => {
                        if (!asset) return;
                        setBusy(true);
                        try {
                            await onPurge(asset.id);
                            setTyped('');
                            setOpen(false);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {t('deletePermanently')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}

export function DeletedAssetsView({ tenantSlug, onBack }: DeletedAssetsViewProps) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('assets');
    const queryClient = useQueryClient();
    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
    const [purgeOpen, setPurgeOpen] = useState(false);

    const deletedQuery = useQuery({
        queryKey: queryKeys.assets.list(tenantSlug, { includeDeleted: 'true' }),
        queryFn: async (): Promise<DeletedAssetRow[]> => {
            const res = await fetch(apiUrl('/assets?includeDeleted=true'));
            if (!res.ok) throw new Error('Failed to fetch deleted assets');
            return res.json();
        },
    });
    const rows: DeletedAssetRow[] = (deletedQuery.data ?? []).filter((a) => a.deletedAt);

    const refetchAll = async () => {
        await deletedQuery.refetch();
        // The active list's counts change on restore.
        queryClient.invalidateQueries({ queryKey: queryKeys.assets.all(tenantSlug) });
    };

    const restore = async (id: string) => {
        const res = await fetch(apiUrl(`/assets/${id}/restore`), { method: 'POST' });
        if (res.ok) await refetchAll();
    };

    const purge = async (id: string) => {
        const res = await fetch(apiUrl(`/assets/${id}/purge`), { method: 'POST' });
        if (res.ok) await refetchAll();
    };

    const columns = createColumns<DeletedAssetRow>([
        {
            id: 'name',
            header: t('name'),
            cell: ({ row }) => <span className="text-sm text-content-default">{row.original.name}</span>,
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            id: 'type',
            header: t('type'),
            cell: ({ row }) => <StatusBadge variant="info" size="sm">{String(row.original.type).replace(/_/g, ' ')}</StatusBadge>,
            meta: { mobileCard: { slot: 'status', label: t('type') } },
        },
        {
            id: 'keeper',
            header: t('keeper'),
            accessorFn: (a) => a.ownerUser?.name || a.owner || '—',
            meta: { mobileCard: { slot: 'meta', label: t('keeper') } },
        },
        {
            id: 'deletedAt',
            header: t('colDeletedAt'),
            accessorFn: (a) => (a.deletedAt ? formatDate(a.deletedAt) : '—'),
            meta: { mobileCard: { slot: 'meta', label: t('colDeletedAt') } },
        },
        {
            id: 'actions',
            header: t('colActions'),
            cell: ({ row }) => (
                <div className="flex gap-tight justify-end">
                    <Button
                        variant="secondary"
                        size="xs"
                        id={`restore-asset-${row.original.id}`}
                        onClick={(e) => { e.stopPropagation(); void restore(row.original.id); }}
                    >
                        {t('restore')}
                    </Button>
                    <Button
                        variant="destructive-outline"
                        size="xs"
                        id={`purge-asset-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setPurgeTarget({ id: row.original.id, name: row.original.name });
                            setPurgeOpen(true);
                        }}
                    >
                        {t('deletePermanently')}
                    </Button>
                </div>
            ),
            meta: { mobileCard: { slot: 'actions' as const } },
        },
    ]);

    return (
        <ListPageShell className="gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                                { label: t('title'), href: `/t/${tenantSlug}/assets` },
                                { label: t('trashTitle') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t('trashTitle')}</Heading>
                    </div>
                    <Button variant="secondary" icon={<ChevronLeft className="size-4" />} onClick={onBack} id="back-to-assets-btn">
                        {t('backToAssets')}
                    </Button>
                </div>
            </ListPageShell.Header>

            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data={rows}
                    columns={columns}
                    getRowId={(a: DeletedAssetRow) => a.id}
                    emptyState={
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('trashEmptyTitle')}
                            description={t('trashEmptyDescription')}
                        />
                    }
                    resourceName={(p) => (p ? t('assetPlural') : t('assetSingular'))}
                />
            </ListPageShell.Body>

            <PurgeAssetDialog asset={purgeTarget} open={purgeOpen} setOpen={setPurgeOpen} onPurge={purge} />
        </ListPageShell>
    );
}
