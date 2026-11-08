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
 *     `prisma/migrations/20260729120000_exchange_euro_denomination`. That
 *     migration carries its own rate as a SQL literal (1.95583 — the lev's
 *     peg since 1999, and the irrevocable euro-adoption rate), which is why
 *     this module no longer exports it: the conversion was a one-off on data
 *     that is already converted, and a migration is immutable, so the
 *     authority for what was applied is the migration itself.
 *
 *     A `BGN_PER_EUR` constant and a `bgnToEur` helper lived here until
 *     #2793 and are GONE. They had drifted into a live converter — the cost
 *     calculator and `rent-basis.ts` both divided by the peg at READ time —
 *     and converting a stored figure on every read is a different act from
 *     converting a column once. A lev amount is now REFUSED wherever one can
 *     still arrive, so do not re-add either: a peg constant with no consumer
 *     is the next relabelling waiting for a caller.
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
