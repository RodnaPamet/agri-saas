'use client';

/**
 * Trends → News tab.
 *
 * A personalized "For You" tab + keyword search + category filter over the
 * aggregated agri-news feed.
 *
 *   • Category filter — `For You / All / Market / Policy / General`.
 *   • For You — filters the feed to items matching ANY of the user's chosen
 *     interest keywords (server-persisted per user; edited via a modal).
 *   • Search — a LIVE, client-side keyword box that composes on top of both.
 *
 * All filtering is client-side over the already-loaded feed, so it's instant.
 * Degrades to a skeleton while loading, a combined empty + operator panel when
 * the feed is empty, a "no interests yet" prompt on For You with none set, and a
 * "no matches" note when a search/interest set yields nothing.
 *
 * Text-first (no thumbnails) — cheap on rural LTE; `imageUrl` stored for later.
 *
 * Lives under `src/components/trends/` (not the route folder): the
 * `single-tab-pattern` guard forbids `<TabSelect>` inside `src/app/**`.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { usePermissions } from '@/lib/tenant-context-provider';
import { StatusBadge } from '@/components/ui/status-badge';
import { TabSelect } from '@/components/ui/tab-select';
import { formatRelativeTime } from '@/lib/format-date';
import type { TrendNewsResponse, NewsItem } from '@/app-layer/usecases/trends';
import { InterestsModal } from './InterestsModal';

const FILTERS = ['foryou', 'all', 'market', 'policy', 'general'] as const;
type Filter = (typeof FILTERS)[number];

/** Category → StatusBadge variant. */
const CATEGORY_VARIANT: Record<string, 'info' | 'warning' | 'neutral'> = {
    market: 'info',
    policy: 'warning',
    general: 'neutral',
};

/** Case-insensitive keyword match over an item's title / summary / source. */
function matchesKeyword(item: NewsItem, kw: string): boolean {
    if (!kw) return true;
    return (
        item.title.toLowerCase().includes(kw) ||
        (item.summary ?? '').toLowerCase().includes(kw) ||
        item.source.toLowerCase().includes(kw)
    );
}

// ─── News card ───────────────────────────────────────────────────────

function NewsCard({ item, now }: { item: NewsItem; now: Date }) {
    const t = useTranslations('trends');
    const variant = CATEGORY_VARIANT[item.category] ?? 'neutral';
    return (
        <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-default"
        >
            <Card className="space-y-tight hover:border-border-emphasis">
                <div className="flex items-center justify-between gap-tight">
                    <StatusBadge variant={variant} size="sm">
                        {t(`news.categories.${item.category}`)}
                    </StatusBadge>
                    <span className="text-xs text-content-muted tabular-nums">
                        {formatRelativeTime(item.publishedAt, now)}
                    </span>
                </div>
                <p className="font-medium text-content-emphasis">{item.title}</p>
                {item.summary && (
                    <p className="line-clamp-2 text-sm text-content-muted">{item.summary}</p>
                )}
                <p className="text-xs text-content-subtle">{item.source}</p>
            </Card>
        </a>
    );
}

// ─── News tab ────────────────────────────────────────────────────────

export function NewsTab() {
    const t = useTranslations('trends');
    // Operator hints name environment variables; only admins should see them.
    const permissions = usePermissions();
    const isAdmin = permissions.admin.manage;
    // Default to the full feed (content-first); For You is the opt-in first tab.
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [modalOpen, setModalOpen] = useState(false);

    const forYou = filter === 'foryou';
    // For You has no server category — it reads the full feed and filters by the
    // user's interest keywords client-side.
    const newsCategory = forYou ? 'all' : filter;

    const { data, error } = useTenantSWR<TrendNewsResponse>(
        CACHE_KEYS.trends.news(newsCategory),
    );
    const {
        data: interestsData,
        error: interestsError,
        mutate: mutateInterests,
    } = useTenantSWR<{ keywords: string[] }>(forYou ? CACHE_KEYS.me.interests() : null);
    const interests = useMemo(() => interestsData?.keywords ?? [], [interestsData]);

    // Stable "now" for relative times within one render pass.
    const now = useMemo(() => new Date(), [data]);

    const filterOptions = useMemo(
        () => FILTERS.map((f) => ({ id: f, label: t(`news.filters.${f}`) })),
        [t],
    );

    const items = useMemo(() => data?.items ?? [], [data]);
    const q = query.trim().toLowerCase();
    // For You: keep items matching ANY interest keyword; then the search box.
    const visibleItems = useMemo(() => {
        const base = forYou
            ? items.filter((it) => interests.some((kw) => matchesKeyword(it, kw)))
            : items;
        return base.filter((it) => matchesKeyword(it, q));
    }, [items, forYou, interests, q]);

    const newsLoading = !data && !error;
    const interestsLoading = forYou && interestsData === undefined && !interestsError;
    const isLoading = newsLoading || interestsLoading;
    const noInterests = forYou && !interestsLoading && interests.length === 0;
    // ERROR and EMPTY are different facts — see the same split in PricesTab.
    // Collapsed, a 500 or a dropped connection read as "no news today".
    const isError = error != null;
    const feedEmpty = !isError && data != null && items.length === 0;
    const noMatches = !feedEmpty && items.length > 0 && visibleItems.length === 0;

    return (
        <div className="space-y-section" id="trends-news-panel">
            <div className="space-y-default">
                <Input
                    type="search"
                    id="trends-news-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('news.searchPlaceholder')}
                    aria-label={t('news.searchAria')}
                />
                <TabSelect<Filter>
                    options={filterOptions}
                    selected={filter}
                    onSelect={setFilter}
                    ariaLabel={t('news.filterAriaLabel')}
                    idPrefix="trends-news-filter-"
                />
                {forYou && !noInterests && (
                    <div className="flex items-center justify-between gap-tight">
                        <span className="text-xs text-content-muted">
                            {t('news.forYou.count', { count: interests.length })}
                        </span>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setModalOpen(true)}
                        >
                            {t('news.forYou.edit')}
                        </Button>
                    </div>
                )}
            </div>

            {isLoading ? (
                <div className="space-y-default" data-testid="trends-news-loading">
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                </div>
            ) : noInterests ? (
                <EmptyState
                    variant="no-records"
                    title={t('news.forYou.emptyTitle')}
                    description={t('news.forYou.emptyDescription')}
                    data-testid="trends-news-no-interests"
                >
                    <Button type="button" variant="primary" size="sm" onClick={() => setModalOpen(true)}>
                        {t('news.forYou.addFirst')}
                    </Button>
                </EmptyState>
            ) : isError ? (
                <ErrorState
                    title={t('news.error.title')}
                    description={t('news.error.description')}
                    data-testid="trends-news-error"
                />
            ) : feedEmpty ? (
                <EmptyState
                    variant="no-records"
                    title={t('news.empty.title')}
                    description={t('news.empty.description')}
                    data-testid="trends-news-empty"
                >
                    {/* Names MARKET_NEWS_FEEDS — an operator instruction, not
                        something a farmer can act on. Admins only. */}
                    {isAdmin && (
                        <div
                            className="mt-default rounded-lg border border-border-subtle bg-bg-muted px-4 py-3 text-left"
                            data-testid="trends-news-operator-hint"
                        >
                            <p className="text-xs font-semibold text-content-emphasis">
                                {t('news.operator.title')}
                            </p>
                            <p className="mt-1 text-xs text-content-muted">
                                {t('news.operator.body', { env: 'MARKET_NEWS_FEEDS' })}
                            </p>
                        </div>
                    )}
                </EmptyState>
            ) : noMatches ? (
                <EmptyState
                    variant="no-results"
                    title={t('news.noMatches.title')}
                    description={t('news.noMatches.description', { query: query.trim() })}
                    data-testid="trends-news-no-matches"
                />
            ) : (
                <ul className="space-y-default">
                    {visibleItems.map((item) => (
                        <li key={item.id}>
                            <NewsCard item={item} now={now} />
                        </li>
                    ))}
                </ul>
            )}

            <InterestsModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                initial={interests}
                onSaved={(keywords) => {
                    void mutateInterests({ keywords }, { revalidate: false });
                }}
            />
        </div>
    );
}
