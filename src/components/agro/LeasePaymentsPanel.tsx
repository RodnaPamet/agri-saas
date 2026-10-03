'use client';

/**
 * LeasePaymentsPanel — the settlement log for ONE lease, rendered inside the
 * Rent-page edit modal. The lease carries the obligation; this records what was
 * actually paid, which is what lets the rent roll answer "who hasn't been paid".
 *
 * Payments default to the lease's own rent unit, so rent settled in grain never
 * books against a money obligation. `onChanged` lets the parent revalidate the
 * roll (the KPI card) after a settlement is added or removed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost, apiDelete } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@/lib/format-date';
import { rentTotalSuffix } from '@/lib/agro/rent-units';

export interface LeasePaymentRow {
    id: string;
    seasonYear: number;
    amountPaid: string | number;
    unit: string | null;
    paidAt: string;
    note: string | null;
}

export function LeasePaymentsPanel({
    leaseId,
    rentUnit,
    canWrite,
    onChanged,
}: {
    leaseId: string;
    rentUnit: string | null;
    canWrite: boolean;
    onChanged?: () => void;
}) {
    const t = useTranslations('ag.leasePayments');
    const buildUrl = useTenantApiUrl();
    const [rows, setRows] = useState<LeasePaymentRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [amount, setAmount] = useState('');
    const [season, setSeason] = useState(String(new Date().getUTCFullYear()));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // `buildUrl` is not guaranteed to be referentially stable across renders.
    // Depending on it directly would make `load` unstable, so the effect below
    // would re-fire on every render it triggers — an infinite fetch loop. Hold
    // it in a ref and key the callback on `leaseId` alone.
    const buildUrlRef = useRef(buildUrl);
    buildUrlRef.current = buildUrl;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(buildUrlRef.current(`/leases/${leaseId}/payments`));
            const data = res.ok ? await res.json() : { payments: [] };
            setRows(data.payments ?? []);
        } catch {
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [leaseId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const add = async () => {
        const value = Number(amount);
        if (!amount.trim() || Number.isNaN(value) || value < 0) {
            setError(t('amountInvalid'));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await apiPost(buildUrl(`/leases/${leaseId}/payments`), {
                seasonYear: Number(season),
                amountPaid: value,
                unit: rentUnit,
            });
            setAmount('');
            await load();
            onChanged?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (id: string) => {
        setBusy(true);
        try {
            await apiDelete(buildUrl(`/leases/${leaseId}/payments/${id}`));
            await load();
            onChanged?.();
        } catch {
            /* the list reload below surfaces the true state */
        } finally {
            setBusy(false);
        }
    };

    const suffix = rentTotalSuffix(rentUnit);

    return (
        <div className="space-y-default rounded-lg border border-border-subtle p-3" id="lease-payments-panel">
            <Heading level={3}>{t('title')}</Heading>

            {loading ? (
                <p className="text-sm text-content-muted">{t('loading')}</p>
            ) : rows.length === 0 ? (
                <p className="text-sm text-content-muted">{t('none')}</p>
            ) : (
                <ul className="space-y-tight">
                    {rows.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-default text-sm">
                            <span className="min-w-0 truncate">
                                {p.seasonYear} · {Number(p.amountPaid)} {rentTotalSuffix(p.unit) || suffix} · {formatDate(p.paidAt)}
                            </span>
                            {canWrite ? (
                                <button
                                    type="button"
                                    className="text-xs text-content-error hover:underline"
                                    onClick={() => remove(p.id)}
                                    disabled={busy}
                                    aria-label={t('remove')}
                                >
                                    {t('remove')}
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}

            {canWrite ? (
                <>
                    {error ? <p className="text-sm text-content-error" role="alert">{error}</p> : null}
                    <div className="grid grid-cols-3 gap-default">
                        <FormField label={t('season')}>
                            <Input value={season} inputMode="numeric" onChange={(e) => setSeason(e.target.value)} />
                        </FormField>
                        <FormField label={suffix ? t('amountWithUnit', { unit: suffix }) : t('amount')}>
                            <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
                        </FormField>
                        <div className="flex items-end">
                            <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                onClick={add}
                                disabled={busy}
                                id="add-lease-payment-btn"
                            >
                                {t('add')}
                            </Button>
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}

export default LeasePaymentsPanel;
