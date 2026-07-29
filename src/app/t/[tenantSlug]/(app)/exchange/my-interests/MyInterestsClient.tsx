'use client';

/**
 * "My interests" — the buyer's outbox: inquiries this tenant has sent, with
 * the target listing, the seller's response, and — once the seller accepts —
 * the contact details that let the two farms actually transact.
 *
 * This page is the buyer's half of the consented contact exchange, so it has
 * to carry enough of the offer to act on: what was agreed (commodity, tonnage,
 * price, region), who agreed it (the seller's public name, or "anonymous"),
 * and a way back to the offer itself. Before, it showed a status badge and the
 * message you had already written — a receipt for a conversation you could not
 * continue.
 *
 * `counterpartyContact` is computed server-side by `toPublicInquiry`'s reveal
 * gate; this component never decides who may see a contact, it only renders
 * what the gate handed it. A PENDING or DECLINED inquiry arrives with null and
 * there is nothing here that could reconstruct it.
 */
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { CopyText } from '@/components/ui/copy-text';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, formatDateTime } from '@/lib/format-date';
import { localizedRegionName } from '@/lib/geo/bulgaria-regions';
import { formatPricePerTonne } from '@/lib/exchange/currency';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import type { ExchangePublicInquiry } from '@/lib/exchange/public-listing';
import { ExchangeNav } from '../ExchangeNav';

function statusVariant(status: string): 'success' | 'neutral' | 'warning' {
    if (status === 'ACCEPTED') return 'success';
    if (status === 'PENDING') return 'warning';
    return 'neutral';
}

/** Inquiry status → i18n key. Unknown values fall back to the raw enum. */
const STATUS_KEY: Record<string, string> = {
    PENDING: 'statusPending',
    ACCEPTED: 'statusAccepted',
    DECLINED: 'statusDeclined',
};

export function MyInterestsClient() {
    const t = useTranslations('exchange.myInterests');
    const locale = useLocale();
    const tonne = t('unitTonne');
    const tenantHref = useTenantHref();
    const { data, isLoading, error, mutate } = useTenantSWR<ExchangePublicInquiry[]>('/exchange/inquiries');
    const inquiries = data ?? [];

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbExchange'), href: tenantHref('/exchange') },
                        { label: t('breadcrumbCurrent') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('heading')}</Heading>
                <ExchangeNav />
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                    {error ? (
                        <ErrorState
                            description={t('loadError')}
                            onRetry={() => { void mutate(); }}
                        />
                    ) : isLoading ? (
                        <div className="space-y-default" aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-24 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : inquiries.length === 0 ? (
                        <div className="rounded-lg border border-border-subtle p-4 text-sm text-content-muted">
                            {t('empty')}
                        </div>
                    ) : (
                    inquiries.map((iq) => {
                        const l = iq.listing;
                        const accepted = iq.contactSharedAt != null;
                        return (
                            // The buyer notification deep-links to
                            // `/exchange/my-interests#listing-<listingId>`; without
                            // this id that anchor lands at the top of the page and
                            // the notification's promise ("here is your answer")
                            // dissolves into a list the buyer has to scan.
                            <div
                                key={iq.id}
                                id={l ? `listing-${l.id}` : undefined}
                                className="space-y-tight rounded-lg border border-border-subtle p-4 scroll-mt-4"
                            >
                                <div className="flex flex-wrap items-center gap-compact">
                                    {l && (
                                        <span className="font-medium text-content-emphasis">{l.commodity}</span>
                                    )}
                                    {l && (
                                        <span className="text-xs text-content-muted">
                                            {l.side === 'SELL' ? t('selling') : t('buying')}
                                            {' · '}
                                            {localizedRegionName(l.regionCode, locale, l.regionName)}
                                        </span>
                                    )}
                                    <StatusBadge variant={statusVariant(iq.status)}>
                                        {STATUS_KEY[iq.status] ? t(STATUS_KEY[iq.status]) : iq.status}
                                    </StatusBadge>
                                    {l && (
                                        <Link
                                            href={tenantHref(`/exchange?listing=${l.id}`)}
                                            className="ml-auto text-xs text-content-link underline-offset-2 hover:underline"
                                        >
                                            {t('viewListing')}
                                        </Link>
                                    )}
                                </div>

                                {/* The commercial terms — what the buyer is actually
                                    tracking. Price is the field whose absence sent
                                    them back to the browse page every time. */}
                                {l && (
                                    <p className="text-sm text-content-secondary">
                                        {l.quantityTonnes} {tonne} · {l.pricePerTonne
                                            ? formatPricePerTonne(l.pricePerTonne, l.priceCurrency, tonne)
                                            : t('marketNegotiable')}
                                        {' · '}
                                        <span className="text-content-muted">
                                            {t('seller')}: {l.sellerDisplayName || t('anonymousFarm')}
                                        </span>
                                    </p>
                                )}

                                <p className="text-sm text-content-secondary">{iq.message}</p>
                                {iq.quantityTonnes && (
                                    <p className="text-xs text-content-muted">{t('quantityOfInterest', { qty: iq.quantityTonnes })}</p>
                                )}
                                {/* When this went out. "Waiting for the seller"
                                    reads very differently at two hours and at
                                    two months, and the page said neither. */}
                                <p className="text-xs text-content-muted">
                                    {t('sentOn', { date: formatDateTime(iq.createdAt) })}
                                </p>

                                {/* The point of the feature. Emphasised border +
                                    success tone because this is the one state on
                                    the page that asks the buyer to do something
                                    off-platform. */}
                                {accepted ? (
                                    <div className="space-y-tight rounded-lg border border-border-emphasis bg-bg-subtle p-3">
                                        <p className="text-sm font-medium text-content-emphasis">{t('contactHeading')}</p>
                                        {iq.counterpartyContact ? (
                                            <CopyText
                                                value={iq.counterpartyContact}
                                                label={t('contactCopyLabel')}
                                                className="text-base font-medium text-content-emphasis"
                                            >
                                                {iq.counterpartyContact}
                                            </CopyText>
                                        ) : (
                                            // Accepted, but the seller published no
                                            // contact on this listing. Say that,
                                            // rather than render an empty box that
                                            // reads as a loading failure.
                                            <p className="text-sm text-content-muted">{t('contactMissing')}</p>
                                        )}
                                        <p className="text-xs text-content-muted">
                                            {t('contactSharedOn', { date: formatDate(iq.contactSharedAt) })}
                                        </p>
                                    </div>
                                ) : iq.status === 'DECLINED' ? (
                                    <p className="text-xs text-content-muted">{t('declinedNote')}</p>
                                ) : (
                                    <p className="text-xs text-content-muted">{t('pendingNote')}</p>
                                )}
                            </div>
                        );
                    }))}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
