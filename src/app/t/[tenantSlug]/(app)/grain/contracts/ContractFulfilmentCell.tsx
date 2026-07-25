'use client';

/**
 * Fulfilment + delivery-window presentation for the contracts list.
 *
 * Two small cells, kept out of `ContractsClient` so the column defs stay
 * readable:
 *
 *   • `<ContractProgressCell>` — delivered / contracted with a progress
 *     bar. This is the answer to "how much do I still owe this buyer?",
 *     which the product could not give at all before the GrainDelivery
 *     ledger existed.
 *   • `<ContractWindowBadge>`  — "closing soon" / "overdue" for ACTIVE
 *     contracts, from the SAME `deriveContractWindowState` the nightly
 *     sweep uses, so the badge on screen and the notification in the
 *     bell can never disagree.
 *
 * Uses `<ProgressBar>` — the same primitive the sibling bins page uses
 * for its fill meter — rather than a hand-rolled percentage div.
 */

import { useTranslations } from 'next-intl';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tooltip } from '@/components/ui/tooltip';
import { deriveContractWindowState } from '@/lib/grain/contract-window';
import type { ContractFulfilmentDto } from './ContractsClient';

/** Format a decimal-string tonnage for display. The exact value stays
 *  in the string; only the rendering is localised. */
export function fmtTonnes(v: string | null | undefined): string {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function ContractProgressCell({
    fulfilment,
    volumeTonnes,
}: {
    fulfilment: ContractFulfilmentDto | undefined;
    volumeTonnes: string | null;
}) {
    const t = useTranslations('grain.contracts');

    // No ledger figure at all (an older cached row) — say nothing rather
    // than render a 0% bar, which would claim nothing was delivered.
    if (!fulfilment) return <span className="text-xs text-content-subtle">—</span>;

    const delivered = fmtTonnes(fulfilment.deliveredTonnes);

    // No contracted volume ⇒ no denominator. Show what moved and say the
    // percentage is unavailable, instead of an empty bar that reads as
    // "nothing delivered".
    if (fulfilment.progressPct == null) {
        return (
            <div className="flex flex-col gap-tight">
                <span className="text-xs tabular-nums text-content-default">
                    {t('deliveredTonnesShort', { tonnes: delivered })}
                </span>
                <span className="text-[0.625rem] text-content-subtle">
                    {t('noContractedVolume')}
                </span>
            </div>
        );
    }

    const label = t('deliveredOfContracted', {
        delivered,
        contracted: fmtTonnes(volumeTonnes),
    });

    return (
        <Tooltip
            content={t('remainingTooltip', {
                remaining: fmtTonnes(fulfilment.remainingTonnes),
                count: fulfilment.deliveryCount,
            })}
        >
            <div className="flex w-28 flex-col gap-tight">
                <span className="text-xs tabular-nums text-content-default">{label}</span>
                <ProgressBar
                    value={fulfilment.progressPct}
                    variant={fulfilment.complete ? 'success' : 'brand'}
                    size="sm"
                    aria-label={label}
                />
            </div>
        </Tooltip>
    );
}

export function ContractWindowBadge({
    status,
    deliveryEnd,
    now,
}: {
    status: string;
    deliveryEnd: string | null;
    /** Injectable for deterministic tests; defaults to render time. */
    now?: Date;
}) {
    const t = useTranslations('grain.contracts');
    const signal = deriveContractWindowState(status, deliveryEnd, now ?? new Date());
    if (!signal) return null;

    return signal.state === 'overdue' ? (
        <StatusBadge variant="error" size="sm">
            {t('windowOverdue', { days: Math.abs(signal.daysRemaining) })}
        </StatusBadge>
    ) : (
        <StatusBadge variant="warning" size="sm">
            {t('windowClosingSoon', { days: signal.daysRemaining })}
        </StatusBadge>
    );
}
