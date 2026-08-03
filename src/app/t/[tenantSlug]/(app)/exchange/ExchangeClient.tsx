'use client';

/**
 * Exchange main page — split view: a map of Bulgaria (left) + a synced,
 * filterable offer list (right). Browse-only.
 *
 *   - Data: SWR GET /exchange/listings (public projection across all tenants).
 *   - Filters: Epic 53 FilterToolbar (side / commodity / region / quantity +
 *     live search), applied CLIENT-SIDE over the fetched array.
 *   - Map ↔ list sync: an oblast click toggles the region filter; hovering a
 *     list row highlights its marker; clicking a row (or a marker popup's
 *     "View details") opens the detail Sheet.
 *   - Create: the header "Offer" button opens the create modal.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
import { Heading } from '@/components/ui/typography';
import { Sheet } from '@/components/ui/sheet';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { useTenantHref, useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiGet } from '@/lib/api-client';
import { formatDate } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTranslations, useLocale } from 'next-intl';
import { localizedCommodityLabel, asExchangeLocale } from '@/lib/exchange/commodities';
import type { ExchangePublicListing } from '@/lib/exchange/public-listing';
import { EXCHANGE_SIDE_COLORS } from '@/components/exchange/ExchangeMap';
import { buildExchangeFilters, EXCHANGE_FILTER_KEYS } from './filter-defs';
import { CreateOfferModal } from './CreateOfferModal';
import { InquiryModal } from './InquiryModal';
import { ExchangeNav } from './ExchangeNav';

// The map uses browser-only APIs (maplibre-gl) — keep it off the SSR graph.
const ExchangeMap = dynamic(
    () => import('@/components/exchange/ExchangeMap').then((m) => m.ExchangeMap),
    { ssr: false },
);

export function ExchangeClient() {
    const filterCtx = useFilterContext([], EXCHANGE_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <ExchangeInner />
        </FilterProvider>
    );
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
    const t = useTranslations('exchange');
    const locale = asExchangeLocale(useLocale());
    const tenantHref = useTenantHref();
    const buildApiUrl = useTenantApiUrl();
    const searchParams = useSearchParams();
    const deepLinkId = searchParams.get('listing');
    const { data, isLoading, error, mutate } = useTenantSWR<ExchangePublicListing[]>('/exchange/listings');
    const { state, search, toggle } = useFilters();

    const offers = useMemo(() => data ?? [], [data]);
    const selectedRegionCodes = state.region ?? [];

    // Localized commodity label — canonical key resolves to the catalog label
    // in the active locale (so "wheat"/"Wheat"/"пшеница" unify under one label),
    // free-text OTHER falls back to the stored string.
    const commodityLabel = useMemo(
        () => (o: ExchangePublicListing) => localizedCommodityLabel(o.commodityKey, o.commodity, locale),
        [locale],
    );

    // Runtime commodity filter options — distinct LOCALIZED labels (grouped by
    // key), so filtering unifies across spelling/language.
    const liveFilters = useMemo(
        () => buildExchangeFilters(offers.map(commodityLabel)),
        [offers, commodityLabel],
    );

    // Client-side filter (side / commodity / region / quantity + search).
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        const sides = state.side ?? [];
        const regions = state.region ?? [];
        const commodities = state.commodity ?? [];
        const range = state.quantity?.[0] ? parseRangeToken(state.quantity[0]) : null;
        return offers.filter((o) => {
            const label = commodityLabel(o);
            if (q && !`${label} ${o.regionName}`.toLowerCase().includes(q)) return false;
            if (sides.length && !sides.includes(o.side)) return false;
            if (regions.length && !regions.includes(o.regionCode)) return false;
            if (commodities.length && !commodities.includes(label)) return false;
            if (range) {
                const qt = Number(o.quantityTonnes);
                if (range.min != null && qt < range.min) return false;
                if (range.max != null && qt > range.max) return false;
            }
            return true;
        });
    }, [offers, search, state, commodityLabel]);

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
        void mutate([created, ...offers], { revalidate: true });
    }
    const selectedOffer = useMemo(
        () =>
            filtered.find((o) => o.id === selectedId)
            ?? offers.find((o) => o.id === selectedId)
            ?? (fetchedListing?.id === selectedId ? fetchedListing : null),
        [filtered, offers, selectedId, fetchedListing],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumb.exchange') },
                    ]}
                    className="mb-1"
                />
                <div className="flex flex-wrap items-center justify-between gap-default">
                    <div className="flex flex-wrap items-center gap-section">
                        <Heading level={1}>{t('header')}</Heading>
                        {/* SELL/BUY colour legend — matches the map markers. */}
                        <div className="flex items-center gap-default text-xs text-content-muted">
                            <span className="flex items-center gap-compact">
                                <SideDot side="SELL" /> {t('side.selling')}
                            </span>
                            <span className="flex items-center gap-compact">
                                <SideDot side="BUY" /> {t('side.buying')}
                            </span>
                        </div>
                    </div>
                    <Button
                        variant="primary"
                        icon={<Plus />}
                        id="new-offer-btn"
                        onClick={() => setCreateOpen(true)}
                    >
                        {t('create.trigger')}
                    </Button>
                </div>
                <ExchangeNav />
            </ListPageShell.Header>

            <ListPageShell.Filters>
                <FilterToolbar
                    filters={liveFilters}
                    searchId="exchange-search"
                    searchPlaceholder={t('browse.searchPlaceholder')}
                />
            </ListPageShell.Filters>

            <ListPageShell.Body>
                <div className="flex min-h-0 flex-1 gap-default overflow-hidden max-md:flex-col">
                    {/* Map — fills the pane. */}
                    <div className="min-h-0 flex-1 overflow-hidden max-md:h-[46vh] max-md:min-h-[18rem]">
                        <ExchangeMap
                            listings={filtered}
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
                                ? t('browse.loadError')
                                : isLoading
                                  ? t('browse.loading')
                                  : t('browse.count', { count: filtered.length })}
                        </p>
                        <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                            {error ? (
                                <ErrorState
                                    description={t('browse.errorDescription')}
                                    onRetry={() => { void mutate(); }}
                                />
                            ) : isLoading ? (
                                <div className="space-y-default" aria-busy="true">
                                    {[0, 1, 2, 3].map((i) => (
                                        <Skeleton key={i} className="h-20 w-full rounded-lg" />
                                    ))}
                                </div>
                            ) : filtered.length === 0 ? (
                                <div className="rounded-lg border border-border-subtle p-4 text-sm text-content-muted">
                                    {t('browse.empty')}
                                </div>
                            ) : (
                            filtered.map((o) => (
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
                                        <span className="font-medium text-content-emphasis">{commodityLabel(o)}</span>
                                        <span className="text-xs text-content-muted">
                                            {o.side === 'SELL' ? t('side.selling') : t('side.buying')}
                                        </span>
                                        {o.isOwn && (
                                            <span className="ml-auto rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-secondary">
                                                {t('detail.yourOffer')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-sm text-content-secondary">
                                        {o.quantityTonnes} t
                                        {o.pricePerTonne ? ` · ${o.pricePerTonne} ${o.priceCurrency}/t` : ''}
                                    </div>
                                    <div className="text-xs text-content-muted">
                                        {o.regionName}
                                        {o.sellerDisplayName ? ` · ${o.sellerDisplayName}` : ''}
                                    </div>
                                </button>
                            )))}
                        </div>
                    </div>
                </div>
            </ListPageShell.Body>

            {/* Detail Sheet — a shared/emailed link (?listing=<id>) opens it directly. */}
            <Sheet
                open={selectedId != null}
                onOpenChange={(o) => {
                    if (!o) setSelectedId(null);
                }}
                direction="right"
                title={selectedOffer ? commodityLabel(selectedOffer) : t('create.trigger')}
                description={selectedOffer ? commodityLabel(selectedOffer) : t('create.trigger')}
            >
                <Sheet.Header title={selectedOffer ? commodityLabel(selectedOffer) : t('create.trigger')} />
                <Sheet.Body className="space-y-section">
                    {selectedOffer && (
                        <div className="space-y-default text-sm">
                            <div className="flex items-center gap-compact">
                                <SideDot side={selectedOffer.side} />
                                <span className="font-medium text-content-emphasis">
                                    {selectedOffer.side === 'SELL' ? t('side.selling') : t('side.buying')}
                                </span>
                                {selectedOffer.isOwn && (
                                    <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-secondary">
                                        {t('detail.yourOffer')}
                                    </span>
                                )}
                            </div>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-section gap-y-tight text-content-secondary">
                                <dt className="text-content-muted">{t('detail.quantity')}</dt>
                                <dd>{selectedOffer.quantityTonnes} t</dd>
                                <dt className="text-content-muted">{t('detail.price')}</dt>
                                <dd>
                                    {selectedOffer.pricePerTonne
                                        ? `${selectedOffer.pricePerTonne} ${selectedOffer.priceCurrency}/t`
                                        : t('detail.marketNegotiable')}
                                </dd>
                                <dt className="text-content-muted">{t('detail.region')}</dt>
                                <dd>{selectedOffer.regionName}</dd>
                                {selectedOffer.expiresAt && (
                                    <>
                                        <dt className="text-content-muted">{t('detail.expires')}</dt>
                                        <dd>{formatDate(selectedOffer.expiresAt)}</dd>
                                    </>
                                )}
                                <dt className="text-content-muted">{t('detail.seller')}</dt>
                                <dd>{selectedOffer.sellerDisplayName || t('detail.anonymous')}</dd>
                            </dl>
                            {selectedOffer.description && (
                                <p className="whitespace-pre-wrap text-content-muted">{selectedOffer.description}</p>
                            )}
                            {/* Contact happens only through a mediated inquiry — and never
                                on your own listing. */}
                            {!selectedOffer.isOwn && (
                                <Button variant="primary" size="sm" className="w-full" onClick={() => setInquiryOpen(true)}>
                                    {t('detail.expressInterest')}
                                </Button>
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
        </ListPageShell>
    );
}
