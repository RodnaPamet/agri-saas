'use client';

/**
 * The cost entries filed against ONE domain record — a lease, a product,
 * a planting, a field, a season, a parcel.
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

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Heading } from '@/components/ui/typography';
import { Paperclip } from '@/components/ui/icons/nucleo';
import { formatDate } from '@/lib/format-date';
import { formatDecimal } from '@/lib/number-format';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';

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
    link: 'leaseId' | 'plantingId' | 'seasonId' | 'locationId' | 'parcelId' | 'itemId';
    /** The domain record's id. */
    id: string;
    /** i18n key under `grain.costs` for this surface's heading. */
    titleKey: string;
    /**
     * i18n key under `grain.costs` for the nothing-here line.
     *
     * REQUIRED, and deliberately not defaulted. The first version of this
     * panel hard-coded the lease wording, so the second surface to mount it
     * would have told a farmer looking at a product that "no costs are
     * recorded against this lease yet" — wrong, and wrong in the confident
     * register that gets believed.
     */
    emptyKey: string;
    /**
     * Optional footnote under the list. The lease surface needs one (it sits
     * beside `LeasePaymentsPanel` and has to say why the two are not added
     * together); a surface with no neighbouring money list needs none.
     */
    noteKey?: string;
    /** Where "open the register" should land, pre-filtered. */
    registerHref: string;
}

export function DomainCostEntriesPanel({
    link,
    id,
    titleKey,
    emptyKey,
    noteKey,
    registerHref,
}: DomainCostEntriesPanelProps) {
    const t = useTranslations('grain.costs');
    const tEnums = useTranslations('grainEnums');
    const tenantHref = useTenantHref();

    // `useTenantSWR`, not a bare `useSWR` + hand-rolled `fetch`. The panel
    // originally carried its own fetcher, which made it the one component in
    // the app that could not be exercised through the project's SWR seam —
    // the reason an earlier attempt to mount it on the inventory page had to
    // be reverted. Going through the shared hook also buys tenant-prefixed
    // key derivation, cross-tenant cache isolation and the persistent
    // cache, none of which the private fetcher had.
    const { data, error, isLoading } = useTenantSWR<{ rows: CostEntryLine[] }>(
        `/grain/costs?${link}=${encodeURIComponent(id)}`,
    );

    const rows = data?.rows ?? [];

    // A failed read must not render as "no costs" — that is a confident
    // claim of zero in response to a crash, and on a money surface it is
    // the claim most likely to be believed.
    if (error) {
        return (
            <section className="space-y-tight">
                <Heading level={3} as="h3" tone="muted">
                    {t(titleKey)}
                </Heading>
                <p className="text-xs text-content-error">{t('loadFailed')}</p>
            </section>
        );
    }

    if (isLoading) {
        return (
            <section className="space-y-tight">
                <Heading level={3} as="h3" tone="muted">
                    {t(titleKey)}
                </Heading>
                <p className="text-xs text-content-subtle">{t('panelLoading')}</p>
            </section>
        );
    }

    return (
        <section className="space-y-tight border-t border-border-subtle pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                <Heading level={3} as="h3" tone="muted">
                    {t(titleKey)}
                </Heading>
                <a
                    href={tenantHref(registerHref)}
                    className="text-xs text-content-muted underline-offset-2 hover:text-content-emphasis hover:underline"
                >
                    {t('panelOpenRegister')}
                </a>
            </div>

            {rows.length === 0 ? (
                <p className="text-xs text-content-subtle">{t(emptyKey)}</p>
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
            {noteKey ? (
                <p className="text-xs text-content-subtle">{t(noteKey)}</p>
            ) : null}
        </section>
    );
}
