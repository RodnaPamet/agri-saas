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
 */

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
