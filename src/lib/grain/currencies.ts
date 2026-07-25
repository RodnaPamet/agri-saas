/**
 * ISO-4217 currency codes offered for contract pricing.
 *
 * `Contract.priceCurrency` was a free-text input, and the org portfolio
 * labels a whole farm's money with the first contract's raw string — so
 * one operator typing "eur", another "EUR" and a third "€" produced
 * three currencies as far as every rollup was concerned, and the KPI
 * subtitle rendered whatever landed first.
 *
 * Deliberately a SHORT list, not all ~180 ISO codes: these are the
 * currencies grain is actually contracted in for this product's markets,
 * and a 180-item dropdown is its own usability problem. The set is
 * additive — an unrecognised stored value is preserved and shown rather
 * than silently dropped (see `currencyOptions`), so widening the list
 * never invalidates existing rows.
 */

/** Code + the symbol/name shown beside it in the picker. */
export const CONTRACT_CURRENCIES: ReadonlyArray<{ code: string; symbol: string }> = [
    { code: 'BGN', symbol: 'лв.' },
    { code: 'EUR', symbol: '€' },
    { code: 'USD', symbol: '$' },
    { code: 'GBP', symbol: '£' },
    { code: 'RON', symbol: 'lei' },
    { code: 'PLN', symbol: 'zł' },
    { code: 'HUF', symbol: 'Ft' },
    { code: 'CHF', symbol: 'CHF' },
    { code: 'UAH', symbol: '₴' },
    { code: 'TRY', symbol: '₺' },
    { code: 'CAD', symbol: 'CA$' },
    { code: 'AUD', symbol: 'A$' },
];

const KNOWN = new Set(CONTRACT_CURRENCIES.map((c) => c.code));

/** True for a code this product offers in the picker. */
export function isKnownCurrency(code: string | null | undefined): boolean {
    return code != null && KNOWN.has(code.toUpperCase());
}

/**
 * Picker options, with `current` preserved at the top when it is a value
 * we do not offer.
 *
 * Dropping an unknown stored currency would silently rewrite the row's
 * price basis the next time anyone edited an unrelated field — the kind
 * of quiet data change nobody reviews.
 */
export function currencyOptions(
    current?: string | null,
): Array<{ value: string; label: string }> {
    const base = CONTRACT_CURRENCIES.map((c) => ({
        value: c.code,
        label: `${c.code} · ${c.symbol}`,
    }));
    const trimmed = current?.trim();
    if (trimmed && !isKnownCurrency(trimmed)) {
        return [{ value: trimmed, label: trimmed }, ...base];
    }
    return base;
}
