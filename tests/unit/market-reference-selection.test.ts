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

/**
 * The exact shape that was live when #1072 was found: many series, one date,
 * a wide spread. Hoisted so the override suite's control can assert the ranking
 * is unchanged against the same data the ranking tests use — a control over
 * different data would prove nothing about the same code path.
 */
const tiedForControl = [
    series({ id: 'c1', stage: 'Stara Zagora - DEPPROD', price: 178.0 }),
    series({ id: 'c2', stage: NATIONAL, price: 183.29 }),
    series({ id: 'c3', stage: 'Varna - DEPPROD', price: 199.0 }),
];

/**
 * The feed rows every test below is about. `getMarketReferences` now issues TWO
 * queries — the feed selection and, since #1587, the platform override that
 * SUPPRESSES it — and one bare `mockResolvedValue` answered both, so the feed
 * rows came back as overrides and overwrote the very ranking these tests exist
 * to pin. A mock that cannot tell two queries apart is a mock that silently
 * changes what the test means.
 *
 * Dispatching on `where.source` is the smallest honest fix: it is the field the
 * real queries differ on.
 */
function feedRows(rows: unknown[], overrides: unknown[] = []) {
    mockFindMany.mockImplementation((args: { where?: { source?: unknown } }) => {
        const src = args?.where?.source;
        const isOverrideQuery = src === OVERRIDE_SOURCE;
        return Promise.resolve(isOverrideQuery ? overrides : rows);
    });
}

/** Must match `PLATFORM_OVERRIDE_SOURCE` in the override usecase. */
const OVERRIDE_SOURCE = 'platform';

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
        feedRows(tied);
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
            feedRows(order);
            const refs = await getMarketReferences(['wheat']);
            answers.push(refs.get('wheat')!.pricePerTonne);
        }
        expect(new Set(answers).size).toBe(1);
        expect(answers[0]).toBe(183.29);
    });

    it('a fresher national average beats a stale one', async () => {
        feedRows([
            series({ id: 'old', stage: NATIONAL, price: 150, date: '2026-01-01' }),
            series({ id: 'new', stage: NATIONAL, price: 183.29, date: '2026-07-27' }),
        ]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('a stale NATIONAL average still beats a fresh delivery point', async () => {
        // Rank dominates recency, deliberately: a depot quote is a different
        // question, not a fresher answer to the same one.
        feedRows([
            series({ id: 'depot', stage: 'Varna - DEPPROD', price: 199, date: '2026-07-27' }),
            series({ id: 'natl', stage: NATIONAL, price: 183.29, date: '2026-07-20' }),
        ]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('falls back to a delivery point when there is no national average', async () => {
        // Sunflower's only BG series is FGATE — measured on production.
        feedRows([
            series({ id: 'sf', stage: 'FGATE', price: 420, commodity: 'sunflower' }),
        ]);
        const refs = await getMarketReferences(['sunflower']);
        expect(refs.get('sunflower')?.pricePerTonne).toBe(420);
    });
});

describe('the query asks the database the right question', () => {
    it('filters to the benchmark region and orders totally', async () => {
        feedRows([]);
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
        feedRows([]);
        const refs = await getMarketReferences(['barley']);
        expect(refs.has('barley')).toBe(false);
    });

    it('a per-bushel quote is refused — no unit conversion is invented', async () => {
        feedRows([
            series({ id: 'bu', stage: NATIONAL, price: 6.2, unit: 'USD/bu', currency: 'USD' }),
        ]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.has('wheat')).toBe(false);
    });

    it('a series with no observations is skipped', async () => {
        feedRows([{ ...series({ id: 'e', stage: NATIONAL, price: 1 }), points: [] }]);
        const refs = await getMarketReferences(['wheat']);
        expect(refs.has('wheat')).toBe(false);
    });

    it('no commodities asked means no query at all', async () => {
        const refs = await getMarketReferences([]);
        expect(refs.size).toBe(0);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
});

/**
 * The superuser override SUPPRESSES the feed (#1587 contract §4).
 *
 * Owner ruling 2026-10-10: a typed price always wins, for every farm and every
 * surface, until it is cleared. This is where "every surface" becomes true for
 * the calculator and net worth, which read `getMarketReferences`.
 *
 * Applied as a post-pass rather than by admitting `'platform'` into the ranking
 * above, and these cases pin that the post-pass does not disturb it: the
 * ranking encodes #1072's fix for an `isBetter` that never fired, and an
 * override does not compete on that axis at all — it replaces the result.
 */
describe('a platform override suppresses the feed (#1587 §4)', () => {
    const override = (opts: { price: number; date?: string; unit?: string; commodity?: string }) => ({
        commodity: opts.commodity ?? 'wheat',
        source: OVERRIDE_SOURCE,
        currency: 'EUR',
        unit: opts.unit ?? 'EUR/t',
        points: [{ date: d(opts.date ?? '2026-07-21'), price: opts.price }],
    });

    it('the typed price wins, and the feed price is not reported', async () => {
        feedRows([series({ id: 's1', stage: NATIONAL, price: 183.29 })], [override({ price: 250 })]);

        const r = await getMarketReferences(['wheat']);

        expect(r.get('wheat')?.pricePerTonne).toBe(250);
        // Suppressed, not averaged and not offered alongside as comparable.
        expect(r.get('wheat')?.source).toBe(OVERRIDE_SOURCE);
    });

    it('wins even when the FEED point is newer', async () => {
        // "Until cleared", not "unless the feed is fresher". A stale-only
        // fallback was explicitly rejected in favour of this.
        feedRows(
            [series({ id: 's1', stage: NATIONAL, price: 183.29, date: '2026-08-01' })],
            [override({ price: 250, date: '2026-07-01' })],
        );

        expect((await getMarketReferences(['wheat']))?.get('wheat')?.pricePerTonne).toBe(250);
    });

    it('carries the override’s own source, so a client can say which it shows', async () => {
        // Non-negotiable per §4: an overridden price that looks like a market
        // price is worse than no override.
        feedRows([series({ id: 's1', stage: NATIONAL, price: 183.29 })], [override({ price: 250 })]);

        expect((await getMarketReferences(['wheat'])).get('wheat')?.source).not.toBe('ec-agrifood');
    });

    it('an override with NO points leaves the feed selection alone', async () => {
        // A series exists but the run has no published point — a cleared run's
        // points are stamped, so this is what a cleared override looks like to
        // this query. The feed must still win rather than the commodity
        // vanishing.
        feedRows(
            [series({ id: 's1', stage: NATIONAL, price: 183.29 })],
            [{ ...override({ price: 250 }), points: [] }],
        );

        expect((await getMarketReferences(['wheat'])).get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('a non-per-tonne override is IGNORED here, by design', async () => {
        // Diesel's override is EUR/l. `getMarketReferences` answers "what is a
        // tonne of this crop worth" and filters `/\/t$/i` for exactly that
        // reason — the pull job's own comment says this filter is why diesel can
        // never reach it. An override must not be the thing that smuggles a
        // per-litre figure into a per-tonne answer.
        feedRows(
            [series({ id: 's1', stage: NATIONAL, price: 183.29 })],
            [override({ price: 1.95, unit: 'EUR/l' })],
        );

        expect((await getMarketReferences(['wheat'])).get('wheat')?.pricePerTonne).toBe(183.29);
    });

    it('does not disturb the ranking it runs after', async () => {
        // The control. With no override, the #1072 total order must produce
        // exactly what it did before the post-pass existed.
        feedRows(tiedForControl, []);

        const r = await getMarketReferences(['wheat']);
        expect(r.get('wheat')?.pricePerTonne).toBe(183.29);
    });
});

describe('the override query asks for the right rows', () => {
    it('filters out a CLEARED override, and only publishable points', async () => {
        // STRUCTURAL, and deliberately so. The mock above dispatches on
        // `where.source` and ignores the rest of the WHERE, so it cannot
        // express "this row is excluded by a filter" — a behavioural assertion
        // here would pass whether or not the filter exists, which a mutation run
        // confirmed: removing `clearedAt: null` from the query failed nothing.
        //
        // So this reads the arguments instead. Weaker than a behaviour, and
        // named as such, but it is the strongest available at this level: the
        // behavioural version lives in `tests/unit/market/price-overrides.test.ts`
        // for the form read, where the usecase does the filtering in memory.
        feedRows([series({ id: 's1', stage: NATIONAL, price: 183.29 })], []);
        await getMarketReferences(['wheat']);

        const overrideCall = mockFindMany.mock.calls
            .map((c) => c[0])
            .find((a: { where?: { source?: unknown } }) => a?.where?.source === OVERRIDE_SOURCE);

        // Control: if the override query ever stops being issued, the
        // assertions below would vacuously pass on `undefined`.
        expect(overrideCall).toBeDefined();
        // A withdrawn override is not an override.
        expect(overrideCall.where.clearedAt).toBeNull();
        // And a re-typed series is live again while its previous run's points
        // stay stamped — which only the POINT filter can express.
        expect(overrideCall.select.points.where).toEqual({ clearedAt: null });
    });
});
