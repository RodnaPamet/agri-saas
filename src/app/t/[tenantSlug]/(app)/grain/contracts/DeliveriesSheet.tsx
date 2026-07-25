'use client';

/**
 * Delivery ledger for one contract — record what physically moved.
 *
 * A `<Sheet>` rather than a `<Modal>` (Epic 54): recording deliveries is
 * inspect-and-edit work done against the list — the operator wants the
 * contract row still visible behind them, and often logs two or three
 * tickets in a row.
 *
 * This is the surface that makes `Contract.status = DELIVERED` mean
 * something: the status gate in `updateContract` refuses that transition
 * until at least one row exists here.
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Sheet } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { DatePicker } from '@/components/ui/date-picker';
import { ProgressBar } from '@/components/ui/progress-bar';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { Trash } from '@/components/ui/icons/nucleo';
import { Tooltip } from '@/components/ui/tooltip';
import { useToastWithUndo } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import { fmtTonnes } from './ContractFulfilmentCell';
import type { ContractFulfilmentDto, ContractRow } from './ContractsClient';

interface DeliveryRow {
    id: string;
    contractId: string;
    deliveredAt: string;
    tonnes: string;
    reference: string | null;
}

interface DeliveriesResponse {
    rows: DeliveryRow[];
    fulfilment: ContractFulfilmentDto;
}

export interface DeliveriesSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    contract: ContractRow | null;
    tenantSlug: string;
    canWrite: boolean;
    /** Called after any mutation so the list refetches its fulfilment. */
    onChanged?: () => void;
}

export function DeliveriesSheet({
    open,
    onOpenChange,
    contract,
    tenantSlug,
    canWrite,
    onChanged,
}: DeliveriesSheetProps) {
    const t = useTranslations('grain.contracts.deliveries');
    const queryClient = useQueryClient();
    const triggerUndoToast = useToastWithUndo();

    const [tonnes, setTonnes] = useState('');
    const [reference, setReference] = useState('');
    const [deliveredAt, setDeliveredAt] = useState<Date | null>(new Date());
    const [formError, setFormError] = useState<string | null>(null);

    const contractId = contract?.id ?? null;
    // Memoised: this array is a react-query key AND a useCallback dep, so
    // a fresh identity each render would re-create the delete handler on
    // every pass and defeat the query cache.
    const listKey = useMemo(
        () => ['grain-deliveries', tenantSlug, contractId],
        [tenantSlug, contractId],
    );

    const deliveriesQuery = useQuery<DeliveriesResponse>({
        queryKey: listKey,
        queryFn: async () => {
            const res = await fetch(
                `/api/t/${tenantSlug}/grain/contracts/${contractId}/deliveries`,
            );
            if (!res.ok) throw new Error('Failed to load deliveries');
            return res.json();
        },
        enabled: open && contractId != null,
        staleTime: 15_000,
    });

    const rows = deliveriesQuery.data?.rows ?? [];
    const fulfilment = deliveriesQuery.data?.fulfilment;
    // A failed read must not render as "no deliveries yet" — that would
    // claim nothing was ever delivered against this contract.
    const loadError =
        deliveriesQuery.isError && rows.length === 0 ? t('loadFailed') : null;

    const resetForm = useCallback(() => {
        setTonnes('');
        setReference('');
        setDeliveredAt(new Date());
        setFormError(null);
    }, []);

    const createMutation = useMutation({
        mutationFn: async () => {
            const parsed = Number(tonnes);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error(t('tonnesInvalid'));
            }
            if (!deliveredAt) throw new Error(t('dateRequired'));

            const res = await fetch(
                `/api/t/${tenantSlug}/grain/contracts/${contractId}/deliveries`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contractId,
                        tonnes: parsed,
                        deliveredAt: deliveredAt.toISOString(),
                        reference: reference.trim() || null,
                    }),
                },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(
                    typeof data.error === 'string' ? data.error : t('createFailed'),
                );
            }
            return res.json();
        },
        onSuccess: () => {
            resetForm();
            queryClient.invalidateQueries({ queryKey: listKey });
            onChanged?.();
        },
        onError: (err: unknown) => {
            setFormError(err instanceof Error ? err.message : t('createFailed'));
        },
    });

    const handleDelete = useCallback(
        (row: DeliveryRow) => {
            const previous = queryClient.getQueryData<DeliveriesResponse>(listKey);
            queryClient.setQueryData<DeliveriesResponse>(listKey, (old) =>
                old ? { ...old, rows: old.rows.filter((r) => r.id !== row.id) } : old,
            );
            triggerUndoToast({
                message: t('deletedToast', { tonnes: fmtTonnes(row.tonnes) }),
                undoMessage: t('undo'),
                action: async () => {
                    const res = await fetch(
                        `/api/t/${tenantSlug}/grain/deliveries/${row.id}`,
                        { method: 'DELETE' },
                    );
                    if (!res.ok) throw new Error('Delete delivery failed');
                },
                undoAction: () => {
                    if (previous) queryClient.setQueryData(listKey, previous);
                },
                onError: () => {
                    if (previous) queryClient.setQueryData(listKey, previous);
                },
                onCommit: () => {
                    queryClient.invalidateQueries({ queryKey: listKey });
                    onChanged?.();
                },
            });
        },
        [queryClient, listKey, t, tenantSlug, triggerUndoToast, onChanged],
    );

    if (!contract) return null;

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            size="md"
            title={t('title', { counterparty: contract.counterparty })}
            description={t('description')}
        >
            <Sheet.Header
                title={t('title', { counterparty: contract.counterparty })}
                description={t('description')}
            />
            <Sheet.Body className="space-y-section">
                {/* ── Position ── */}
                {fulfilment && (
                    <div className="space-y-default rounded-lg border border-border-subtle bg-bg-subtle p-4">
                        <div className="flex items-baseline justify-between gap-default">
                            <span className="text-xs text-content-muted">
                                {t('deliveredLabel')}
                            </span>
                            <span className="text-sm font-semibold tabular-nums text-content-emphasis">
                                {fmtTonnes(fulfilment.deliveredTonnes)}
                                {contract.volumeTonnes
                                    ? ` / ${fmtTonnes(contract.volumeTonnes)}`
                                    : ''}
                            </span>
                        </div>
                        {fulfilment.progressPct != null && (
                            <ProgressBar
                                value={fulfilment.progressPct}
                                variant={fulfilment.complete ? 'success' : 'brand'}
                                size="sm"
                                showValue
                                aria-label={t('progressAria', {
                                    pct: fulfilment.progressPct,
                                })}
                            />
                        )}
                        {fulfilment.remainingTonnes != null && (
                            <p className="text-xs text-content-muted">
                                {t('remainingLabel', {
                                    remaining: fmtTonnes(fulfilment.remainingTonnes),
                                })}
                            </p>
                        )}
                    </div>
                )}

                {/* ── Record a delivery ── */}
                {canWrite && (
                    <div className="space-y-default">
                        <Heading level={3}>{t('recordHeading')}</Heading>
                        {formError && (
                            <div
                                role="alert"
                                id="delivery-form-error"
                                className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            >
                                {formError}
                            </div>
                        )}
                        <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                            <FormField label={t('tonnesLabel')} required>
                                <Input
                                    id="delivery-tonnes-input"
                                    inputMode="decimal"
                                    value={tonnes}
                                    onChange={(e) => setTonnes(e.target.value)}
                                    placeholder={t('tonnesPlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('dateLabel')} required>
                                <DatePicker
                                    id="delivery-date-input"
                                    value={deliveredAt}
                                    onChange={setDeliveredAt}
                                    placeholder={t('datePlaceholder')}
                                />
                            </FormField>
                            <FormField label={t('referenceLabel')}>
                                <Input
                                    id="delivery-reference-input"
                                    value={reference}
                                    onChange={(e) => setReference(e.target.value)}
                                    placeholder={t('referencePlaceholder')}
                                />
                            </FormField>
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            id="record-delivery-btn"
                            loading={createMutation.isPending}
                            onClick={() => {
                                setFormError(null);
                                createMutation.mutate();
                            }}
                        >
                            {t('recordAction')}
                        </Button>
                    </div>
                )}

                {/* ── Ledger ── */}
                <div className="space-y-default">
                    <Heading level={3}>{t('ledgerHeading')}</Heading>
                    {loadError ? (
                        <div
                            role="alert"
                            className="rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                        >
                            {loadError}
                        </div>
                    ) : rows.length === 0 ? (
                        <EmptyState
                            size="sm"
                            variant="no-records"
                            title={t('emptyTitle')}
                            description={t('emptyDescription')}
                        />
                    ) : (
                        <ul className="divide-y divide-border-subtle">
                            {rows.map((row) => (
                                <li
                                    key={row.id}
                                    className="flex items-center justify-between gap-default py-2"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm tabular-nums text-content-emphasis">
                                            {t('tonnesValue', {
                                                tonnes: fmtTonnes(row.tonnes),
                                            })}
                                        </p>
                                        <p className="truncate text-xs text-content-muted">
                                            {formatDate(row.deliveredAt)}
                                            {row.reference ? ` · ${row.reference}` : ''}
                                        </p>
                                    </div>
                                    {canWrite && (
                                        <Tooltip content={t('deleteDelivery')}>
                                            <button
                                                type="button"
                                                aria-label={t('deleteDelivery')}
                                                data-testid={`delivery-delete-${row.id}`}
                                                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-error hover:text-content-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                onClick={() => handleDelete(row)}
                                            >
                                                <Trash className="h-3.5 w-3.5" aria-hidden />
                                            </button>
                                        </Tooltip>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Sheet.Body>
        </Sheet>
    );
}
