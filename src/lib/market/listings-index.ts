/**
 * Own-listings weekly price index — PURE, no DB.
 *
 * Computes a WEEKLY MEDIAN price per (commodity, currency) across ALL
 * tenants' ACTIVE ExchangeListings. This is cross-tenant by design (a market
 * signal only makes sense pooled), so PRIVACY is enforced by a k-anonymity
 * floor: a (commodity, currency) group is emitted ONLY when it draws on at
 * least `LISTINGS_K_ANON_FLOOR` DISTINCT tenants. Below the floor the group is
 * suppressed entirely. The emitted point carries only `{ median, count }` —
 * never a listing id or tenant id.
 *
 * Kept prisma-free so the k-anonymity invariant is unit-testable in memory.
 *
 * ## The median is per TENANT, not per listing
 *
 * The estimator used to push one price per LISTING while counting one entry
 * per TENANT. A tenant with 100 listings at 9 999 alongside two tenants with
 * one listing each published 9 999 as "the market price" — and reported
 * `count: 3`, which actively reassured the reader that three independent
 * parties agreed. One account could set the number the whole product quotes,
 * at no cost and with no signal.
 *
 * Each tenant is therefore collapsed to its OWN median first, and the
 * published figure is the median of those. One tenant is one vote however
 * many listings it posts, so moving the index requires moving a majority of
 * distinct tenants — which is what the k-anonymity floor was always assuming.
 *
 * The floor itself is unchanged: it is a PRIVACY practice and it was correct.
 *
 * @module lib/market/listings-index
 */

import { normalizeCommodity, type CanonicalCommodity } from './commodity-vocabulary';

/** Minimum DISTINCT tenants required to publish a (commodity, currency) group. */
export const LISTINGS_K_ANON_FLOOR = 3;

/** One ACTIVE listing's price-relevant fields (all listings are per-tonne). */
export interface ListingPriceRow {
    /**
     * Raw commodity as stored on the listing. Normalised to the canonical
     * vocabulary HERE rather than assumed canonical, because the column has
     * been free text since it shipped and holds Title-Case, lowercase and
     * Bulgarian spellings of the same grain.
     */
    commodity: string;
    /** Price per tonne (listings with a null price are pre-filtered out). */
    pricePerTonne: number;
    /** Listing currency (BGN default). */
    priceCurrency: string;
    /** Owning tenant — used ONLY to count distinct tenants, never stored. */
    sellerTenantId: string;
}

/** A k-anon-cleared weekly median for one (commodity, currency). */
export interface ListingMedianGroup {
    /** Canonical slug — matches `MarketPriceSeries.commodity` exactly. */
    commodity: CanonicalCommodity;
    currency: string;
    /** Chart unit — all exchange prices are per tonne. */
    unit: string;
    /** Median price per tonne, rounded to 2 dp. */
    median: number;
    /** Number of DISTINCT contributing tenants (≥ floor). */
    count: number;
}

/** Median of a non-empty numeric list (mean of the two middles when even). */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const m = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return Math.round(m * 100) / 100;
}

/**
 * Compute the k-anonymised weekly median index. Groups by (commodity,
 * currency); suppresses any group backed by fewer than
 * `LISTINGS_K_ANON_FLOOR` distinct tenants; returns the survivors sorted
 * deterministically.
 */
export function computeListingsMedianIndex(rows: ListingPriceRow[]): ListingMedianGroup[] {
    // pricesByTenant, not a flat price list — see the module docblock.
    const groups = new Map<
        string,
        { commodity: CanonicalCommodity; currency: string; byTenant: Map<string, number[]> }
    >();

    for (const r of rows) {
        if (!Number.isFinite(r.pricePerTonne)) continue;
        // An unrecognised spelling is SKIPPED rather than grouped under its raw
        // form: a one-off group can never clear the k-anon floor anyway, and
        // admitting it would let free text fragment a real group's tenants.
        const commodity = normalizeCommodity(r.commodity);
        if (!commodity) continue;
        const currency = r.priceCurrency || 'BGN';
        const key = `${commodity}||${currency}`;
        let g = groups.get(key);
        if (!g) {
            g = { commodity, currency, byTenant: new Map() };
            groups.set(key, g);
        }
        const list = g.byTenant.get(r.sellerTenantId);
        if (list) list.push(r.pricePerTonne);
        else g.byTenant.set(r.sellerTenantId, [r.pricePerTonne]);
    }

    const out: ListingMedianGroup[] = [];
    for (const g of groups.values()) {
        // k-anonymity: suppress groups drawing on too few distinct tenants.
        if (g.byTenant.size < LISTINGS_K_ANON_FLOOR) continue;
        // One vote per tenant: collapse each tenant's listings to that tenant's
        // own median, then take the median across tenants.
        const tenantMedians = [...g.byTenant.values()].map((prices) => median(prices));
        out.push({
            commodity: g.commodity,
            currency: g.currency,
            unit: `${g.currency}/t`,
            median: median(tenantMedians),
            count: g.byTenant.size,
        });
    }

    out.sort((a, b) => a.commodity.localeCompare(b.commodity) || a.currency.localeCompare(b.currency));
    return out;
}
