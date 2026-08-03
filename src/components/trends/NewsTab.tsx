'use client';

/**
 * Trends → News tab.
 *
 * A scrollable, attribution-first card feed of agri-news headlines aggregated
 * from RSS/Atom feeds by the `news-pull` job into the GLOBAL MarketNewsItem
 * cache. Each card links OUT to the publisher in a new tab — we render title +
 * snippet + source + date + optional thumbnail ONLY (no full-text). Infinite
 * scroll via cursor pagination (`useCursorPagination` seeded from the SWR head
 * page), with a manual "Load more" fallback for no-IntersectionObserver envs.
 *
 * States: loading skeleton → error+retry → empty (or, when feeds are
 * unconfigured, an operator-configuration hint) → the feed.
 *
 * Lives under `src/components/trends/` (not the route folder): the
 * `single-tab-pattern` guard forbids the shared tab primitive inside
 * `src/app/**`, and the trends client tree is housed here.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowUpRight } from '@/components/ui/icons/nucleo';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useCursorPagination } from '@/components/ui/hooks/use-cursor-pagination';
import { useInViewport } from '@/components/ui/hooks/use-in-viewport';
import { CardList } from '@/components/ui/card-list';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@/lib/format-date';

/** Client mirror of `NewsItemDTO` (the usecase is server-only). */
interface NewsItem {
    id: string;
    feedSource: string;
    title: string;
    snippet: string;
    url: string;
    imageUrl: string | null;
    publishedAt: string;
}

interface NewsFeedPage {
    items: NewsItem[];
    nextCursor: string | null;
}

// ─── Card ────────────────────────────────────────────────────────────

function NewsCard({ item }: { item: NewsItem }) {
    const t = useTranslations('trends');
    return (
        <CardList.Card
            className="relative overflow-hidden transition-colors hover:border-border-emphasis"
            innerClassName="gap-compact"
            data-testid="news-card"
        >
            {item.imageUrl && (
                // Explicit width/height keep the aspect ratio reserved (no CLS);
                // decorative (alt="") — the link text carries the meaning.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    width={640}
                    height={360}
                    className="mb-3 h-40 w-full rounded-md bg-bg-muted object-cover"
                />
            )}

            <div className="flex items-center justify-between gap-tight">
                <span className="inline-flex max-w-trunc-tight items-center truncate rounded-full bg-bg-muted px-2 py-0.5 text-xs font-medium text-content-emphasis">
                    {item.feedSource}
                </span>
                <time
                    dateTime={item.publishedAt}
                    className="shrink-0 text-xs tabular-nums text-content-muted"
                >
                    {formatDate(item.publishedAt)}
                </time>
            </div>

            <div className="mt-1 flex items-start gap-tight">
                <Heading level={3} className="line-clamp-3 flex-1">
                    {item.title}
                </Heading>
                <ArrowUpRight
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-content-muted"
                />
            </div>

            {item.snippet && (
                <p className="line-clamp-3 text-sm text-content-muted">
                    {item.snippet}
                </p>
            )}

            {/* Stretched link — whole card opens the article in a new tab. */}
            <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('news.openArticleAria', { source: item.feedSource })}
                className="absolute inset-0 z-10 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-offset-2"
            >
                <span className="sr-only">{item.title}</span>
            </a>
        </CardList.Card>
    );
}

// ─── Feed ────────────────────────────────────────────────────────────

export function NewsTab({ newsConfigured }: { newsConfigured: boolean }) {
    const t = useTranslations('trends');
    const apiUrl = useTenantApiUrl();

    const { data, error, mutate } = useTenantSWR<NewsFeedPage>(
        CACHE_KEYS.trends.news(),
    );

    const pager = useCursorPagination<NewsItem>({
        initialRows: [],
        initialNextCursor: null,
        fetchUrl: (cursor) =>
            apiUrl(`/trends/news?cursor=${encodeURIComponent(cursor)}`),
    });

    // Reseed the accumulator whenever the SWR head page (re)loads.
    const { reload } = pager;
    useEffect(() => {
        if (data) reload(data.items, data.nextCursor);
    }, [data, reload]);

    // Auto-load the next page when the sentinel scrolls into view.
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const sentinelVisible = useInViewport(sentinelRef);
    const { hasMore, loading: loadingMore, loadMore } = pager;
    useEffect(() => {
        if (sentinelVisible && hasMore && !loadingMore) void loadMore();
    }, [sentinelVisible, hasMore, loadingMore, loadMore]);

    const rows = pager.rows;

    // Distinct source labels, in first-seen order, for the attribution line.
    const sourceList = useMemo(() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of rows) {
            if (!seen.has(r.feedSource)) {
                seen.add(r.feedSource);
                out.push(r.feedSource);
            }
        }
        return out.join(', ');
    }, [rows]);

    const isLoading = !data && !error;

    // ── Error ──
    if (error) {
        return (
            <section id="trends-news-panel" className="space-y-section">
                <EmptyState
                    variant="no-results"
                    title={t('news.errorTitle')}
                    description={t('news.errorBody')}
                    data-testid="news-error"
                >
                    <Button variant="secondary" onClick={() => void mutate()}>
                        {t('news.retry')}
                    </Button>
                </EmptyState>
            </section>
        );
    }

    // ── Loading ──
    if (isLoading) {
        return (
            <section id="trends-news-panel" className="space-y-section">
                <CardList data-testid="news-loading">
                    {[0, 1, 2, 3].map((i) => (
                        <Card key={i} className="space-y-default">
                            <Skeleton className="h-40 w-full" />
                            <Skeleton className="h-4 w-1/3" />
                            <Skeleton className="h-5 w-full" />
                            <Skeleton className="h-4 w-2/3" />
                        </Card>
                    ))}
                </CardList>
            </section>
        );
    }

    // ── Empty ──
    if (rows.length === 0) {
        return (
            <section id="trends-news-panel" className="space-y-section">
                <EmptyState
                    variant="no-records"
                    title={t('news.emptyTitle')}
                    description={t('news.emptyBody')}
                    data-testid="news-empty"
                >
                    {!newsConfigured && (
                        <div
                            className="mt-default rounded-lg border border-border-subtle bg-bg-muted px-4 py-3 text-left"
                            data-testid="news-operator-hint"
                        >
                            <p className="text-xs font-semibold text-content-emphasis">
                                {t('news.operatorTitle')}
                            </p>
                            <p className="mt-1 text-xs text-content-muted">
                                {t('news.operatorBody', { feeds: 'MARKET_NEWS_FEEDS' })}
                            </p>
                        </div>
                    )}
                </EmptyState>
            </section>
        );
    }

    // ── Feed ──
    return (
        <section id="trends-news-panel" className="space-y-section">
            <CardList aria-label={t('news.feedAriaLabel')} data-testid="news-feed">
                {rows.map((item) => (
                    <NewsCard key={item.id} item={item} />
                ))}
            </CardList>

            {/* Infinite-scroll sentinel + manual fallback. */}
            {hasMore && (
                <div ref={sentinelRef} className="flex justify-center">
                    <Button
                        variant="secondary"
                        onClick={() => void loadMore()}
                        loading={loadingMore}
                    >
                        {t('news.loadMore')}
                    </Button>
                </div>
            )}

            {/* Attribution — sources feeding this list. */}
            {sourceList && (
                <p className="text-xs text-content-muted" data-testid="news-attribution">
                    {t('news.attribution', { list: sourceList })}
                </p>
            )}
        </section>
    );
}
