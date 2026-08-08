'use client';

/**
 * Maintenance history for one machine.
 *
 * `AssetStatus.IN_MAINTENANCE` was a status with nothing behind it. This
 * is the record, and it is deliberately UNGATED — Evidence / Mappings /
 * Traceability are compliance-era tabs a plain-farm tenant hides, but
 * every farm services its tractor.
 *
 * The status coupling is a PROMPT, never a side effect. The API returns
 * `suggestStatus` ('IN_MAINTENANCE' after opening a record, 'ACTIVE'
 * after closing the last open one) and this component asks. Silently
 * flipping a machine's status because someone logged an oil change
 * would surprise an operator entering history after the fact.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { DataTable, createColumns } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';

const KINDS = ['SERVICE', 'REPAIR', 'INSPECTION', 'BREAKDOWN'] as const;
type Kind = (typeof KINDS)[number];

const KIND_TONE: Record<Kind, StatusBadgeVariant> = {
    SERVICE: 'info',
    REPAIR: 'warning',
    INSPECTION: 'neutral',
    BREAKDOWN: 'error',
};

export interface MaintenanceRow {
    id: string;
    kind: Kind;
    openedAt: string;
    closedAt: string | null;
    meterAtService: string | number | null;
    description: string | null;
    cost: string | number | null;
    nextDueAt: string | null;
    nextDueMeter: string | number | null;
    vendor?: { id: string; name: string } | null;
}

interface Props {
    assetId: string;
    canWrite: boolean;
    /** Current asset status — decides which status prompt makes sense. */
    assetStatus: string;
    /** Applies a status change the user accepted from the prompt. */
    onStatusChange: (status: 'ACTIVE' | 'IN_MAINTENANCE') => void | Promise<void>;
}

export function MaintenanceTab({ assetId, canWrite, assetStatus, onStatusChange }: Props) {
    const t = useTranslations('assets');
    const tc = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const listKey = `/assets/${assetId}/maintenance`;
    const { data, error, isLoading, mutate } = useTenantSWR<MaintenanceRow[]>(listKey);
    const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);

    const [adding, setAdding] = useState(false);
    const [closing, setClosing] = useState<MaintenanceRow | null>(null);
    // Status prompt — held separately so declining leaves the record intact.
    const [prompt, setPrompt] = useState<'ACTIVE' | 'IN_MAINTENANCE' | null>(null);

    const columns = useMemo(
        () =>
            createColumns<MaintenanceRow>([
                {
                    id: 'kind',
                    header: t('maintKind'),
                    meta: { mobileCard: { slot: 'title' } },
                    cell: ({ row }) => (
                        <StatusBadge variant={KIND_TONE[row.original.kind]}>
                            {t(`maintKind${row.original.kind}`)}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'openedAt',
                    header: t('maintOpenedAt'),
                    meta: { mobileCard: { slot: 'meta' } },
                    cell: ({ row }) => formatDate(row.original.openedAt),
                },
                {
                    id: 'closedAt',
                    header: t('maintClosedAt'),
                    meta: { mobileCard: { slot: 'meta' } },
                    cell: ({ row }) =>
                        row.original.closedAt ? (
                            formatDate(row.original.closedAt)
                        ) : (
                            <StatusBadge variant="warning">{t('maintOpen')}</StatusBadge>
                        ),
                },
                {
                    id: 'meterAtService',
                    header: t('maintMeter'),
                    cell: ({ row }) => row.original.meterAtService ?? '—',
                },
                {
                    id: 'cost',
                    header: t('maintCost'),
                    cell: ({ row }) => row.original.cost ?? '—',
                },
                {
                    id: 'nextDueAt',
                    header: t('maintNextDueAt'),
                    cell: ({ row }) =>
                        row.original.nextDueAt ? formatDate(row.original.nextDueAt) : '—',
                },
                {
                    id: 'actions',
                    header: '',
                    meta: { mobileCard: { slot: 'actions' } },
                    cell: ({ row }) =>
                        canWrite && !row.original.closedAt ? (
                            <Button variant="ghost" size="sm" onClick={() => setClosing(row.original)}>
                                {t('maintClose')}
                            </Button>
                        ) : null,
                },
            ]),
        [t, canWrite],
    );

    const handleClose = async () => {
        if (!closing) return;
        try {
            const res = await fetch(apiUrl(`/assets/${assetId}/maintenance/${closing.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error('close failed');
            const body = (await res.json()) as { suggestStatus?: 'ACTIVE' | null };
            setClosing(null);
            await mutate();
            toast.success(t('maintClosed'));
            if (body.suggestStatus === 'ACTIVE') setPrompt('ACTIVE');
        } catch {
            toast.error(t('maintSaveFail'));
        }
    };

    return (
        <div className="space-y-section">
            <div className="flex items-center justify-between">
                <Heading level={2} size="sm">{t('maintTitle')}</Heading>
                {canWrite && (
                    <Button variant="secondary" icon={<Plus />} onClick={() => setAdding(true)}>
                        {t('maintAdd')}
                    </Button>
                )}
            </div>

            <DataTable
                data={rows}
                columns={columns}
                getRowId={(r) => r.id}
                loading={isLoading && rows.length === 0}
                // Gate on having nothing to show, so a failed BACKGROUND
                // refetch keeps the existing history on screen.
                error={error && rows.length === 0 ? (error as Error).message : undefined}
                mobileFallback="card"
                emptyState={<EmptyState title={t('maintEmpty')} />}
            />

            {adding && (
                <AddMaintenanceModal
                    assetId={assetId}
                    onClose={() => setAdding(false)}
                    onSaved={async (suggest) => {
                        setAdding(false);
                        await mutate();
                        toast.success(t('maintSaved'));
                        if (suggest === 'IN_MAINTENANCE' && assetStatus === 'ACTIVE') {
                            setPrompt('IN_MAINTENANCE');
                        }
                    }}
                />
            )}

            {closing && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => setClosing(null)}
                    title={t('maintCloseConfirm')}
                    confirmLabel={t('maintClose')}
                    onConfirm={handleClose}
                />
            )}

            {prompt && (
                <ConfirmDialog
                    showModal
                    setShowModal={() => setPrompt(null)}
                    title={
                        prompt === 'ACTIVE'
                            ? t('maintSuggestActive')
                            : t('maintSuggestInMaintenance')
                    }
                    confirmLabel={t('maintSuggestYes')}
                    onConfirm={async () => {
                        const next = prompt;
                        setPrompt(null);
                        await onStatusChange(next);
                    }}
                />
            )}
        </div>
    );
}

function AddMaintenanceModal({
    assetId,
    onClose,
    onSaved,
}: {
    assetId: string;
    onClose: () => void;
    onSaved: (suggestStatus: string | null) => void | Promise<void>;
}) {
    const t = useTranslations('assets');
    const tc = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const [kind, setKind] = useState<Kind>('SERVICE');
    const [description, setDescription] = useState('');
    const [meter, setMeter] = useState('');
    const [cost, setCost] = useState('');
    const [nextDueAt, setNextDueAt] = useState<Date | null>(null);
    const [nextDueMeter, setNextDueMeter] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const kindOptions: ComboboxOption[] = KINDS.map((k) => ({
        value: k,
        label: t(`maintKind${k}`),
    }));

    const submit = async () => {
        setSubmitting(true);
        try {
            const res = await fetch(apiUrl(`/assets/${assetId}/maintenance`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    description: description.trim() || null,
                    meterAtService: meter.trim() ? Number(meter) : null,
                    cost: cost.trim() ? Number(cost) : null,
                    nextDueAt: nextDueAt ? nextDueAt.toISOString() : null,
                    nextDueMeter: nextDueMeter.trim() ? Number(nextDueMeter) : null,
                }),
            });
            if (!res.ok) throw new Error('save failed');
            const body = (await res.json()) as { suggestStatus?: string | null };
            await onSaved(body.suggestStatus ?? null);
        } catch {
            toast.error(t('maintSaveFail'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal setShowModal={onClose} title={t('maintTitle')}>
            <Modal.Form onSubmit={submit}>
                <div className="space-y-default">
                    <FormField label={t('maintKind')}>
                        <Combobox
                            id="maint-kind"
                            options={kindOptions}
                            selected={kindOptions.find((o) => o.value === kind) ?? null}
                            setSelected={(o) => setKind((o?.value as Kind) ?? 'SERVICE')}
                            hideSearch
                            matchTriggerWidth
                        />
                    </FormField>
                    <FormField label={t('maintDescription')}>
                        <Input
                            id="maint-desc"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('maintMeter')}>
                        <Input
                            id="maint-meter"
                            inputMode="decimal"
                            value={meter}
                            onChange={(e) => setMeter(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('maintCost')}>
                        <Input
                            id="maint-cost"
                            inputMode="decimal"
                            value={cost}
                            onChange={(e) => setCost(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('maintNextDueAt')}>
                        <DatePicker id="maint-next-due" value={nextDueAt} onChange={setNextDueAt} />
                    </FormField>
                    <FormField label={t('maintNextDueMeter')}>
                        <Input
                            id="maint-next-meter"
                            inputMode="decimal"
                            value={nextDueMeter}
                            onChange={(e) => setNextDueMeter(e.target.value)}
                        />
                    </FormField>
                </div>
                <Modal.Actions>
                    <Button variant="ghost" onClick={onClose} type="button">
                        {tc('cancel')}
                    </Button>
                    <Button variant="primary" type="submit" disabled={submitting}>
                        {t('maintAdd')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
