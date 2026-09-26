'use client';

/**
 * Step 3 — the premium, how it is paid, and why it is that number.
 *
 * The two formula lines are the explanation, not decoration. A farmer who can
 * see "€100,000.00 × 10 % = €10,000.00" can check the figure against their own
 * arithmetic; one who is only shown the result has to trust it.
 */
import { useTranslations } from 'next-intl';
import { FormField } from '@/components/ui/form-field';
import { KPIStat } from '@/components/ui/metric';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { trimNumber } from '@/lib/agro/rate-calc';
import { formatCents, INSTALMENT_COUNTS, type InstalmentCount } from '@/lib/insurance';

export function PaymentStep({
    premiumCents,
    premiumPerDcaCents,
    instalmentsCents,
    instalments,
    sumInsuredCents,
    tariffBp,
    areaDca,
    note,
    symbol,
    offline,
    onInstalments,
    onNote,
}: {
    premiumCents: number;
    premiumPerDcaCents: number;
    instalmentsCents: number[];
    instalments: InstalmentCount;
    sumInsuredCents: number;
    tariffBp: number;
    areaDca: number;
    note: string;
    symbol: string;
    offline: boolean;
    onInstalments: (n: InstalmentCount) => void;
    onNote: (note: string) => void;
}) {
    const t = useTranslations('ag.risk.quote');
    const perDca = formatCents(premiumPerDcaCents, symbol);

    return (
        <div className="space-y-default">
            {/* KPIStat, not a raw text-2xl figure — the metric typography guard. */}
            <KPIStat
                id="insurance-quote-premium"
                value={formatCents(premiumCents, symbol)}
                label={t('premiumLabel')}
                description={t('perDca', { amount: perDca })}
            />

            <div className="space-y-tight">
                {/* ToggleGroup takes no `id` of its own — see ProductStep. */}
                <div id="insurance-quote-instalments">
                    <ToggleGroup
                        ariaLabel={t('instalmentsLabel')}
                        options={INSTALMENT_COUNTS.map((n) => ({
                            value: String(n),
                            // "Once" is its own key rather than an ICU `=1`
                            // branch: `scripts/i18n-diff.mjs` reads `{Once}` as
                            // a placeholder, so a bare-word branch drifts
                            // against Bulgarian's Cyrillic one.
                            label: n === 1 ? t('instalmentsOnce') : t('instalmentsOption', { count: n }),
                            id: `insurance-quote-instalments-${n}`,
                        }))}
                        selected={String(instalments)}
                        selectAction={(v) => onInstalments(Number(v) as InstalmentCount)}
                    />
                </div>
                <ol className="space-y-tight text-sm" aria-label={t('scheduleLabel')}>
                    {instalmentsCents.map((cents, i) => (
                        <li key={i} className="flex justify-between border-b border-border-subtle py-1">
                            <span className="text-content-muted">{t('instalmentRow', { n: i + 1 })}</span>
                            <span className="font-medium tabular-nums text-content-emphasis">
                                {formatCents(cents, symbol)}
                            </span>
                        </li>
                    ))}
                </ol>
            </div>

            <div className="space-y-tight text-xs text-content-muted">
                <p className="tabular-nums">
                    {t('formulaPremium', {
                        sum: formatCents(sumInsuredCents, symbol),
                        tariff: t('tariffPercent', { percent: trimNumber(tariffBp / 100) }),
                        premium: formatCents(premiumCents, symbol),
                    })}
                </p>
                <p className="tabular-nums">
                    {t('formulaPerDca', {
                        premium: formatCents(premiumCents, symbol),
                        dca: trimNumber(areaDca),
                        perDca: perDca,
                    })}
                </p>
                <p>{t('disclaimer')}</p>
            </div>

            <FormField label={t('noteLabel')}>
                <Textarea
                    id="insurance-quote-note"
                    rows={3}
                    maxLength={2000}
                    value={note}
                    placeholder={t('notePlaceholder')}
                    onChange={(e) => onNote(e.target.value)}
                />
            </FormField>

            {offline ? (
                <p role="status" className="rounded-lg border border-border-subtle bg-bg-subtle px-3 py-2 text-sm text-content-muted">
                    {t('offline')}
                </p>
            ) : null}
        </div>
    );
}
