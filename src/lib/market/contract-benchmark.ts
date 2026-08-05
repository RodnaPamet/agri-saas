/**
 * Contract price vs market — the comparison Trends existed to make and
 * couldn't.
 *
 * Trends was a read-only island. `Contract.pricePerTonne` and
 * `MarketPriceSeries` sat in the same database for months and never met,
 * because the four commodity vocabularies had no join key: a contract said
 * "Malting Barley", a price series said `'barley'`, and `where: { commodity }`
 * matched neither to the other. The integration was UNBUILDABLE, not merely
 * unbuilt. `Contract.commodityCanonical` is what changed that.
 *
 * ## What this deliberately refuses to do
 *
 * **No currency conversion.** A contract in BGN and a EUR/t EC quote are not
 * comparable, and inventing an FX rate to make them look comparable is the
 * exact class of defect the no-conversion invariant exists to prevent — the
 * rate would be wrong, undated, and invisible in the output. Mismatched
 * currencies return {@link BenchmarkStatus.CURRENCY_MISMATCH} and the UI says
 * so rather than showing a confident delta.
 *
 * **No cross-unit comparison.** Everything here is per-tonne on both sides;
 * a series quoted per bushel is refused for the same reason.
 *
 * **No comparison against a stale market.** A price nobody has published for
 * a month is not a benchmark. Past the staleness bound the verdict is
 * NO_MARKET, because "you are 12% below market" is a claim about today.
 *
 * @module lib/market/contract-benchmark
 */
import type { CanonicalCommodity } from './commodity-vocabulary';

/** Why a contract does or does not have a market comparison. */
export type BenchmarkStatus =
    /** Compared successfully — `deltaPerTonne` / `deltaPct` are present. */
    | 'OK'
    /** The contract has no price, or no commodity we can name. */
    | 'NO_CONTRACT_PRICE'
    /** No price series for that commodity at all. */
    | 'NO_MARKET'
    /** A series exists but its newest observation is too old to compare against. */
    | 'MARKET_STALE'
    /** Contract and market are denominated differently — never converted. */
    | 'CURRENCY_MISMATCH';

export interface MarketReference {
    commodity: CanonicalCommodity;
    /** Latest observed price, per tonne. */
    pricePerTonne: number;
    currency: string;
    /** yyyy-mm-dd of that observation. */
    observedAt: string;
    /** Backend source slug, so the UI can name it (never "some market"). */
    source: string;
}

export interface ContractPricing {
    commodityCanonical: string | null;
    pricePerTonne: number | null;
    priceCurrency: string | null;
}

export interface BenchmarkResult {
    status: BenchmarkStatus;
    /** Contract minus market, per tonne. Positive = above market. */
    deltaPerTonne: number | null;
    /** The same as a percentage of the market price. */
    deltaPct: number | null;
    /** The reference used, so the UI can attribute and date the claim. */
    reference: MarketReference | null;
}

/**
 * Days past which a market observation stops being a fair benchmark.
 *
 * Matches STALE_AFTER_DAYS in the trends helpers — two weekly publication
 * cycles plus a day. Divergence between the two would mean the UI calls a
 * price stale in one place and benchmarks against it in another.
 */
export const BENCHMARK_STALE_AFTER_DAYS = 15;

const NONE: BenchmarkResult = {
    status: 'NO_CONTRACT_PRICE',
    deltaPerTonne: null,
    deltaPct: null,
    reference: null,
};

/**
 * Compare one contract against the market reference for its commodity.
 *
 * @param asOf ISO instant the comparison is made at — passed in rather than
 *             read from the clock so the result is deterministic and testable.
 */
export function benchmarkContract(
    contract: ContractPricing,
    references: ReadonlyMap<string, MarketReference>,
    asOf: string,
): BenchmarkResult {
    if (
        !contract.commodityCanonical ||
        contract.pricePerTonne == null ||
        !Number.isFinite(contract.pricePerTonne)
    ) {
        return NONE;
    }

    const reference = references.get(contract.commodityCanonical) ?? null;
    if (!reference) {
        return { status: 'NO_MARKET', deltaPerTonne: null, deltaPct: null, reference: null };
    }

    const observed = new Date(`${reference.observedAt}T00:00:00Z`).getTime();
    const now = new Date(asOf).getTime();
    if (Number.isFinite(observed) && Number.isFinite(now)) {
        const ageDays = Math.floor((now - observed) / 86_400_000);
        if (ageDays > BENCHMARK_STALE_AFTER_DAYS) {
            return { status: 'MARKET_STALE', deltaPerTonne: null, deltaPct: null, reference };
        }
    }

    // The no-conversion invariant. A missing contract currency is treated as
    // a mismatch rather than assumed to match: guessing is how two prices that
    // cannot be compared end up subtracted from one another.
    if (
        !contract.priceCurrency ||
        contract.priceCurrency.toUpperCase() !== reference.currency.toUpperCase()
    ) {
        return { status: 'CURRENCY_MISMATCH', deltaPerTonne: null, deltaPct: null, reference };
    }

    const delta = contract.pricePerTonne - reference.pricePerTonne;
    const pct = reference.pricePerTonne === 0 ? null : (delta / reference.pricePerTonne) * 100;
    return {
        status: 'OK',
        deltaPerTonne: Math.round(delta * 100) / 100,
        deltaPct: pct == null ? null : Math.round(pct * 10) / 10,
        reference,
    };
}
