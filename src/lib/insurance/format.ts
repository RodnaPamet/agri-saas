import { NUMBER_LOCALE } from '@/lib/number-format';

/**
 * Format integer cents with the cents ALWAYS shown.
 *
 * Why this exists beside the app's existing money formatters: both
 * `formatExactCurrency` and `useExactMoneyFormatter` go through
 * `formatDecimal`, which sets only `maximumFractionDigits`. They therefore
 * render 1_000_000 as "€10,000" and 333_330 as "€3,333.3". A premium schedule
 * must always show its cents — an instalment line reading "€3,333.3" looks
 * like a typo and invites the reader to distrust the whole figure.
 *
 * `formatDecimal` is deliberately NOT changed: other screens depend on its
 * current output.
 */
export function formatCents(cents: number, symbol = '€'): string {
    const formatted = new Intl.NumberFormat(NUMBER_LOCALE, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(cents / 100);
    return `${symbol}${formatted}`;
}
