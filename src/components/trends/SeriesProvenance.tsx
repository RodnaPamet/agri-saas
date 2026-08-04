'use client';

/**
 * Provenance line for a price: WHERE it came from, HOW OLD it is, and what it
 * is not.
 *
 * Every rendered price on the Trends surface carries one of these. The reason
 * is that the backend computes source, label, currency and observation date
 * honestly, and the UI used to drop all four — so an official EU quote and the
 * median of three neighbours' ASKING prices on our own noticeboard rendered
 * pixel-identically under the same "Market trends" heading. A farmer pricing a
 * harvest off the second one, believing it was the first, loses real money.
 *
 * Two disclosures are not cosmetic:
 *
 *   - **Own noticeboard.** The listings index is what sellers are ASKING on
 *     Agrent. It is not a transaction price and not independent of us.
 *   - **Delayed.** Barchart redistributes exchange data; showing it needs a
 *     per-exchange licence (Euronext EMDA for MATIF) and disclosing the delay
 *     is a standard term of those licences. It is also just true — the feed is
 *     10-15 min behind and the pull adds up to 20 more.
 *
 * Shared by the dashboard widget and the Prices tab so the wording cannot
 * drift between the two places a farmer reads the same number.
 *
 * @module components/trends/SeriesProvenance
 */
import { useTranslations } from 'next-intl';

import { InfoTooltip } from '@/components/ui/tooltip';
import { formatDate } from '@/lib/format-date';
import {
    isDelayedSource,
    isOwnMarketplaceSource,
    isStale,
    sourceLabelKey,
    type TrendSeries,
} from './trends-helpers';

export interface SeriesProvenanceProps {
    series: Pick<TrendSeries, 'source' | 'stage' | 'lastObservedAt'>;
    /** Payload-level server timestamp — the reference for staleness. */
    generatedAt: string;
    /** Omit the source name (the caller already labels it, e.g. a tile title). */
    hideSource?: boolean;
    className?: string;
}

export function SeriesProvenance({
    series,
    generatedAt,
    hideSource = false,
    className = '',
}: SeriesProvenanceProps) {
    const t = useTranslations('trends');
    const sourceKey = sourceLabelKey(series.source);
    const own = isOwnMarketplaceSource(series.source);
    const delayed = isDelayedSource(series.source);
    const stale = isStale(series, generatedAt);

    return (
        <div className={`flex flex-wrap items-center gap-x-tight gap-y-0.5 text-xs ${className}`}>
            {!hideSource && (
                <span className="text-content-muted">
                    {own ? t('provenance.ownListings') : t(`sources.${sourceKey}`)}
                </span>
            )}

            {/* The stage matters: ex-farm and delivered-to-port are materially
                different prices for the same grain in the same week. */}
            {series.stage && (
                <span className="text-content-subtle">
                    {t('provenance.stageLabel', { stage: series.stage })}
                </span>
            )}

            {series.lastObservedAt && (
                <span
                    className={stale ? 'font-medium text-content-warning' : 'text-content-subtle'}
                >
                    {stale
                        ? t('provenance.stale', { date: formatDate(series.lastObservedAt) })
                        : t('provenance.asOf', { date: formatDate(series.lastObservedAt) })}
                </span>
            )}
            {/* A stale price is the one a reader most needs spelled out — "as
                of" alone reads as reassurance rather than as a warning. */}
            {stale && series.lastObservedAt && (
                <InfoTooltip
                    content={t('provenance.staleAria', {
                        date: formatDate(series.lastObservedAt),
                    })}
                />
            )}

            {own && <InfoTooltip content={t('provenance.ownListingsHint')} />}

            {delayed && (
                <>
                    <span className="text-content-subtle">{t('provenance.delayed')}</span>
                    <InfoTooltip content={t('provenance.delayedHint')} />
                </>
            )}
        </div>
    );
}
