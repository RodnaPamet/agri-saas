/**
 * Epic 53 — Exchange browse filters.
 *
 * `side` + `region` are static option sets (region from bulgaria-regions.ts);
 * `commodity` options are runtime-derived from the fetched listings via
 * `buildExchangeFilters(offers)`; `quantity` is a numeric min/max range.
 * Filtering is CLIENT-SIDE over the fetched listing array (browse-only).
 */
import type { FilterDefInput } from '@/components/ui/filter/filter-definitions';
import { createTypedFilterDefs } from '@/components/ui/filter/filter-definitions';
import type { FilterType } from '@/components/ui/filter';
import { ArrowLeftRight, MapPin, Scale, Wheat, Tag } from 'lucide-react';
import { BULGARIA_REGIONS } from '@/lib/geo/bulgaria-regions';
import { commodityLabel, type CommodityTranslator } from '@/lib/market/commodity-label';

/** A next-intl translator scoped to the `exchangeFilters` namespace. */
type Translator = (key: string) => string;

const REGION_OPTIONS = BULGARIA_REGIONS.map((r) => ({
    value: r.code,
    label: `${r.nameBg} / ${r.nameEn}`,
}));

const STATIC_DEFS = {
    side: {
        label: 'Side',
        description: 'Sellers offering (SELL) vs buyers seeking (BUY).',
        group: 'Attributes',
        icon: ArrowLeftRight,
        options: [
            { value: 'SELL', label: 'Selling' },
            { value: 'BUY', label: 'Buying' },
        ],
        multiple: true,
        resetBehavior: 'clearable',
    },
    kind: {
        label: 'Type',
        description: 'Product class — culture, fertilizer, seeds, or product.',
        group: 'Attributes',
        icon: Tag,
        options: [
            { value: 'CULTURE', label: 'Culture' },
            { value: 'FERTILIZER', label: 'Fertilizer' },
            { value: 'SEEDS', label: 'Seeds' },
            { value: 'PRODUCT', label: 'Product' },
        ],
        multiple: true,
        resetBehavior: 'clearable',
    },
    commodity: {
        label: 'Commodity',
        description: 'The crop / product on offer.',
        group: 'Attributes',
        icon: Wheat,
        // Runtime-derived from the fetched listings — see buildExchangeFilters.
        options: null,
        multiple: true,
        resetBehavior: 'clearable',
    },
    region: {
        label: 'Region',
        description: 'Bulgarian oblast. Also set by clicking the map.',
        group: 'Location',
        icon: MapPin,
        options: REGION_OPTIONS,
        multiple: true,
        resetBehavior: 'clearable',
    },
    quantity: {
        label: 'Quantity (t)',
        description: 'Tonnes on offer.',
        group: 'Quantitative',
        icon: Scale,
        options: null,
        type: 'range',
        hideOperator: true,
        rangeNumberStep: 1,
        formatRangeBound: (n: number) => String(n),
        formatRangePillLabel: (token: string) => {
            const [min, max] = token.split('|');
            const fmt = (raw: string) => (raw === '' ? '—' : raw);
            return `${fmt(min)}–${fmt(max)} t`;
        },
        resetBehavior: 'clearable',
    },
} satisfies Record<string, FilterDefInput>;

export const exchangeFilterDefs = createTypedFilterDefs()(STATIC_DEFS);
export const EXCHANGE_FILTER_KEYS = exchangeFilterDefs.filterKeys;

/**
 * Inject runtime commodity options (distinct commodities from the feed)
 * and translate the static facet + option labels. Takes an
 * `exchangeFilters` translator so the filter dropdown / pills render in
 * the active locale.
 */
export function buildExchangeFilters(
    t: Translator,
    commodities: readonly string[],
    tCommodity?: CommodityTranslator,
): FilterType[] {
    // The VALUE stays the slug — it is what the URL param and the API query
    // carry. Only the label is localised, and it is sorted on the LABEL so
    // the dropdown reads alphabetically in the language on screen rather
    // than in slug order.
    const label = (c: string) => (tCommodity ? commodityLabel(tCommodity, c) : c);
    const commodityOptions = Array.from(new Set(commodities))
        .map((c) => ({ value: c, label: label(c) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    return exchangeFilterDefs.filters.map((f) => {
        switch (f.key) {
            case 'side':
                return {
                    ...f,
                    label: t('side'),
                    options: [
                        { value: 'SELL', label: t('sideSell') },
                        { value: 'BUY', label: t('sideBuy') },
                    ],
                };
            case 'kind':
                return {
                    ...f,
                    label: t('type'),
                    options: [
                        { value: 'CULTURE', label: t('kindCulture') },
                        { value: 'FERTILIZER', label: t('kindFertilizer') },
                        { value: 'SEEDS', label: t('kindSeeds') },
                        { value: 'PRODUCT', label: t('kindProduct') },
                    ],
                };
            case 'commodity':
                return { ...f, label: t('commodity'), options: commodityOptions };
            case 'region':
                return { ...f, label: t('region') };
            case 'quantity':
                return { ...f, label: t('quantity') };
            default:
                return f;
        }
    });
}
