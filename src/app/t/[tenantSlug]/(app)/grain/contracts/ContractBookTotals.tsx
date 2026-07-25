'use client';

/**
 * Contract book totals — the tenant's forward exposure, per currency.
 *
 * `grain.prisma` has described contract value as "volume × price" since
 * the module shipped, but nothing computed it: `grep contractValue src/`
 * returned zero hits, so a farmer could see what they had contracted in
 * TONNES and what they had spent in MONEY, with no figure connecting the
 * two.
 *
 * ## One currency per tile, always
 *
 * The tiles are per-currency and never aggregate across them. €100k +
 * $100k is not "200k" of anything, and a single blended number on a
 * marketing dashboard is the kind of figure someone prices a crop
 * against. If a tenant trades in three currencies they get three tiles;
 * contracts priced without a currency get their own clearly-labelled
 * tile rather than being folded into a neighbour's.
 *
 * Scoped to the live commitment statuses (ACTIVE + DELIVERED) by the
 * server — this is the book, not a lifetime ledger.
 */

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/tooltip';
import type { ContractBookTotalDto } from './ContractsClient';

function fmtAmount(v: string): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtTonnes(v: string): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return v;
    return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function ContractBookTotals({ totals }: { totals: ContractBookTotalDto[] }) {
    const t = useTranslations('grain.contracts');

    if (totals.length === 0) return null;

    return (
        <div
            className="flex flex-wrap items-stretch gap-default"
            id="grain-contract-book-totals"
            data-testid="grain-contract-book-totals"
        >
            {totals.map((total) => (
                <div
                    key={total.currency ?? '__none__'}
                    className="flex min-w-[10rem] flex-col gap-tight rounded-lg border border-border-subtle bg-bg-subtle px-4 py-3"
                >
                    <span className="flex items-center gap-tight text-[0.6875rem] uppercase tracking-wide text-content-muted">
                        {total.currency
                            ? t('bookValueLabel', { currency: total.currency })
                            : t('bookValueNoCurrency')}
                        {total.unpricedCount > 0 && (
                            <InfoTooltip
                                content={t('bookUnpricedHint', {
                                    count: total.unpricedCount,
                                })}
                            />
                        )}
                    </span>
                    <span className="text-lg font-semibold tabular-nums text-content-emphasis">
                        {fmtAmount(total.contractValue)}
                    </span>
                    <span className="text-xs text-content-muted tabular-nums">
                        {t('bookTonnesSubtitle', {
                            tonnes: fmtTonnes(total.contractedTonnes),
                            count: total.contractCount,
                        })}
                    </span>
                </div>
            ))}
        </div>
    );
}
