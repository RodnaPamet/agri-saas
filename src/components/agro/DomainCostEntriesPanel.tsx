'use client';

/**
 * The cost entries filed against ONE domain record — a lease, a
 * planting, a field, a season, a parcel.
 *
 * ── Reflect, never duplicate ────────────────────────────────────────
 *
 * This panel READS `/grain/costs?leaseId=…`. It does not create a cost,
 * and it deliberately sits next to `LeasePaymentsPanel` rather than
 * merging with it, because the two record different things:
 *
 *   • A `LeasePayment` settles the lease's own obligation — it is what
 *     `getRentRoll` reads to work out paid vs outstanding.
 *   • A `CostEntry(RENT)` is the cost register's view of the same money,
 *     carrying the supplier and the invoice.
 *
 * Showing them as one list would imply they are one record and invite
 * someone to sum them, which would double the rent. Two panels, two
 * headings, and this docblock are cheaper than that bug.
 *
 * ── Read-only, on purpose ───────────────────────────────────────────
 *
 * There is no "add cost" affordance here. A cost belongs to at most one
 * domain, and offering creation from every domain page is how a farm ends
 * up with the same invoice filed twice under two different parents. The
 * register is the one place a cost is entered; this is the mirror.
 */

import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Paperclip } from '@/components/ui/icons/nucleo';
import { formatDate } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

interface CostEntryLine {
    id: string;
    category: string;
    amount: number;
    currency: string;
    incurredOn: string;
    supplier: string | null;
    invoiceFileId: string | null;
}

export interface DomainCostEntriesPanelProps {
    /** Which link column to filter on — the API accepts all five. */
    link: 'leaseId' | 'plantingId' | 'seasonId' | 'locationId' | 'parcelId';
    /** The domain record's id. */
    id: string;
    /** i18n key under `grain.costs` for this surface's heading. */
    titleKey: string;
    /** Where "open the register" should land, pre-filtered. */
    registerHref: string;
}

export function DomainCostEntriesPanel({
    link,
    id,
    titleKey,
    registerHref,
}: DomainCostEntriesPanelProps) {
    const t = useTranslations('grain.costs');
    const tEnums = useTranslations('grainEnums');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const { data, error, isLoading } = useSWR<{ rows: CostEntryLine[] }>(
        apiUrl(`/grain/costs?${link}=${encodeURIComponent(id)}`),
        async (url: string) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to load cost entries');
            return res.json();
        },
    );

    const rows = data?.rows ?? [];

    // A failed read must not render as "no costs" — that is a confident
    // claim of zero in response to a crash, and on a money surface it is
    // the claim most likely to be believed.
    if (error) {
        return (
            <section className="space-y-tight">
                <h3 className="text-xs font-medium uppercase tracking-wide text-content-muted">
                    {t(titleKey)}
                </h3>
                <p className="text-xs text-content-error">{t('loadFailed')}</p>
            </section>
        );
    }

    if (isLoading) {
        return (
            <section className="space-y-tight">
                <h3 className="text-xs font-medium uppercase tracking-wide text-content-muted">
                    {t(titleKey)}
                </h3>
                <p className="text-xs text-content-subtle">{t('leasePanelLoading')}</p>
            </section>
        );
    }

    return (
        <section className="space-y-tight border-t border-border-subtle pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <h3 className="text-xs font-medium uppercase tracking-wide text-content-muted">
                    {t(titleKey)}
                </h3>
                <a
                    href={tenantHref(registerHref)}
                    className="text-xs text-content-muted underline-offset-2 hover:text-content-emphasis hover:underline"
                >
                    {t('leasePanelOpenRegister')}
                </a>
            </div>

            {rows.length === 0 ? (
                <p className="text-xs text-content-subtle">{t('leasePanelEmpty')}</p>
            ) : (
                <ul className="space-y-tight">
                    {rows.map((r) => (
                        <li
                            key={r.id}
                            className="flex flex-wrap items-baseline justify-between gap-tight text-xs"
                        >
                            <span className="flex items-center gap-tight text-content-muted">
                                <span className="tabular-nums">{formatDate(r.incurredOn)}</span>
                                <Badge variant="outline" size="sm">
                                    {tEnums(`costCategory.${r.category}`)}
                                </Badge>
                                {r.supplier && (
                                    <span className="text-content-default">{r.supplier}</span>
                                )}
                                {r.invoiceFileId && (
                                    <Paperclip
                                        className="h-3 w-3"
                                        aria-label={t('hasInvoice')}
                                    />
                                )}
                            </span>
                            {/* The RECORDED currency code, not a tenant
                                symbol — entries against one lease can still
                                be in different currencies, and this repo
                                has no FX table. */}
                            <span className="tabular-nums text-content-emphasis">
                                {formatDecimal(r.amount, 2)} {r.currency}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-xs text-content-subtle">{t('leasePanelNote')}</p>
        </section>
    );
}
