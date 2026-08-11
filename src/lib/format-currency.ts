/**
 * The one compact-currency formatter.
 *
 * This lived in `risk-coherence.ts` until the risk-quantification uproot
 * removed the FAIR/ALE stack that module existed for. The formatter itself
 * was never risk-specific — it is the money renderer for grain-contract
 * values, yield valuations, lease rents and any other tenant-currency
 * figure — so it moved here rather than dying with its old neighbours.
 *
 * `useMoneyFormatter()` in `@/lib/tenant-context-provider` is the
 * client-side binding that supplies the tenant's currency symbol. Prefer
 * that hook in components; import this directly only where no tenant
 * context is in scope.
 *
 * Two formatters live here, and the choice between them is a rounding
 * DECISION, not a style preference — see `formatExactCurrency` below.
 * `useExactMoneyFormatter()` is its tenant-bound hook.
 */

import { formatDecimal } from '@/lib/number-format';

/**
 * Compact currency for chips, table cells and analytics tiles
 * (€1.2M, €430K, €900).
 *
 * `nullish` returns the em-dash placeholder so caller sites that would
 * otherwise write `v == null ? '—' : format(v)` collapse to one call.
 */
export function formatCompactCurrency(
    v: number | null | undefined,
    symbol = '€',
): string {
    if (v == null) return '—';
    if (v >= 1_000_000) return `${symbol}${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${symbol}${(v / 1_000).toFixed(0)}K`;
    return `${symbol}${Math.round(v)}`;
}

/**
 * Exact currency — the reconciliation sibling of
 * {@link formatCompactCurrency}. "Exact" means UNROUNDED, not fixed-width:
 * `formatDecimal(v, 2)` sets `maximumFractionDigits: 2` and no minimum, so
 * cents appear when there are cents and are omitted when there are none —
 * €18,750 / €1,200.5 / €900.25. Reach for `toFixed(2)` at a call site that
 * genuinely needs aligned decimal columns; do not "fix" it here, because
 * every current caller renders inside `tabular-nums`, where ragged
 * fractions still align on the digit grid.
 *
 * Two formatters, because rounding is a decision and not a style choice.
 * Compact is right for a dashboard tile, where €1.2M answers "roughly how
 * big"; it is WRONG for any surface a farmer reconciles against an invoice
 * or a grain ticket, where €1.2M silently hides everything between
 * €1,150,000 and €1,249,999.
 *
 * This existed twice before it existed once: `/grain/costs` wrapped it in a
 * `useCostFormatter` hook and `/grain/calculator` in a local `formatMoney`,
 * both spelling the same `symbol + formatDecimal(v, 2)` expression. That is
 * the exact drift class `tests/guards/polish-06-single-currency.test.ts`
 * was written to catch — the guard only missed the first copy because a
 * hook name reads nothing like `formatMoney`.
 *
 * Nullish returns the em-dash placeholder, matching the compact formatter
 * and `formatDate`, so callers never re-spell `v == null ? '—' : …`.
 */
export function formatExactCurrency(
    v: number | null | undefined,
    symbol = '€',
): string {
    if (v == null) return '—';
    return `${symbol}${formatDecimal(v, 2)}`;
}
