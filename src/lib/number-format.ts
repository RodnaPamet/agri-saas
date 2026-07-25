/**
 * First-party number / currency formatting helpers.
 *
 * Replaces the `nFormatter` / `currencyFormatter` utilities formerly
 * pulled from the `Dub utils` shim. Same input→output contract so the
 * chart/tooltip call sites render identically.
 */

/** Currencies that have no minor (cents) unit — values are whole. */
const ZERO_DECIMAL_CURRENCIES = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
    'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

function isZeroDecimalCurrency(currency: string): boolean {
    return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
}

const SI_UNITS = [
    { value: 1e18, symbol: 'E' },
    { value: 1e15, symbol: 'P' },
    { value: 1e12, symbol: 'T' },
    { value: 1e9, symbol: 'G' },
    { value: 1e6, symbol: 'M' },
    { value: 1e3, symbol: 'K' },
    { value: 1, symbol: '' },
] as const;

// Strips a trailing `.0`, `.00`, … (and trailing zeros after a real
// decimal) from a fixed-precision string: "1.0" → "1", "1.50" → "1.5".
const TRAILING_ZEROS = /\.0+$|(\.[0-9]*[1-9])0+$/;

/**
 * Compact human number formatter: `1500 → "1.5K"`, `2_000_000 → "2M"`.
 * `opts.full` formats with grouping separators instead (`"2,000,000"`).
 * `opts.digits` controls fractional precision (default 1).
 */
export function nFormatter(
    value?: number | bigint,
    opts: { digits?: number; full?: boolean } = {},
): string {
    const num = value !== undefined ? Number(value) : undefined;
    const digits = opts.digits ?? 1;

    if (!num) return '0';
    if (opts.full) return new Intl.NumberFormat('en-US').format(num);

    if (num < 1) return num.toFixed(digits).replace(TRAILING_ZEROS, '$1');

    const unit = SI_UNITS.find((u) => num >= u.value);
    if (!unit) return '0';
    return (
        (num / unit.value).toFixed(digits).replace(TRAILING_ZEROS, '$1') +
        unit.symbol
    );
}

interface CurrencyFormatterOptions extends Intl.NumberFormatOptions {
    trailingZeroDisplay?: 'auto' | 'stripIfInteger';
}

/**
 * Format a value given in the currency's minor unit (cents) as a
 * localized currency string. Zero-decimal currencies (e.g. JPY) are
 * treated as whole units; everything else is divided by 100.
 */
export function currencyFormatter(
    valueInCents: number | bigint | null | undefined,
    options?: CurrencyFormatterOptions,
): string {
    const cents =
        valueInCents == null
            ? 0
            : typeof valueInCents === 'bigint'
              ? Number(valueInCents)
              : valueInCents;
    const currency = options?.currency ?? 'USD';
    const zeroDecimal = isZeroDecimalCurrency(currency);

    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        trailingZeroDisplay: zeroDecimal ? 'stripIfInteger' : 'auto',
        ...options,
    } as CurrencyFormatterOptions).format(zeroDecimal ? cents : cents / 100);
}

/**
 * The locale every first-party number rendering is pinned to.
 *
 * NOT `undefined` (the runtime default). `toLocaleString(undefined)`
 * resolves to the *host* locale, which differs between the Node process
 * that server-renders a page and the browser that hydrates it — so an
 * unpinned separator is a hydration mismatch waiting for the first
 * visitor whose OS is not en-US. `nFormatter` / `currencyFormatter`
 * above already pin the same value; this exposes it for the grouping
 * cases they do not cover.
 */
export const NUMBER_LOCALE = 'en-US';

/**
 * Grouped decimal for display: `"1234.5" → "1,234.5"`.
 *
 * Takes the value as a `string | number` because Decimal columns cross
 * the wire as exact strings — the parse happens here, at the very last
 * step before rendering, and never earlier.
 */
export function formatDecimal(
    value: string | number | null | undefined,
    maximumFractionDigits = 2,
    fallback = '—',
): string {
    if (value == null || value === '') return fallback;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits }).format(n);
}
