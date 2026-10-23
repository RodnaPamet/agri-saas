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
import { useToastWithUndo } from '@/components/ui/hooks';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { useDateFormat } from '@/lib/i18n/use-date-format';
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
    const { formatDate } = useDateFormat();
    const t = useTranslations('ag.leasePayments');
    const triggerUndoToast = useToastWithUndo();
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

    /**
     * Load this lease's settlements.
     *
     * Takes an optional signal because `leaseId` is a PROP and this panel
     * stays mounted when the Rent editor switches straight from lease A to
     * lease B (#1952). Without one, both requests are in flight and whichever
     * resolves LAST wins — so A's payments could paint inside B's panel, and
     * nothing in the row shape would reveal it. Misattributed money in a rent
     * register reads as authoritative, which is why this is worth a guard
     * rather than a comment.
     *
     * `add` and `remove` call this with no signal: those are sequential user
     * actions, not a race.
     */
    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        try {
            const res = await fetch(buildUrlRef.current(`/leases/${leaseId}/payments`), {
                signal,
            });
            const data = res.ok ? await res.json() : { payments: [] };
            // Re-checked AFTER the await: the abort can land while the body
            // is still being read, and by then a newer request owns the state.
            if (signal?.aborted) return;
            setRows(data.payments ?? []);
        } catch (err) {
            // An abort is NOT a failure. The existing catch blanked the rows
            // on any error, which would make every lease switch flash an
            // empty settlement log on its way to the right one.
            if (err instanceof Error && err.name === 'AbortError') return;
            setRows([]);
        } finally {
            // Likewise: the superseded request must not clear the spinner the
            // newer one just set, or the panel claims to be idle mid-fetch.
            if (!signal?.aborted) setLoading(false);
        }
    }, [leaseId]);

    useEffect(() => {
        const controller = new AbortController();
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the setState lands after an await, in a later task, so this is not the synchronous render cascade the rule is about; the effect owns an AbortController so a superseded leaseId cannot win (#1952). MOVED here from above the `useEffect` in #1471: `-next-line` covered the `useEffect(` line while the finding is reported on THIS call, so the directive suppressed nothing AND was itself flagged as unused — two warnings for one misplaced line, and a well-argued reason doing no work.
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

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

    /**
     * Epic 67 — a 5s undo window before the DELETE fires (#2193).
     *
     * This panel loads through `load()` rather than holding an SWR handle, so
     * the optimistic step is a local filter rather than a cache write: there is
     * no cache to roll back, and `load()` on commit is what reconciles with the
     * server. `restore` therefore re-runs the load, which is the only honest
     * rollback available here — it re-reads rather than asserting what the row
     * was.
     */
    const remove = (id: string) => {
        setRows((cur) => cur.filter((r) => r.id !== id));
        const restore = () => {
            void load();
        };
        triggerUndoToast({
            action: () => apiDelete(buildUrl(`/leases/${leaseId}/payments/${id}`)),
            undoAction: restore,
            onCommit: () => {
                void load();
                onChanged?.();
            },
            onError: restore,
            message: t('paymentRemoved'),
            undoMessage: t('undo'),
        });
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
