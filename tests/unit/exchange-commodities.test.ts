/**
 * Unit — canonical commodity taxonomy.
 *
 * Commodity was free text, so "wheat" / "Wheat" / "пшеница" never grouped.
 * The catalog gives each a stable key + bg/en labels; these lock the
 * key↔label round-trip, the free-text → key normalisation (both locales),
 * and the OTHER long-tail fallback.
 */
import {
    localizedCommodityLabel,
    commodityKeyFor,
    commodityOptions,
    isCommodityKey,
    asExchangeLocale,
    OTHER_COMMODITY_KEY,
    COMMODITY_KEYS,
} from '@/lib/exchange/commodities';

describe('localizedCommodityLabel', () => {
    it('resolves a canonical key to its label in each locale', () => {
        expect(localizedCommodityLabel('WHEAT', null, 'en')).toBe('Wheat');
        expect(localizedCommodityLabel('WHEAT', null, 'bg')).toBe('Пшеница');
        expect(localizedCommodityLabel('SUNFLOWER', null, 'bg')).toBe('Слънчоглед');
    });
    it('falls back to the free text for OTHER / unknown keys', () => {
        expect(localizedCommodityLabel('OTHER', 'Triticale', 'en')).toBe('Triticale');
        expect(localizedCommodityLabel(null, 'Quinoa', 'bg')).toBe('Quinoa');
        expect(localizedCommodityLabel('NOT_A_KEY', 'Spelt', 'en')).toBe('Spelt');
    });
});

describe('commodityKeyFor — free text → canonical key (both locales, case-insensitive)', () => {
    it('unifies spelling + language onto one key', () => {
        expect(commodityKeyFor('wheat')).toBe('WHEAT');
        expect(commodityKeyFor('Wheat')).toBe('WHEAT');
        expect(commodityKeyFor('  WHEAT ')).toBe('WHEAT');
        expect(commodityKeyFor('пшеница')).toBe('WHEAT');
        expect(commodityKeyFor('Пшеница')).toBe('WHEAT');
    });
    it('returns OTHER for the long tail + empty', () => {
        expect(commodityKeyFor('Quinoa')).toBe(OTHER_COMMODITY_KEY);
        expect(commodityKeyFor('')).toBe(OTHER_COMMODITY_KEY);
        expect(commodityKeyFor(null)).toBe(OTHER_COMMODITY_KEY);
    });
});

describe('commodityOptions — localized label, stable key value', () => {
    it('lists every canonical key with its localized label', () => {
        const en = commodityOptions('en');
        const bg = commodityOptions('bg');
        expect(en.map((o) => o.value)).toEqual([...COMMODITY_KEYS]);
        expect(en.find((o) => o.value === 'MAIZE')?.label).toBe('Maize');
        expect(bg.find((o) => o.value === 'MAIZE')?.label).toBe('Царевица');
    });
});

describe('helpers', () => {
    it('isCommodityKey excludes OTHER / unknown / null', () => {
        expect(isCommodityKey('WHEAT')).toBe(true);
        expect(isCommodityKey('OTHER')).toBe(false);
        expect(isCommodityKey('NOPE')).toBe(false);
        expect(isCommodityKey(null)).toBe(false);
    });
    it('asExchangeLocale narrows to en/bg (default en)', () => {
        expect(asExchangeLocale('bg')).toBe('bg');
        expect(asExchangeLocale('en')).toBe('en');
        expect(asExchangeLocale('fr')).toBe('en');
        expect(asExchangeLocale(null)).toBe('en');
    });
});
