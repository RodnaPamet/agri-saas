/**
 * Canonical commodity taxonomy for the Exchange.
 *
 * Commodity was stored as free text, so "wheat" / "Wheat" / "пшеница" never
 * matched or grouped across languages. Listings now carry a stable
 * `commodityKey` from this catalog (the free-text `commodity` is kept for the
 * OTHER long tail), so browse / filter / group unify regardless of spelling or
 * language, and the displayed label is localized.
 */

export type ExchangeLocale = 'en' | 'bg';

export interface CommodityDef {
    key: string;
    en: string;
    bg: string;
}

/** The canonical catalog (mirrors the former CreateOfferModal seed). */
export const COMMODITIES: readonly CommodityDef[] = [
    { key: 'WHEAT', en: 'Wheat', bg: 'Пшеница' },
    { key: 'MAIZE', en: 'Maize', bg: 'Царевица' },
    { key: 'SUNFLOWER', en: 'Sunflower', bg: 'Слънчоглед' },
    { key: 'BARLEY', en: 'Barley', bg: 'Ечемик' },
    { key: 'RAPESEED', en: 'Rapeseed', bg: 'Рапица' },
    { key: 'OATS', en: 'Oats', bg: 'Овес' },
    { key: 'RYE', en: 'Rye', bg: 'Ръж' },
    { key: 'SOYBEAN', en: 'Soybean', bg: 'Соя' },
    { key: 'PEAS', en: 'Peas', bg: 'Грах' },
    { key: 'LENTILS', en: 'Lentils', bg: 'Леща' },
] as const;

/** Free-text sentinel — the long tail that isn't in the catalog. */
export const OTHER_COMMODITY_KEY = 'OTHER';

const BY_KEY: Record<string, CommodityDef> = Object.fromEntries(
    COMMODITIES.map((c) => [c.key, c]),
);

/** All valid canonical keys (excludes OTHER). */
export const COMMODITY_KEYS: readonly string[] = COMMODITIES.map((c) => c.key);

/** Is this a known canonical key (OTHER and unknowns are not)? */
export function isCommodityKey(key: string | null | undefined): key is string {
    return !!key && key !== OTHER_COMMODITY_KEY && key in BY_KEY;
}

/**
 * Map a free-text commodity string to a canonical key, case-insensitively and
 * across both locales. Returns OTHER when nothing matches — the long tail.
 */
export function commodityKeyFor(text: string | null | undefined): string {
    const norm = (text ?? '').trim().toLowerCase();
    if (!norm) return OTHER_COMMODITY_KEY;
    for (const c of COMMODITIES) {
        if (
            c.key.toLowerCase() === norm ||
            c.en.toLowerCase() === norm ||
            c.bg.toLowerCase() === norm
        ) {
            return c.key;
        }
    }
    return OTHER_COMMODITY_KEY;
}

/**
 * The localized label for a listing's commodity. A canonical key resolves to
 * the catalog label in `locale`; OTHER (or an unknown key) falls back to the
 * stored free text.
 */
export function localizedCommodityLabel(
    key: string | null | undefined,
    freeText: string | null | undefined,
    locale: ExchangeLocale,
): string {
    if (isCommodityKey(key)) return BY_KEY[key][locale];
    return (freeText ?? '').trim() || (key ?? '');
}

/** Combobox options — localized label + the stable key as the submitted value. */
export function commodityOptions(locale: ExchangeLocale): { value: string; label: string }[] {
    return COMMODITIES.map((c) => ({ value: c.key, label: c[locale] }));
}

/** Narrow an arbitrary string to a valid ExchangeLocale (default 'en'). */
export function asExchangeLocale(locale: string | null | undefined): ExchangeLocale {
    return locale === 'bg' ? 'bg' : 'en';
}
