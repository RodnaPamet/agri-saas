/**
 * Exchange currency policy — the ONE place that decides what a price means.
 *
 * The marketplace is euro-denominated. That used to be a claim the map made
 * (`PRICE_UNIT = '€/t'`, stamped onto every chip) while the listing cards beside
 * it rendered whatever currency the row actually stored — so a 320 BGN offer
 * read "320 €/t" on the map and "320 BGN/t" in the card, the same number
 * relabelled and ~1.96× apart in real value.
 *
 * The fix is denomination, not labelling:
 *
 *   • **Legacy BGN rows were CONVERTED**, once, in
 *     `prisma/migrations/…_exchange_euro_denomination`, at
 *     {@link BGN_PER_EUR}. That figure is not a market quote — the lev has
 *     been pegged at exactly 1.95583/€ since 1999 and euro adoption uses it
 *     as the irrevocable conversion rate. Converting at a *fixed* rate is
 *     exact arithmetic, which is the only reason a data migration is a safe
 *     answer here at all.
 *
 *   • **New listings are EUR-only** ({@link EXCHANGE_CURRENCY}) — enforced by
 *     the create schema, so the write path cannot reintroduce a second
 *     denomination.
 *
 *   • **USD is NOT convertible.** It floats, so there is no rate this file
 *     could apply that would still be true tomorrow. Any USD row keeps its
 *     amount and its own label, renders with that label wherever it appears,
 *     and is EXCLUDED from every cross-listing aggregate — see
 *     {@link isAggregatableWith}. Relabelling it would be the original bug
 *     with a different pair of currencies.
 *
 * `ExchangeListing.priceCurrency` is deliberately KEPT. Dropping it would
 * leave the table unable to express the legacy rows that exist.
 */

/** The currency every NEW listing is denominated in. */
export const EXCHANGE_CURRENCY = 'EUR' as const;
export type ExchangeCurrency = typeof EXCHANGE_CURRENCY;

/**
 * The legally fixed BGN↔EUR rate (1 EUR = 1.95583 BGN), pegged since 1999 and
 * the irrevocable conversion rate for euro adoption. Exported so the migration
 * note, the tests and any future backfill all read the same constant.
 */
export const BGN_PER_EUR = 1.95583;

/** Convert a lev amount to euro at the fixed rate, rounded to 2 dp (the
 *  `Decimal(12,2)` column's precision). Mirrors the SQL migration exactly. */
export function bgnToEur(amountBgn: number): number {
    return Math.round((amountBgn / BGN_PER_EUR) * 100) / 100;
}

/** Currency symbols for the price surfaces. Unknown codes render verbatim. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
    EUR: '€',
    USD: '$',
    BGN: 'лв',
};

export function currencySymbol(currency: string): string {
    return CURRENCY_SYMBOLS[currency] ?? currency;
}

/**
 * True when `currency` may be summed/averaged/compared against other listings.
 *
 * Only the exchange currency qualifies. This is the single predicate behind
 * every aggregate on every surface — the ticker average, the map's per-group
 * price chip, the national ★ best-price ring — so "no aggregate mixes
 * currencies" is one function call rather than a convention.
 */
export function isAggregatable(currency: string): boolean {
    return currency === EXCHANGE_CURRENCY;
}

/**
 * True when every priced member of `currencies` shares ONE currency (and so
 * may be averaged), returning that currency. `null` when the set is mixed or
 * empty — the caller must then show no aggregate at all rather than a number
 * that means nothing.
 */
export function isAggregatableWith(currencies: readonly string[]): string | null {
    if (currencies.length === 0) return null;
    const first = currencies[0];
    return currencies.every((c) => c === first) ? first : null;
}

/**
 * `"320 €/t"` — a price with its OWN currency and the caller's tonne glyph
 * (latin `t` in English, cyrillic `т` in Bulgarian). Every price surface goes
 * through here so a number is never printed under a label it did not earn.
 */
export function formatPricePerTonne(
    amount: number | string,
    currency: string,
    tonneGlyph = 't',
): string {
    return `${amount} ${currencySymbol(currency)}/${tonneGlyph}`;
}
