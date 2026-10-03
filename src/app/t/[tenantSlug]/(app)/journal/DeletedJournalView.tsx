'use client';

/**
 * DeletedJournalView — the journal Trash. Reached in-page from the ADMIN-only
 * toggle on the journal list (no new navbar entry), it lists soft-deleted
 * entries and offers Restore + a typed-confirm permanent purge, wiring the
 * previously caller-less restore/purge routes.
 *
 * Structurally this mirrors `assets/DeletedAssetsView`, but the data layer is
 * `useTenantSWR` rather than react-query: the whole journal tree is on SWR, and
 * copying the assets version verbatim would drag a second data library into it
 * for one screen.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';
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
import { LOG_ENTRY_TYPE_LABELS } from './filter-defs';

interface DeletedEntryRow {
    id: string;
    title: string;
    type: string;
    occurredAt: string;
    deletedAt: string | null;
}

/** Typed-confirm purge — the operator types the entry title to arm it. */
function PurgeEntryDialog({
    entry,
    open,
    setOpen,
    onPurge,
}: {
    entry: { id: string; title: string } | null;
    open: boolean;
    setOpen: (v: boolean) => void;
    onPurge: (id: string) => Promise<void>;
}) {
    const t = useTranslations('journal.trash');
    const tc = useTranslations('common');
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const title = entry?.title ?? '';
    const armed = typed.trim() === title && title.length > 0;

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
                <FormField label={t('purgeTypePrompt', { name: title })}>
                    <Input
                        id="journal-purge-confirm-input"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        autoComplete="off"
                    />
                </FormField>
            </Modal.Body>
            <Modal.Actions>
                <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
                    {tc('cancel')}
                </Button>
                <Button
                    variant="destructive"
                    size="sm"
                    id="journal-purge-confirm-btn"
                    disabled={!armed || busy}
                    onClick={async () => {
                        if (!entry) return;
                        setBusy(true);
                        try {
                            await onPurge(entry.id);
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

export function DeletedJournalView({
    tenantSlug,
    onBack,
}: {
    tenantSlug: string;
    onBack: () => void;
}) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('journal.trash');
    const te = useTranslations('journalEnums');
    const buildUrl = useTenantApiUrl();
    const [purgeTarget, setPurgeTarget] = useState<{ id: string; title: string } | null>(null);
    const [purgeOpen, setPurgeOpen] = useState(false);

    const q = useTenantSWR<{ entries: DeletedEntryRow[] }>('/journal?deleted=true');
    const rows = q.data?.entries ?? [];

    const restore = async (id: string) => {
        await apiPost(buildUrl(`/journal/${id}/restore`), {});
        await q.mutate();
    };
    const purge = async (id: string) => {
        await apiPost(buildUrl(`/journal/${id}/purge`), {});
        await q.mutate();
    };

    const columns = createColumns<DeletedEntryRow>([
        {
            id: 'title',
            header: t('colTitle'),
            cell: ({ row }) => <span className="text-sm text-content-default">{row.original.title}</span>,
            meta: { mobileCard: { slot: 'title' } },
        },
        {
            id: 'type',
            header: t('colType'),
            cell: ({ row }) => (
                <StatusBadge variant="info" size="sm">
                    {row.original.type in LOG_ENTRY_TYPE_LABELS
                        ? te(`logType.${row.original.type}`)
                        : String(row.original.type).replace(/_/g, ' ')}
                </StatusBadge>
            ),
            meta: { mobileCard: { slot: 'status', label: t('colType') } },
        },
        {
            id: 'occurredAt',
            header: t('colOccurred'),
            accessorFn: (e) => (e.occurredAt ? formatDate(e.occurredAt) : '—'),
            meta: { mobileCard: { slot: 'meta', label: t('colOccurred') } },
        },
        {
            id: 'deletedAt',
            header: t('colDeletedAt'),
            accessorFn: (e) => (e.deletedAt ? formatDate(e.deletedAt) : '—'),
            meta: { mobileCard: { slot: 'meta', label: t('colDeletedAt') } },
        },
        {
            id: 'actions',
            header: t('colActions'),
            cell: ({ row }) => (
                <div className="flex justify-end gap-tight">
                    <Button
                        variant="secondary"
                        size="xs"
                        id={`restore-entry-${row.original.id}`}
                        onClick={(e) => { e.stopPropagation(); void restore(row.original.id); }}
                    >
                        {t('restore')}
                    </Button>
                    <Button
                        variant="destructive-outline"
                        size="xs"
                        id={`purge-entry-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setPurgeTarget({ id: row.original.id, title: row.original.title });
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
                                { label: t('breadcrumbJournal'), href: `/t/${tenantSlug}/journal` },
                                { label: t('title') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1}>{t('title')}</Heading>
                    </div>
                    <Button
                        variant="secondary"
                        icon={<ChevronLeft className="size-4" />}
                        onClick={onBack}
                        id="back-to-journal-btn"
                    >
                        {t('backToJournal')}
                    </Button>
                </div>
            </ListPageShell.Header>

            <ListPageShell.Body>
                <DataTable
                    fillBody
                    mobileFallback="card"
                    data={rows}
                    columns={columns}
                    getRowId={(e: DeletedEntryRow) => e.id}
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

            <PurgeEntryDialog
                entry={purgeTarget}
                open={purgeOpen}
                setOpen={setPurgeOpen}
                onPurge={purge}
            />
        </ListPageShell>
    );
}

export default DeletedJournalView;
