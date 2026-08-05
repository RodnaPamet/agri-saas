/**
 * Contract price vs market.
 *
 * The comparison Trends existed to make and couldn't: `Contract.pricePerTonne`
 * and `MarketPriceSeries` sat in the same database for months with no join key
 * between them.
 *
 * The tests that matter are the REFUSALS. A benchmark that silently converts
 * currencies, or compares against a price nobody has published for a month,
 * is worse than no benchmark at all — it is a confident number a farmer will
 * price a harvest against.
 */
import {
    benchmarkContract,
    BENCHMARK_STALE_AFTER_DAYS,
    type MarketReference,
} from '@/lib/market/contract-benchmark';

const AS_OF = '2026-03-20T09:00:00.000Z';

const daysBefore = (n: number) =>
    new Date(Date.UTC(2026, 2, 20) - n * 86_400_000).toISOString().slice(0, 10);

function refs(over: Partial<MarketReference> = {}): ReadonlyMap<string, MarketReference> {
    return new Map([
        [
            'wheat',
            {
                commodity: 'wheat' as const,
                pricePerTonne: 200,
                currency: 'EUR',
                observedAt: daysBefore(3),
                source: 'ec-agrifood',
                ...over,
            },
        ],
    ]);
}

describe('benchmarkContract — the comparison', () => {
    it('reports a contract above market', () => {
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 220, priceCurrency: 'EUR' },
            refs(),
            AS_OF,
        );
        expect(r.status).toBe('OK');
        expect(r.deltaPerTonne).toBe(20);
        expect(r.deltaPct).toBe(10);
        // The reference travels with the verdict so the UI can attribute and
        // date the claim rather than saying "the market".
        expect(r.reference?.source).toBe('ec-agrifood');
    });

    it('reports a contract below market with a signed delta', () => {
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 180, priceCurrency: 'EUR' },
            refs(),
            AS_OF,
        );
        expect(r.deltaPerTonne).toBe(-20);
        expect(r.deltaPct).toBe(-10);
    });

    it('matches currency case-insensitively', () => {
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 200, priceCurrency: 'eur' },
            refs(),
            AS_OF,
        );
        expect(r.status).toBe('OK');
        expect(r.deltaPerTonne).toBe(0);
    });
});

describe('benchmarkContract — the refusals', () => {
    it('NEVER converts currencies', () => {
        // A BGN contract against a EUR/t quote is not comparable. Inventing an
        // FX rate to make it look comparable is the no-conversion invariant's
        // whole subject: the rate would be wrong, undated and invisible.
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 400, priceCurrency: 'BGN' },
            refs(),
            AS_OF,
        );
        expect(r.status).toBe('CURRENCY_MISMATCH');
        expect(r.deltaPerTonne).toBeNull();
        expect(r.deltaPct).toBeNull();
        // The reference is still returned so the UI can explain WHY.
        expect(r.reference).not.toBeNull();
    });

    it('treats a missing contract currency as a mismatch, not as a match', () => {
        // Assuming it matches is how two incomparable prices get subtracted.
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 200, priceCurrency: null },
            refs(),
            AS_OF,
        );
        expect(r.status).toBe('CURRENCY_MISMATCH');
    });

    it('refuses to benchmark against a stale market', () => {
        // "You are 12% below market" is a claim about TODAY.
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 220, priceCurrency: 'EUR' },
            refs({ observedAt: daysBefore(BENCHMARK_STALE_AFTER_DAYS + 1) }),
            AS_OF,
        );
        expect(r.status).toBe('MARKET_STALE');
        expect(r.deltaPerTonne).toBeNull();
    });

    it('still compares against a market inside the staleness bound', () => {
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 220, priceCurrency: 'EUR' },
            refs({ observedAt: daysBefore(BENCHMARK_STALE_AFTER_DAYS) }),
            AS_OF,
        );
        expect(r.status).toBe('OK');
    });

    it('says NO_MARKET when nothing quotes that commodity', () => {
        const r = benchmarkContract(
            { commodityCanonical: 'lentils', pricePerTonne: 900, priceCurrency: 'EUR' },
            refs(),
            AS_OF,
        );
        expect(r.status).toBe('NO_MARKET');
        expect(r.reference).toBeNull();
    });

    it('says nothing at all for a contract with no price or no nameable commodity', () => {
        // Most contracts in a real book. The absence must be quiet — a row of
        // "unknown" badges is noise that trains people to ignore the column.
        expect(
            benchmarkContract(
                { commodityCanonical: 'wheat', pricePerTonne: null, priceCurrency: 'EUR' },
                refs(),
                AS_OF,
            ).status,
        ).toBe('NO_CONTRACT_PRICE');
        expect(
            benchmarkContract(
                { commodityCanonical: null, pricePerTonne: 220, priceCurrency: 'EUR' },
                refs(),
                AS_OF,
            ).status,
        ).toBe('NO_CONTRACT_PRICE');
    });

    it('does not divide by zero on a zero market price', () => {
        const r = benchmarkContract(
            { commodityCanonical: 'wheat', pricePerTonne: 220, priceCurrency: 'EUR' },
            refs({ pricePerTonne: 0 }),
            AS_OF,
        );
        expect(r.status).toBe('OK');
        expect(r.deltaPerTonne).toBe(220);
        expect(r.deltaPct).toBeNull();
    });
});
