'use client';

/**
 * Conversations from BOTH sides, in one list.
 *
 * A tenant sells in some threads and buys in others, and this shows both:
 * they are one inbox to the person reading them, whatever the schema calls
 * the parties. `role` per row says which side they are on, because "someone
 * is asking about your offer" and "the seller replied" deserve different
 * attention from the same screen.
 *
 * ── Why polling ──
 *
 * There is no broker — see `usecases/exchange-messaging.ts`. A 30s refresh is
 * what makes an inbox feel live without one, and it costs a single indexed
 * query (`orderBy lastMessageAt`, capped). When a transport lands this file
 * changes and nothing behind it does.
 */
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { ExchangeNav } from '../ExchangeNav';

/** The wire shape of `listExchangeThreads` — dates arrive as ISO strings. */
interface ThreadSummary {
    id: string;
    listingId: string;
    listingCommodity: string;
    role: 'seller' | 'inquirer';
    lastMessageAt: string;
    closed: boolean;
    hasUnread: boolean;
}

export function ThreadsClient() {
    const t = useTranslations('exchange.messaging');
    const tenantHref = useTenantHref();
    const { data, isLoading, error, mutate } = useTenantSWR<{ threads: ThreadSummary[] }>(
        '/exchange/threads',
        { refreshInterval: 30_000 },
    );
    const threads = data?.threads ?? [];

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
                <Heading level={1}>{t('inboxTitle')}</Heading>
                <ExchangeNav />
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                    {error ? (
                        <ErrorState description={t('loadError')} onRetry={() => { void mutate(); }} />
                    ) : isLoading ? (
                        <div className="space-y-default" aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <Skeleton key={i} className="h-16 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : threads.length === 0 ? (
                        <div className="rounded-lg border border-border-subtle p-4 text-sm text-content-muted">
                            {t('inboxEmpty')}
                        </div>
                    ) : (
                        threads.map((th) => (
                            <Link
                                key={th.id}
                                href={tenantHref(`/exchange/threads/${th.id}`)}
                                className="flex items-center gap-default rounded-lg border border-border-subtle p-4 hover:bg-surface-subtle"
                            >
                                <span className="font-medium text-content-strong">{th.listingCommodity}</span>
                                <StatusBadge variant="neutral">
                                    {th.role === 'seller' ? t('roleSeller') : t('roleInquirer')}
                                </StatusBadge>
                                {th.hasUnread ? (
                                    <StatusBadge variant="success">{t('unread')}</StatusBadge>
                                ) : null}
                                {th.closed ? (
                                    <StatusBadge variant="neutral">{t('closed')}</StatusBadge>
                                ) : null}
                                <span className="ml-auto text-sm text-content-muted">
                                    {formatDateTime(th.lastMessageAt)}
                                </span>
                            </Link>
                        ))
                    )}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
