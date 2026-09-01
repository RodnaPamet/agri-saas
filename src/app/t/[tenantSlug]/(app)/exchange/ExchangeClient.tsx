'use client';

/**
 * Exchange main page — split view: a map of Bulgaria (left) + a synced,
 * filterable offer list (right).
 *
 *   - Data: SWR GET /exchange/listings (public projection across all tenants),
 *     returning ONE CURSOR PAGE as `{ rows, nextCursor }`.
 *   - Filters: Epic 53 FilterToolbar (side / kind / commodity / region /
 *     quantity + live search), applied SERVER-SIDE. They used to run
 *     client-side over whatever the feed happened to return, which was the
 *     newest 100 offers NATIONWIDE — so "Wheat in Dobrich" searched a sample
 *     and reported the result as the market. The filter state is now the SWR
 *     key, so Postgres answers the question over the whole table.
 *   - Pagination: `useCursorPagination` accumulates pages behind a "Load more"
 *     practice. SWR owns page 1 (keyed by the active filters); a filter change
 *     reseeds the accumulator via `reload`.
 *   - Market pulse: the ticker aggregates the LOADED rows and says so — see
 *     the currency + sample notes on `ticker` below.
 *   - Map ↔ list sync: an oblast click toggles the region filter; hovering a
 *     list row highlights its marker; clicking a row (or a marker popup's
 *     "View details") opens the detail Sheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    parseRangeToken,
} from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { Fab } from '@/components/ui/fab';
import { PullToRefresh, useCursorPagination } from '@/components/ui/hooks';
import { ScrollToTop } from '@/components/ui/scroll-to-top';
import { Heading } from '@/components/ui/typography';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { useTenantHref, useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiGet } from '@/lib/api-client';
import { formatDate } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { localizedRegionName } from '@/lib/geo/bulgaria-regions';
import {
    EXCHANGE_CURRENCY,
    isAggregatable,
    formatPricePerTonne,
} from '@/lib/exchange/currency';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';
import { EXCHANGE_SIDE_COLORS, EXCHANGE_ACCENT_GOLD } from '@/components/exchange/ExchangeMap';
import { buildExchangeFilters, EXCHANGE_FILTER_KEYS } from './filter-defs';
import { commodityLabel } from '@/lib/market/commodity-label';
import { CreateOfferModal } from './CreateOfferModal';
import { InquiryModal } from './InquiryModal';
import { ExchangeNav } from './ExchangeNav';

// The map uses browser-only APIs (a 2D <canvas> — NOT maplibre; see
// ExchangeMap's docblock) — keep it off the SSR graph.
const ExchangeMap = dynamic(
    () => import('@/components/exchange/ExchangeMap').then((m) => m.ExchangeMap),
    { ssr: false },
);

/** Page size requested from the feed; matches the server default. */
const PAGE_SIZE = 50;

interface ListingPage {
    rows: ExchangePublicListing[];
    nextCursor: string | null;
}

export function ExchangeClient() {
    const filterCtx = useFilterContext([], EXCHANGE_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <ExchangeInner />
        </FilterProvider>
    );
}

/** Product-kind → exchange.client i18n key (#11). */
const KIND_LABEL_KEY: Record<'CULTURE' | 'FERTILIZER' | 'SEEDS' | 'PRODUCT', string> = {
    CULTURE: 'kindCulture',
    FERTILIZER: 'kindFertilizer',
    SEEDS: 'kindSeeds',
    PRODUCT: 'kindProduct',
};

/** Listing lifecycle → i18n key. Unknown values fall back to the raw enum. */
const LISTING_STATUS_KEY: Record<string, string> = {
    ACTIVE: 'statusActive',
    EXPIRED: 'statusExpired',
    FULFILLED: 'statusFulfilled',
    WITHDRAWN: 'statusWithdrawn',
};

function statusVariant(status: string): 'success' | 'neutral' | 'info' {
    if (status === 'ACTIVE') return 'success';
    if (status === 'FULFILLED') return 'info';
    return 'neutral';
}

function SideDot({ side }: { side: 'SELL' | 'BUY' }) {
    return (
        <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: EXCHANGE_SIDE_COLORS[side] }}
        />
    );
}

function ExchangeInner() {
    const t = useTranslations('exchange.client');
    const tFilters = useTranslations('exchangeFilters');
    // Commodity labels already exist for all 15 slugs in both locales under
    // `trends.commodities` — the Exchange just never consumed them, so a
    // Bulgarian operator read `wheat`.
    const tCommodity = useTranslations('trends.commodities');
    const locale = useLocale();
    const tonne = t('unitTonne');
    const tenantHref = useTenantHref();
    const buildApiUrl = useTenantApiUrl();
    const searchParams = useSearchParams();
    const deepLinkId = searchParams.get('listing');
    const { state, search, toggle } = useFilters();

    // ── The filter state IS the query ───────────────────────────────────
    // Serialised into the feed URL, which is also the SWR cache key, so a
    // filter change is a new server query rather than a re-filter of a
    // stale, truncated sample.
    const query = useMemo(() => {
        const p = new URLSearchParams();
        const push = (key: string, values?: string[]) => {
            if (values?.length) p.set(key, values.join(','));
        };
        push('side', state.side);
        push('kind', state.kind);
        push('commodity', state.commodity);
        push('region', state.region);
        const range = state.quantity?.[0] ? parseRangeToken(state.quantity[0]) : null;
        if (range?.min != null) p.set('minTonnes', String(range.min));
        if (range?.max != null) p.set('maxTonnes', String(range.max));
        const q = search.trim();
        if (q) p.set('q', q);
        p.set('limit', String(PAGE_SIZE));
        return p.toString();
    }, [state, search]);

    const { data, isLoading, error, mutate } = useTenantSWR<ListingPage>(
        `/exchange/listings?${query}`,
    );

    // Page 1 comes from SWR (re-keyed on every filter change); later pages are
    // accumulated here. `reload` reseeds when SWR hands over a new first page.
    const feedUrl = useCallback(
        (cursor: string) => buildApiUrl(`/exchange/listings?${query}&cursor=${encodeURIComponent(cursor)}`),
        [buildApiUrl, query],
    );
    const {
        rows: offers,
        hasMore,
        loading: loadingMore,
        error: pageError,
        loadMore,
        reload,
    } = useCursorPagination<ExchangePublicListing>({
        initialRows: [],
        initialNextCursor: null,
        fetchUrl: feedUrl,
    });
    // Page 1, normalised.
    //
    // Tolerate a payload that isn't the current wire shape: the SWR cache is
    // DISK-BACKED (localStorage + IndexedDB, `persistent-cache.ts`), so the
    // first load after this deploy can hand back a bare array cached under the
    // previous contract — and spreading `undefined.rows` would blank the page
    // rather than degrade it.
    const firstPage = useMemo(() => {
        const rows = Array.isArray(data) ? data : data?.rows;
        return {
            rows: Array.isArray(rows) ? rows : [],
            nextCursor: (Array.isArray(data) ? null : data?.nextCursor) ?? null,
        };
    }, [data]);

    // Reseed the accumulator on CONTENT, not on the `data` reference.
    //
    // A reference-keyed effect deadlocks against any SWR-shaped source that
    // returns a fresh object per render: reseed → re-render → fresh object →
    // reseed. Real SWR keeps `data` stable between revalidations so it would
    // not bite in production, which is precisely what makes it a bad thing to
    // depend on. The signature is O(page size) over ≤50 ids per render.
    const pageSignature = `${firstPage.rows.map((r) => r.id).join(',')}|${firstPage.nextCursor ?? ''}`;
    const seededRef = useRef<string | null>(null);
    useEffect(() => {
        if (seededRef.current === pageSignature) return;
        seededRef.current = pageSignature;
        reload(firstPage.rows, firstPage.nextCursor);
        // `firstPage` is derived from `pageSignature`'s inputs; keying the
        // effect on the signature is what makes the reseed idempotent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageSignature, reload]);

    const selectedRegionCodes = state.region ?? [];

    // ── Commodity facet options ─────────────────────────────────────────
    // Read from an UNFILTERED page, not from `offers`.
    //
    // Deriving them from the displayed rows worked while filtering was
    // client-side over the whole fetched array. Now that the server answers
    // the filtered query, the displayed rows ARE the selection — so a farmer
    // who picked "Wheat" would find the dropdown collapsed to "Wheat" and no
    // way back to the others.
    //
    // When no facet is active this key is identical to the feed's, so SWR
    // dedupes it to zero extra requests; only a filtered view pays for the
    // second read. Selected values are unioned in so a choice can never
    // vanish from its own dropdown even if it falls off page 1.
    const { data: facetPage } = useTenantSWR<ListingPage>(
        `/exchange/listings?limit=${PAGE_SIZE}`,
    );
    const commodityOptions = useMemo(() => {
        const rows = Array.isArray(facetPage) ? facetPage : facetPage?.rows;
        const set = new Set<string>(Array.isArray(rows) ? rows.map((o) => o.commodity) : []);
        for (const c of state.commodity ?? []) set.add(c);
        return [...set];
    }, [facetPage, state.commodity]);

    const liveFilters = useMemo(
        () => buildExchangeFilters(tFilters, commodityOptions, tCommodity),
        [tFilters, commodityOptions, tCommodity],
    );

    // ── Market pulse ────────────────────────────────────────────────────
    // Two honesty rules, both of which this ticker used to break.
    //
    // 1. CURRENCY. It averaged `pricePerTonne` across every row and labelled
    //    the result with `priced[0].priceCurrency` — so one USD listing at the
    //    head of the array relabelled a euro average as dollars, and a mixed
    //    feed produced a number that was not a price in any currency. Only
    //    rows in the marketplace currency are averaged now; anything else is
    //    counted and disclosed, and still shows its own price on its own card.
    //
    // 2. SAMPLE. Tonnage / provinces / offer count describe the rows LOADED,
    //    which is one page unless the user pages further. When more exist, the
    //    ticker says so instead of presenting a page as the nation.
    const ticker = useMemo(() => {
        const tonnes = offers.reduce((a, o) => a + (Number(o.quantityTonnes) || 0), 0);
        const provinces = new Set(offers.map((o) => o.regionCode)).size;
        const allPriced = offers.filter((o) => Number(o.pricePerTonne) > 0);
        const priced = allPriced.filter((o) => isAggregatable(o.priceCurrency));
        const avg = priced.length
            ? Math.round(priced.reduce((a, o) => a + Number(o.pricePerTonne), 0) / priced.length)
            : null;
        return {
            offers: offers.length,
            tonnes: Math.round(tonnes),
            provinces,
            avg,
            cur: EXCHANGE_CURRENCY,
            /** Priced rows left OUT of the average because they float. */
            excluded: allPriced.length - priced.length,
        };
    }, [offers]);

    const [hoveredId, setHoveredId] = useState<string | null>(null);
    // Seed the selection from the deep link (`?listing=<id>`) at mount so a
    // shared/emailed link opens the detail Sheet directly — no setState in the
    // effect below, which only performs the standalone fetch.
    const [selectedId, setSelectedId] = useState<string | null>(deepLinkId);
    const [createOpen, setCreateOpen] = useState(false);
    const [inquiryOpen, setInquiryOpen] = useState(false);
    // If the deep-linked listing isn't on the loaded page, fetch it standalone
    // (GET /exchange/listings/<id>) so the Sheet can render it.
    const [fetchedListing, setFetchedListing] = useState<ExchangePublicListing | null>(null);
    useEffect(() => {
        if (!deepLinkId || offers.some((o) => o.id === deepLinkId)) return;
        let cancelled = false;
        void apiGet<ExchangePublicListing>(buildApiUrl(`/exchange/listings/${deepLinkId}`))
            .then((l) => { if (!cancelled) setFetchedListing(l); })
            .catch(() => { /* missing / withdrawn — leave the Sheet unopened */ });
        return () => { cancelled = true; };
    }, [deepLinkId, offers, buildApiUrl]);

    // Optimistically add a freshly-created listing to the shared SWR cache so
    // it lands on the map + list instantly, then revalidate to reconcile.
    function handleCreated(created: ExchangePublicListing) {
        void mutate(
            { rows: [created, ...(data?.rows ?? [])], nextCursor: data?.nextCursor ?? null },
            { revalidate: true },
        );
    }
    const selectedOffer = useMemo(
        () =>
            offers.find((o) => o.id === selectedId)
            ?? (fetchedListing?.id === selectedId ? fetchedListing : null),
        [offers, selectedId, fetchedListing],
    );
    // Interest can only be expressed in an offer that is still live. The Sheet
    // is reachable by deep link at ANY status (`getListing` returns whatever
    // the id points at), so a fulfilled or withdrawn offer used to render a
    // fully enabled "Express interest" button whose only possible outcome was
    // a 400 from the state machine.
    const selectedIsOpen = selectedOffer?.status === 'ACTIVE';

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbExchange') },
                    ]}
                    className="mb-1"
                />
                <div className="flex flex-wrap items-center justify-between gap-default">
                    <div className="flex flex-wrap items-center gap-section">
                        <Heading level={1}>{t('heading')}</Heading>
                        {/* SELL/BUY colour legend — matches the map markers. */}
                        <div className="flex items-center gap-default text-xs text-content-muted">
                            <span className="flex items-center gap-compact">
                                <SideDot side="SELL" /> {t('legendSelling')}
                            </span>
                            <span className="flex items-center gap-compact">
                                <SideDot side="BUY" /> {t('legendBuying')}
                            </span>
                        </div>
                    </div>
                    <Button
                        variant="primary"
                        icon={<Plus />}
                        id="new-offer-btn"
                        onClick={() => setCreateOpen(true)}
                    >
                        {t('newOffer')}
                    </Button>
                </div>
                <ExchangeNav />
            </ListPageShell.Header>

            <ListPageShell.Filters>
                <FilterToolbar
                    filters={liveFilters}
                    searchId="exchange-search"
                    searchPlaceholder={t('searchPlaceholder')}
                />
            </ListPageShell.Filters>

            <ListPageShell.Body>
                {/* Market-pulse ticker — liveness + trust. Mobile-first: a single
                    strip that scrolls horizontally on a narrow pane. */}
                <div className="mb-default flex shrink-0 items-center gap-compact overflow-x-auto rounded-lg border border-border-subtle bg-bg-default/60 px-3 py-2 text-xs backdrop-blur-sm">
                    <span className="flex shrink-0 items-center gap-1.5">
                        <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: EXCHANGE_ACCENT_GOLD }}
                        />
                        <span className="tracking-wide text-content-muted">{t('tickerLive')}</span>
                    </span>
                    {ticker.offers > 0 ? (
                        <>
                            <span className="whitespace-nowrap font-mono tabular-nums text-content-secondary">
                                {t('tickerSummary', {
                                    tonnes: ticker.tonnes.toLocaleString(),
                                    offers: ticker.offers,
                                    provinces: ticker.provinces,
                                    price: ticker.avg ?? '—',
                                    cur: ticker.cur,
                                })}
                            </span>
                            {/* Say what the figures leave out, rather than let a
                                partial answer pass for a complete one. */}
                            {ticker.excluded > 0 && (
                                <span className="whitespace-nowrap text-content-muted">
                                    {t('tickerOtherCurrencies', { count: ticker.excluded })}
                                </span>
                            )}
                            {hasMore && (
                                <span className="whitespace-nowrap text-content-muted">
                                    {t('tickerPartialSample')}
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="whitespace-nowrap text-content-muted">{t('tickerEmpty')}</span>
                    )}
                </div>
                <div className="flex min-h-0 flex-1 gap-default overflow-hidden max-md:flex-col">
                    {/* Map — fills the pane. On desktop it flexes to fill the row
                        (definite height from the ListPageShell chain). Below md the
                        page scrolls naturally and `flex-1` (flex-basis:0%) would
                        override the explicit height, leaving the <Map>'s height:100%
                        to resolve against a non-definite box → a 0-height canvas.
                        Gate flex to md+ so mobile uses the definite h-[46vh]. */}
                    <div className="min-h-0 overflow-hidden md:flex-1 max-md:h-[46vh] max-md:min-h-[18rem]">
                        <ExchangeMap
                            listings={offers}
                            selectedRegionCodes={selectedRegionCodes}
                            onRegionClick={(code) => toggle('region', code)}
                            onListingSelect={(id) => setSelectedId(id)}
                            highlightedId={hoveredId}
                        />
                    </div>

                    {/* Synced offer list — scrolls. */}
                    <div className="flex min-h-0 w-full flex-col md:w-[380px]">
                        <p className="mb-default flex-shrink-0 text-xs text-content-muted">
                            {error
                                ? t('couldntLoad')
                                : isLoading
                                  ? t('loadingOffers')
                                  : hasMore
                                    ? t('offerCountPartial', { count: offers.length })
                                    : t('offerCount', { count: offers.length })}
                        </p>
                        <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                            {error && offers.length === 0 ? (
                                <ErrorState
                                    description={t('loadError')}
                                    onRetry={() => { void mutate(); }}
                                />
                            ) : isLoading ? (
                                <div className="space-y-default" aria-busy="true">
                                    {[0, 1, 2, 3].map((i) => (
                                        <Skeleton key={i} className="h-20 w-full rounded-lg" />
                                    ))}
                                </div>
                            ) : offers.length === 0 ? (
                                <div className="rounded-lg border border-border-subtle p-4 text-sm text-content-muted">
                                    {t('emptyFiltered')}
                                </div>
                            ) : (
                            <>
                            {offers.map((o) => (
                                <button
                                    key={o.id}
                                    type="button"
                                    onMouseEnter={() => setHoveredId(o.id)}
                                    onMouseLeave={() => setHoveredId(null)}
                                    onClick={() => setSelectedId(o.id)}
                                    className={cn(
                                        'w-full space-y-tight rounded-lg border p-3 text-left transition',
                                        hoveredId === o.id
                                            ? 'border-border-emphasis bg-bg-subtle'
                                            : 'border-border-subtle hover:border-border-emphasis',
                                    )}
                                >
                                    <div className="flex items-center gap-compact">
                                        <SideDot side={o.side} />
                                        <span className="font-medium text-content-emphasis">
                                            {commodityLabel(tCommodity, o.commodity)}
                                        </span>
                                        <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-secondary">
                                            {t(KIND_LABEL_KEY[o.kind])}
                                        </span>
                                        <span className="text-xs text-content-muted">
                                            {o.side === 'SELL' ? t('selling') : t('buying')}
                                        </span>
                                        {o.isOwn && (
                                            <span className="ml-auto rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-secondary">
                                                {t('yourOffer')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-sm text-content-secondary">
                                        {o.quantityTonnes} {tonne}
                                        {o.pricePerTonne
                                            ? ` · ${formatPricePerTonne(o.pricePerTonne, o.priceCurrency, tonne)}`
                                            : ''}
                                    </div>
                                    <div className="text-xs text-content-muted">
                                        {localizedRegionName(o.regionCode, locale, o.regionName)}
                                        {o.sellerDisplayName ? ` · ${o.sellerDisplayName}` : ''}
                                    </div>
                                </button>
                            ))}
                            {/* Paging forward is what turns "the newest 50" into
                                the market. Without it the counts, the map's
                                national best and the ticker all described a
                                sample while reading like a census. */}
                            {hasMore && (
                                <div className="space-y-tight pb-1">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="w-full"
                                        loading={loadingMore}
                                        onClick={() => { void loadMore(); }}
                                    >
                                        {t('loadMore')}
                                    </Button>
                                    {pageError && (
                                        <p role="alert" className="text-xs text-content-error">
                                            {t('loadMoreError')}
                                        </p>
                                    )}
                                </div>
                            )}
                            </>
                            )}
                        </div>
                    </div>
                </div>
            </ListPageShell.Body>

            {/* Detail Sheet. */}
            <Sheet
                open={selectedId != null}
                onOpenChange={(o) => {
                    if (!o) setSelectedId(null);
                }}
                direction="right"
                title={
                    selectedOffer
                        ? commodityLabel(tCommodity, selectedOffer.commodity)
                        : t('sheetOffer')
                }
                description={t('sheetDescription')}
            >
                <Sheet.Header
                    title={
                        selectedOffer
                            ? commodityLabel(tCommodity, selectedOffer.commodity)
                            : t('sheetOffer')
                    }
                />
                <Sheet.Body className="space-y-section">
                    {selectedOffer && (
                        <div className="space-y-default text-sm">
                            <div className="flex flex-wrap items-center gap-compact">
                                <SideDot side={selectedOffer.side} />
                                <span className="font-medium text-content-emphasis">
                                    {selectedOffer.side === 'SELL' ? t('selling') : t('buying')}
                                </span>
                                {/* The Sheet is reachable by deep link at any
                                    status, so it has to SAY which one — an
                                    expired offer used to be indistinguishable
                                    from a live one right up to the failed
                                    inquiry. */}
                                <StatusBadge variant={statusVariant(selectedOffer.status)}>
                                    {LISTING_STATUS_KEY[selectedOffer.status]
                                        ? t(LISTING_STATUS_KEY[selectedOffer.status])
                                        : selectedOffer.status}
                                </StatusBadge>
                                {selectedOffer.isOwn && (
                                    <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-secondary">
                                        {t('yourOffer')}
                                    </span>
                                )}
                            </div>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-section gap-y-tight text-content-secondary">
                                <dt className="text-content-muted">{t('detailQuantity')}</dt>
                                <dd>{selectedOffer.quantityTonnes} {tonne}</dd>
                                <dt className="text-content-muted">{t('detailPrice')}</dt>
                                <dd>
                                    {selectedOffer.pricePerTonne
                                        ? formatPricePerTonne(
                                              selectedOffer.pricePerTonne,
                                              selectedOffer.priceCurrency,
                                              tonne,
                                          )
                                        : t('marketNegotiable')}
                                </dd>
                                <dt className="text-content-muted">{t('detailRegion')}</dt>
                                <dd>
                                    {localizedRegionName(
                                        selectedOffer.regionCode,
                                        locale,
                                        selectedOffer.regionName,
                                    )}
                                </dd>
                                <dt className="text-content-muted">{t('detailPosted')}</dt>
                                <dd>{formatDate(selectedOffer.createdAt)}</dd>
                                {selectedOffer.expiresAt && (
                                    <>
                                        <dt className="text-content-muted">{t('detailExpires')}</dt>
                                        <dd>{formatDate(selectedOffer.expiresAt)}</dd>
                                    </>
                                )}
                                <dt className="text-content-muted">{t('detailSeller')}</dt>
                                <dd>{selectedOffer.sellerDisplayName || t('anonymousFarm')}</dd>
                            </dl>
                            {selectedOffer.description && (
                                <p className="whitespace-pre-wrap text-content-muted">{selectedOffer.description}</p>
                            )}
                            {/* Contact happens only through a mediated inquiry — and never
                                on your own listing. */}
                            {!selectedOffer.isOwn && (
                                <div className="space-y-tight">
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        className="w-full"
                                        disabled={!selectedIsOpen}
                                        onClick={() => setInquiryOpen(true)}
                                    >
                                        {t('expressInterest')}
                                    </Button>
                                    {!selectedIsOpen && (
                                        <p className="text-xs text-content-muted">{t('closedToInterest')}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </Sheet.Body>
            </Sheet>

            <CreateOfferModal open={createOpen} setOpen={setCreateOpen} onCreated={handleCreated} />
            <InquiryModal
                open={inquiryOpen}
                setOpen={setInquiryOpen}
                listing={selectedOffer}
                onSent={() => setSelectedId(null)}
            />

            {/* Mobile-only pull-to-refresh + scroll-to-top affordances. */}
            <PullToRefresh onRefresh={() => mutate()} />
            <ScrollToTop />

            {/* Mobile-only FAB — the primary create action in the thumb
                zone (md:hidden; the header button is the desktop affordance). */}
            <Fab
                onClick={() => setCreateOpen(true)}
                label={t('fabLabel')}
                icon={<Plus aria-hidden className="h-6 w-6" />}
            />
        </ListPageShell>
    );
}
