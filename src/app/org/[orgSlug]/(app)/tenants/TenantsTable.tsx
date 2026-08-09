'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, Plus, Trash2 } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useOrgPermissions } from '@/lib/org-context-provider';
import type { TenantHealthRow, RagBadge } from '@/app-layer/schemas/portfolio';
import { Heading } from '@/components/ui/typography';

interface Props {
    rows: TenantHealthRow[];
    orgSlug: string;
}

const RAG_RANK: Record<RagBadge | 'PENDING', number> = {
    RED: 0,
    AMBER: 1,
    GREEN: 2,
    PENDING: 3,
};

function formatPercent(value: number | null): string {
    return value === null ? '—' : `${value.toFixed(1)}%`;
}

function RagPill({ rag }: { rag: RagBadge | null }) {
    const t = useTranslations('org.tenants');
    if (rag === null) {
        return <StatusBadge variant="neutral">{t('pending')}</StatusBadge>;
    }
    const variant = rag === 'GREEN' ? 'success' : rag === 'AMBER' ? 'warning' : 'error';
    return <StatusBadge variant={variant}>{rag}</StatusBadge>;
}

export function TenantsTable({ rows, orgSlug }: Props) {
    const perms = useOrgPermissions();
    const router = useRouter();
    const t = useTranslations('org.tenants');
    const [sortBy, setSortBy] = useState<string>('rag');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

    // Remove-tenant flow — a typed-confirmation modal (the sanctioned
    // pattern for top-level entity deletion; NOT the undo-toast). The
    // tenant is soft-deleted server-side: it disappears from this list
    // and becomes inaccessible, but its data is retained.
    const [deleteTarget, setDeleteTarget] = useState<TenantHealthRow | null>(
        null,
    );
    const [confirmText, setConfirmText] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const closeDelete = () => {
        setDeleteTarget(null);
        setConfirmText('');
        setDeleting(false);
        setDeleteError(null);
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            const res = await fetch(
                `/api/org/${orgSlug}/tenants/${deleteTarget.tenantId}`,
                { method: 'DELETE', credentials: 'same-origin' },
            );
            if (!res.ok) {
                let message = t('removeFailed', { status: res.status });
                try {
                    const body = (await res.json()) as {
                        error?: { message?: string };
                    };
                    if (body?.error?.message) message = body.error.message;
                } catch {
                    /* not JSON */
                }
                setDeleteError(message);
                setDeleting(false);
                return;
            }
            closeDelete();
            // The deleted tenant is now filtered out of the portfolio
            // query — re-render the server component to drop the row.
            router.refresh();
        } catch (err) {
            setDeleteError(
                err instanceof Error
                    ? err.message
                    : 'Unexpected error removing tenant.',
            );
            setDeleting(false);
        }
    };

    const sorted = useMemo(() => {
        const copy = [...rows];
        copy.sort((a, b) => {
            const dir = sortOrder === 'asc' ? 1 : -1;
            switch (sortBy) {
                case 'name':
                    return dir * a.name.localeCompare(b.name);
                case 'coverage':
                    return dir * ((a.coveragePercent ?? -1) - (b.coveragePercent ?? -1));
                case 'overdueEvidence':
                    return dir * ((a.overdueEvidence ?? -1) - (b.overdueEvidence ?? -1));
                case 'rag':
                default: {
                    const ra = RAG_RANK[a.rag ?? 'PENDING'];
                    const rb = RAG_RANK[b.rag ?? 'PENDING'];
                    if (ra !== rb) return dir * (ra - rb);
                    return a.name.localeCompare(b.name);
                }
            }
        });
        return copy;
    }, [rows, sortBy, sortOrder]);

    const columns = useMemo(
        () =>
            createColumns<TenantHealthRow>([
                {
                    id: 'name',
                    header: t('colTenant'),
                    cell: ({ row }) => (
                        <Link
                            href={row.original.drillDownUrl}
                            className="font-medium text-content-emphasis hover:text-content-info hover:underline"
                            data-testid={`org-tenant-link-${row.original.slug}`}
                        >
                            {row.original.name}
                        </Link>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'rag',
                    header: t('colHealth'),
                    cell: ({ row }) => <RagPill rag={row.original.rag} />,
                    meta: { mobileCard: { slot: 'status', label: t('colHealth') } },
                },
                {
                    id: 'coverage',
                    header: t('colCoverage'),
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-emphasis">
                            {formatPercent(row.original.coveragePercent)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colCoverage') } },
                },
                {
                    id: 'overdueEvidence',
                    header: t('colOverdueEvidence'),
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {row.original.overdueEvidence ?? '—'}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colOverdueEvidence') } },
                },
                {
                    id: 'snapshotDate',
                    header: t('colLatestSnapshot'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle">
                            {row.original.snapshotDate ?? t('pending')}
                        </span>
                    ),
                },
                ...(perms.canManageTenants
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              cell: ({ row }: { row: { original: TenantHealthRow } }) => (
                                  <div className="flex justify-end">
                                      <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          className="text-content-error"
                                          icon={<Trash2 className="size-3.5" aria-hidden="true" />}
                                          onClick={() => setDeleteTarget(row.original)}
                                          data-testid={`org-tenant-delete-${row.original.slug}`}
                                          text={t('remove')}
                                      />
                                  </div>
                              ),
                          },
                      ]
                    : []),
            ]),
        [perms.canManageTenants, t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-end justify-between gap-default flex-wrap">
                    <div>
                        <Heading level={1}>
                            {t('title')}
                        </Heading>
                        <p className="text-sm text-content-muted mt-1">
                            {t('tenantsSummary', { count: rows.length })}
                        </p>
                    </div>
                    {perms.canManageTenants && (
                        <Link
                            href={`/org/${orgSlug}/tenants/new`}
                            className={buttonVariants({ variant: 'primary', size: 'sm' })}
                            data-testid="org-tenants-new-link"
                        >
                            <Plus className="w-4 h-4" aria-hidden="true" />
                            {t('newTenant')}
                        </Link>
                    )}
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<TenantHealthRow>
                    fillBody
                    mobileFallback="card"
                    data={sorted}
                    columns={columns}
                    getRowId={(r) => r.tenantId}
                    sortableColumns={[
                        'name',
                        'rag',
                        'coverage',
                        'overdueEvidence',
                    ]}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={(p) => {
                        if (p.sortBy) setSortBy(p.sortBy);
                        if (p.sortOrder) setSortOrder(p.sortOrder);
                    }}
                    resourceName={(plural) =>
                        plural ? t('resourcePlural') : t('resourceSingular')
                    }
                    emptyState={
                        <TableEmptyState
                            title={t('emptyTitle')}
                            description={t('emptyDesc')}
                            icon={<Building2 className="size-10" />}
                        />
                    }
                    data-testid="org-tenants-table"
                />
            </ListPageShell.Body>

            {/* Typed-confirmation modal — top-level entity deletion uses
                this (not the undo-toast). Requires typing the tenant slug
                so a misclick can't remove a workspace. */}
            <Modal
                showModal={deleteTarget !== null}
                setShowModal={(o) => (o ? null : closeDelete())}
            >
                <Modal.Header title={t('removeModalTitle')} />
                <Modal.Body>
                    {deleteTarget && (
                        <div className="space-y-default" data-testid="org-tenant-delete-modal">
                            <p className="text-sm text-content-default">
                                {t.rich('removeBody', {
                                    name: deleteTarget.name,
                                    b: (chunks) => (
                                        <span className="font-medium text-content-emphasis">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </p>
                            <FormField
                                label={t('confirmLabel', { slug: deleteTarget.slug })}
                                required
                            >
                                <Input
                                    value={confirmText}
                                    onChange={(e) => setConfirmText(e.target.value)}
                                    autoComplete="off"
                                    autoFocus
                                    placeholder={deleteTarget.slug}
                                    data-testid="org-tenant-delete-confirm-input"
                                />
                            </FormField>
                            {deleteError && (
                                <InlineNotice variant="error" icon={null}>
                                    {deleteError}
                                </InlineNotice>
                            )}
                        </div>
                    )}
                </Modal.Body>
                <Modal.Footer>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={closeDelete}
                        text={t('cancel')}
                    />
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        loading={deleting}
                        disabled={
                            deleting || confirmText.trim() !== deleteTarget?.slug
                        }
                        onClick={confirmDelete}
                        data-testid="org-tenant-delete-confirm"
                        text={t('deleteTenant')}
                    />
                </Modal.Footer>
            </Modal>
        </ListPageShell>
    );
}
