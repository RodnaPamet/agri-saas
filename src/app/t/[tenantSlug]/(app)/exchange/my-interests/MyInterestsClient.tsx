'use client';

/**
 * "My interests" — the buyer's outbox: inquiries this tenant has sent, with
 * the target listing and the seller's response status. Read-only.
 */
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useTranslations, useLocale } from 'next-intl';
import { localizedCommodityLabel, asExchangeLocale } from '@/lib/exchange/commodities';
import type { ExchangePublicInquiry } from '@/lib/exchange/public-listing';
import { ExchangeNav } from '../ExchangeNav';

function statusVariant(status: string): 'success' | 'neutral' | 'warning' {
    if (status === 'ACCEPTED') return 'success';
    if (status === 'PENDING') return 'warning';
    return 'neutral';
}

export function MyInterestsClient() {
    const t = useTranslations('exchange');
    const locale = asExchangeLocale(useLocale());
    const tenantHref = useTenantHref();
    const { data, isLoading, error, mutate } = useTenantSWR<ExchangePublicInquiry[]>('/exchange/inquiries');
    const inquiries = data ?? [];

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumb.exchange'), href: tenantHref('/exchange') },
                        { label: t('interests.title') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('interests.title')}</Heading>
                <ExchangeNav />
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                    {error ? (
                        <ErrorState
                            description={t('interests.errorDescription')}
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
                            {t('interests.empty')}
                        </div>
                    ) : (
                    inquiries.map((iq) => (
                        <div key={iq.id} className="space-y-tight rounded-lg border border-border-subtle p-4">
                            <div className="flex flex-wrap items-center gap-compact">
                                {iq.listing && (
                                    <span className="font-medium text-content-emphasis">
                                        {localizedCommodityLabel(iq.listing.commodityKey, iq.listing.commodity, locale)}
                                    </span>
                                )}
                                {iq.listing && (
                                    <span className="text-xs text-content-muted">
                                        {iq.listing.side === 'SELL' ? t('side.selling') : t('side.buying')} · {iq.listing.regionName}
                                    </span>
                                )}
                                <StatusBadge variant={statusVariant(iq.status)}>{iq.status}</StatusBadge>
                            </div>
                            <p className="text-sm text-content-secondary">{iq.message}</p>
                            {iq.quantityTonnes && (
                                <p className="text-xs text-content-muted">{t('interests.quantityOfInterest', { quantity: iq.quantityTonnes })}</p>
                            )}
                        </div>
                    )))}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
