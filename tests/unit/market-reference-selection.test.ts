/**
 * `getMarketReferences` picks ONE series per commodity, and which one must
 * not depend on row order.
 *
 * The defect this file exists for (#1072): the old tie-break was
 *
 *     candidate.observedAt > existing.observedAt
 *
 * strictly greater — and EC quotes every series for a week on the SAME date.
 * Production had 21 wheat series sharing 2026-07-20, so every comparison was
 * false and the winner was whichever row Postgres returned first. Across a
 * 178.00–250.00 EUR/t spread, in the number a farmer's grain is benchmarked
 * against. Not a wrong answer — a NON-DETERMINISTIC one, which is worse,
 * because it cannot be reproduced from the inputs.
 *
 * So the load-bearing assertion here is ORDER-INDEPENDENCE: the same set of
 * series, fed in different orders, must yield the same reference. A test that
 * feeds one order and checks the value would have passed against the bug.
 */
const mockFindMany = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        marketPriceSeries: { findMany: (...args: unknown[]) => mockFindMany(...args) },
        marketPricePoint: { groupBy: jest.fn() },
    },
}));
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { getMarketReferences } from '@/app-layer/usecases/trends';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** One series row as the query selects it. */
function series(opts: {
    id: string;
    stage: string | null;
    price: number;
    date?: string;
    commodity?: string;
    unit?: string;
    currency?: string;
}) {
    return {
        id: opts.id,
        commodity: opts.commodity ?? 'wheat',
        source: 'ec-agrifood',
        currency: opts.currency ?? 'EUR',
        unit: opts.unit ?? 'EUR/t',
        stage: opts.stage,
        points: [{ date: d(opts.date ?? '2026-07-20'), price: opts.price }],
    };
}

const NATIONAL = 'National Average - Not Specified';

beforeEach(() => mockFindMany.mockReset());

describe('the selection is deterministic', () => {
    // The exact shape that was live: many series, one date, wide spread.
    const tied = [
        series({ id: 's1', stage: 'Stara Zagora - DEPPROD', price: 178.0 }),
        series({ id: 's2', stage: NATIONAL, price: 183.29 }),
        series({ id: 's3', stage: 'Varna - DEPPROD', price: 199.0 }),
        series({ id: 's4', stage: 'Burgas - DEPPROD', price: 181.0 }),
    ];

    it('prefers the national average when every series ties on date', async () => {
        mockFindMany.mockResolvedValue(tied);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('gives the SAME answer for every input order', async () => {
        // The bug was invisible to any single ordering. Drive several.
        const orders = [
            tied,
            [...tied].reverse(),
            [tied[1], tied[0], tied[3], tied[2]],
            [tied[3], tied[2], tied[1], tied[0]],
        ];
        const answers: number[] = [];
        for (const order of orders) {
            mockFindMany.mockResolvedValue(order);
            const refs = await getMarketReferences(['wheat']);
            answers.push(refs.get('wheat')!.pricePerTonne);
        }
        expect(new Set(answers).size).toBe(1);
        expect(answers[0]).toBe(183.29);
    });

    it('a fresher national average beats a stale one', async () => {
        mockFindMany.mockResolvedValue([
            series({ id: 'old', stage: NATIONAL, price: 150, date: '2026-01-01' }),
            series({ id: 'new', stage: NATIONAL, price: 183.29, date: '2026-07-27' }),
        ]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('a stale NATIONAL average still beats a fresh delivery point', async () => {
        // Rank dominates recency, deliberately: a depot quote is a different
        // question, not a fresher answer to the same one.
        mockFindMany.mockResolvedValue([
            series({ id: 'depot', stage: 'Varna - DEPPROD', price: 199, date: '2026-07-27' }),
            series({ id: 'natl', stage: NATIONAL, price: 183.29, date: '2026-07-20' }),
        ]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('falls back to a delivery point when there is no national average', async () => {
        // Sunflower's only BG series is FGATE — measured on production.
        mockFindMany.mockResolvedValue([
            series({ id: 'sf', stage: 'FGATE', price: 420, commodity: 'sunflower' }),
        ]);
        const refs = await getMarketReferences(['sunflower']);
        expect(refs.get('sunflower')?.pricePerTonne).toBe(420);
    });
});

describe('the query asks the database the right question', () => {
    it('filters to the benchmark region and orders totally', async () => {
        mockFindMany.mockResolvedValue([]);
        await getMarketReferences(['wheat']);
        const arg = mockFindMany.mock.calls[0][0];

        // Region is the whole point: without it a Bulgarian farm was
        // benchmarked against Greek and Romanian quotes.
        expect(arg.where.region).toBe('BG');
        // And RON/t series (Romania) can no longer arrive in a currency the
        // caller did not ask for.
        expect(arg.where.source.in).toContain('ec-agrifood');
        // An orderBy is what makes "first row wins" reproducible.
        expect(arg.orderBy).toBeDefined();
        expect(Array.isArray(arg.orderBy)).toBe(true);
    });
});

describe('what is NOT a reference', () => {
    it('a commodity with no series yields nothing, not a foreign quote', async () => {
        // Consumers already handle this: grain-net-worth raises the
        // NO_MARKET_PRICE refusal. A missing benchmark is honest; a Greek one
        // presented as Bulgarian is not.
        mockFindMany.mockResolvedValue([]);
        const refs = await getMarketReferences(['barley']);
        expect(refs.has('barley')).toBe(false);
    });

    it('a per-bushel quote is refused — no unit conversion is invented', async () => {
        mockFindMany.mockResolvedValue([
            series({ id: 'bu', stage: NATIONAL, price: 6.2, unit: 'USD/bu', currency: 'USD' }),
        ]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.has('wheat')).toBe(false);
    });

    it('a series with no observations is skipped', async () => {
        mockFindMany.mockResolvedValue([{ ...series({ id: 'e', stage: NATIONAL, price: 1 }), points: [] }]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.has('wheat')).toBe(false);
    });

    it('no commodities asked means no query at all', async () => {
        const refs = await getMarketReferences([]);
        expect(refs.size).toBe(0);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
});
