/**
 * Pure helpers for ExchangeMap — split out so they're unit-testable without
 * importing maplibre-gl (which needs a browser/WebGL and can't load in jsdom).
 */

export interface ExchangeMapListing {
    id: string;
    side: 'SELL' | 'BUY';
    commodity: string;
    commodityKey: string | null;
    quantityTonnes: string;
    pricePerTonne: string | null;
    priceCurrency: string;
    regionCode: string;
    regionName: string;
    lat: number;
    lon: number;
}

/**
 * Rebuild a full ExchangeMapListing from a clustered-source point's flattened
 * GeoJSON properties (for the popup). Carries `regionCode` through — dropping
 * it (the old `regionCode: ''`) broke the detail Sheet's region + filter
 * context when a listing was opened from a map popup.
 */
export function featureToMapListing(p: Record<string, unknown>): ExchangeMapListing {
    return {
        id: String(p.id),
        side: p.side as 'SELL' | 'BUY',
        commodity: String(p.commodity),
        commodityKey: p.commodityKey != null ? String(p.commodityKey) : null,
        quantityTonnes: String(p.quantityTonnes),
        pricePerTonne: p.pricePerTonne ? String(p.pricePerTonne) : null,
        priceCurrency: String(p.priceCurrency),
        regionCode: String(p.regionCode ?? ''),
        regionName: String(p.regionName),
        lat: Number(p.lat),
        lon: Number(p.lon),
    };
}
