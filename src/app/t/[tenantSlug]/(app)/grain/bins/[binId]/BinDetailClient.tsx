'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { MetaStrip } from '@/components/ui/meta-strip';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { AgStatusBadge } from '@/components/ag/ag-status';
import { ProgressBar } from '@/components/ui/progress-bar';
import { formatDate } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import { BinFormModal } from '../BinFormModal';
import { BlendModal } from './BlendModal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiDelete } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type { BinRow } from '../BinsClient';

/** One lot inside the bin. Mirrors `BinLotDto`. */
interface BinLot {
    id: string;
    lotCode: string;
    itemId: string;
    itemName: string;
    quantity: number;
    unitSymbol: string;
    expiresAt: string | null;
    attributes: Record<string, unknown> | null;
}

export interface BinDetail extends BinRow {
    lots: BinLot[];
    lotsTruncated: boolean;
}

interface Props {
    bin: BinDetail;
    tenantSlug: string;
    permissions: { canWrite: boolean };
}

/**
 * The grain-quality attributes worth a column. `attributesJson` is
 * free-form, so the page reads the keys the yield page already uses rather
 * than rendering whatever happens to be in there.
 */
const QUALITY_KEYS = ['moisture', 'protein', 'testWeight'] as const;

function qualityValue(attrs: Record<string, unknown> | null, key: string): string {
    const v = attrs?.[key];
    if (v == null) return '—';
    return typeof v === 'number' ? formatDecimal(v, 1) : String(v);
}

export function BinDetailClient({ bin, tenantSlug, permissions }: Props) {
    const t = useTranslations('grain.bins');
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [blending, setBlending] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const buildUrl = useTenantApiUrl();

    const getRowId = useCallback((l: BinLot) => l.id, []);

    const columns = useMemo(
        () =>
            createColumns<BinLot>([
                {
                    accessorKey: 'lotCode',
                    header: t('detail.colLot'),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    accessorKey: 'itemName',
                    header: t('detail.colItem'),
                    meta: { mobileCard: { slot: 'meta', label: t('detail.colItem') } },
                },
                {
                    id: 'quantity',
                    header: t('detail.colQuantity'),
                    accessorFn: (l) => l.quantity,
                    // Shown in the LOT'S OWN unit. The bin's total is converted
                    // to tonnes; a per-lot row is not, because "180 kg" is what
                    // the farmer wrote on the lot.
                    cell: ({ row }) => (
                        <span className="text-xs text-content-default tabular-nums block text-right">
                            {`${formatDecimal(row.original.quantity, 2)} ${row.original.unitSymbol}`}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('detail.colQuantity') } },
                },
                ...QUALITY_KEYS.map((key) => ({
                    id: key,
                    header: t(`detail.col_${key}`),
                    accessorFn: (l: BinLot) => qualityValue(l.attributes, key),
                    meta: { mobileCard: { slot: 'meta' as const, label: t(`detail.col_${key}`) } },
                })),
                {
                    id: 'expiresAt',
                    header: t('detail.colExpires'),
                    accessorFn: (l) => l.expiresAt ?? '',
                    cell: ({ row }) => (
                        <span className="text-xs text-content-secondary">
                            {row.original.expiresAt ? formatDate(row.original.expiresAt) : '—'}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('detail.colExpires') } },
                },
            ]),
        [t],
    );

    const fillPctDisplay =
        bin.fillPct == null ? null : Math.round(bin.fillPct * 100);

    return (
        <>
            <EntityDetailLayout
                breadcrumbs={[
                    { label: t('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('breadcrumbBins'), href: `/t/${tenantSlug}/grain/bins` },
                    { label: bin.name },
                ]}
                title={bin.name}
                meta={
                    <MetaStrip
                        items={[
                            { label: t('colKind'), value: <AgStatusBadge entity="bin" status={bin.kind} /> },
                            ...(bin.status === 'ARCHIVED'
                                ? [{ label: t('colStatus'), value: t('archived') }]
                                : []),
                            ...(bin.key ? [{ label: t('form.key'), value: bin.key }] : []),
                            {
                                label: t('colStored'),
                                value: t('detail.storedSummary', {
                                    stored: formatDecimal(bin.storedTonnes, 2),
                                    capacity:
                                        bin.capacityTonnes == null
                                            ? '—'
                                            : formatDecimal(bin.capacityTonnes, 2),
                                }),
                            },
                            {
                                label: t('colFill'),
                                value:
                                    fillPctDisplay != null ? (
                                        <ProgressBar
                                            value={fillPctDisplay}
                                            variant={fillPctDisplay >= 100 ? 'warning' : 'success'}
                                            size="sm"
                                            showValue
                                            className="w-full sm:w-28"
                                            aria-label={t('fillAria', { pct: fillPctDisplay })}
                                        />
                                    ) : bin.mixedUnits ? (
                                        t('fillMixedUnits')
                                    ) : (
                                        '—'
                                    ),
                            },
                        ]}
                    />
                }
                actions={
                    permissions.canWrite ? (
                        <div className="flex items-center gap-compact">
                            {/* Blend is the product's only real "move grain"
                                action. It lives here because the destination is
                                always this bin and the sources are its lots. */}
                            <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                disabled={bin.lots.length === 0}
                                onClick={() => setBlending(true)}
                            >
                                {t('blend.action')}
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                onClick={() => setEditing(true)}
                            >
                                {t('detail.edit')}
                            </Button>
                            {/* Refused server-side while stock is assigned, so
                                the button stays enabled and the reason comes
                                back as a message rather than being guessed in
                                the client from a possibly-stale lot count. */}
                            <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                onClick={() => setConfirmDelete(true)}
                            >
                                {t('detail.delete')}
                            </Button>
                        </div>
                    ) : undefined
                }
            >
                <div className="space-y-section">
                    {bin.description && (
                        <p className="text-sm text-content-secondary">{bin.description}</p>
                    )}
                    {/* Unconvertible stock is stated, not folded into the tonnes
                        above — a bin can legitimately hold bagged seed. */}
                    {bin.unconvertible.length > 0 && (
                        <p className="text-sm text-content-secondary">
                            {t('detail.alsoHolds', {
                                items: bin.unconvertible
                                    .map((u) => `${formatDecimal(u.quantity, 2)} ${u.symbol}`)
                                    .join(', '),
                            })}
                        </p>
                    )}
                    <DataTable
                        data={bin.lots}
                        columns={columns}
                        getRowId={getRowId}
                        mobileFallback="card"
                        virtualize={false}
                        data-testid="bin-lots-table"
                        onRowClick={(row) =>
                            router.push(
                                `/t/${tenantSlug}/inventory?lotId=${row.original.id}`,
                            )
                        }
                        emptyState={
                            <EmptyState
                                title={t('detail.emptyTitle')}
                                description={t('detail.emptyDescription')}
                            />
                        }
                    />
                    {bin.lotsTruncated && (
                        <p className="text-xs text-content-subtle">
                            {t('detail.lotsTruncated')}
                        </p>
                    )}
                </div>
            </EntityDetailLayout>

            {permissions.canWrite && (
                <BlendModal
                    open={blending}
                    setOpen={setBlending}
                    binId={bin.id}
                    binName={bin.name}
                    lots={bin.lots}
                    onBlended={() => router.refresh()}
                />
            )}

            {permissions.canWrite && (
                <ConfirmDialog
                    showModal={confirmDelete}
                    setShowModal={setConfirmDelete}
                    tone="danger"
                    title={t('detail.deleteTitle', { name: bin.name })}
                    description={t('detail.deleteDescription')}
                    confirmLabel={t('detail.deleteConfirm')}
                    onConfirm={async () => {
                        await apiDelete(buildUrl(`/grain/bins/${bin.id}`));
                        router.push(`/t/${tenantSlug}/grain/bins`);
                    }}
                />
            )}

            {permissions.canWrite && (
                <BinFormModal
                    open={editing}
                    setOpen={setEditing}
                    tenantSlug={tenantSlug}
                    bin={bin}
                    onSaved={() => {
                        setEditing(false);
                        router.refresh();
                    }}
                />
            )}
        </>
    );
}
