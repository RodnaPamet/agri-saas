/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror
 * runtime contracts; per-line typing has poor cost/benefit in test files
 * (the codebase's standard file-level disable). */
/**
 * Hand-entered market prices.
 *
 * The reason this path exists is that MAP and ammonium nitrate have no free
 * machine-readable feed, so the alternative to typing them is omitting them.
 * The reason it is tested this hard is that a typed number lands in the same
 * table a feed writes to and renders on the same axis — every way it can go
 * wrong is a way a farmer ends up pricing a purchase off fiction.
 *
 * Each `it()` names the production break it catches.
 */
import { Prisma } from '@prisma/client';
import { makeRequestContext } from '../../helpers/make-context';

// ── Seams ────────────────────────────────────────────────────────────

const series = {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
};
const point = { upsert: jest.fn() };
const mockDb = { marketPriceSeries: series, marketPricePoint: point } as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: any, fn: any) => fn(mockDb),
}));

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: any[]) => logEvent(...a) }));

const assertPlatformSupport = jest.fn();
jest.mock('@/lib/auth/platform-support', () => ({
    assertPlatformSupport: (...a: any[]) => assertPlatformSupport(...a),
}));

import {
    upsertManualPriceSeries,
    upsertPlatformPriceOverride,
    clearPlatformPriceOverride,
    MANUAL_SOURCE,
    PLATFORM_OVERRIDE_SOURCE,
} from '@/app-layer/usecases/market-manual-prices';
import { ManualPriceSeriesSchema } from '@/app-layer/schemas/market-manual.schemas';

const ctx = makeRequestContext('ADMIN');

function input(over: Record<string, unknown> = {}) {
    return ManualPriceSeriesSchema.parse({
        commodity: 'МАП',
        region: 'BG',
        unit: 'BGN/t',
        currency: 'BGN',
        points: [{ date: '2026-07-01', price: 1420.5 }],
        ...over,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears CALLS but not IMPLEMENTATIONS, so the gate test
    // below — which makes this throw — would otherwise poison every test
    // after it. `mockReset` is the one that drops the implementation.
    assertPlatformSupport.mockReset();
    series.findFirst.mockResolvedValue(null);
    series.create.mockResolvedValue({ id: 'ser1' });
    point.upsert.mockResolvedValue({});
    series.findMany.mockResolvedValue([]);
    series.deleteMany.mockResolvedValue({ count: 0 });
});

describe('the platform gate', () => {
    // Break: any tenant OWNER writing the price every other farm sees.
    // `admin.manage` is held by the owner of EVERY tenant, so the slug check
    // is the only thing standing between a farm and the global cache.
    it('asserts platform support before touching the database', async () => {
        assertPlatformSupport.mockImplementation(() => {
            throw new Error('not the platform tenant');
        });
        await expect(upsertManualPriceSeries(ctx, input())).rejects.toThrow('not the platform tenant');
        expect(series.findFirst).not.toHaveBeenCalled();
        expect(series.create).not.toHaveBeenCalled();
        expect(point.upsert).not.toHaveBeenCalled();
    });
});

describe('commodity resolution', () => {
    // The whole point of this path: it may name the inputs no feed covers.
    it.each([
        ['МАП', 'map'],
        ['моноамониев фосфат', 'map'],
        ['амониев нитрат', 'ammonium-nitrate'],
        ['нафта', 'diesel'],
        ['Wheat', 'wheat'],
    ])('accepts %p and stores the slug %p', async (typed, slug) => {
        const res = await upsertManualPriceSeries(ctx, input({ commodity: typed }));
        expect(res.commodity).toBe(slug);
        expect(series.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ commodity: slug, source: MANUAL_SOURCE }) }),
        );
    });

    it('refuses a commodity the vocabulary cannot name', async () => {
        await expect(upsertManualPriceSeries(ctx, input({ commodity: 'unobtainium' }))).rejects.toThrow(
            /Unknown commodity/,
        );
        expect(series.create).not.toHaveBeenCalled();
    });
});

describe('idempotency', () => {
    // Break: a re-run duplicating history. The unique key is
    // (seriesId, date), so a replay must UPDATE the point, never append one.
    it('upserts points on the natural key, so a re-run writes no duplicate', async () => {
        const payload = input({
            points: [
                { date: '2026-07-01', price: 1420.5 },
                { date: '2026-08-01', price: 1455 },
            ],
        });
        await upsertManualPriceSeries(ctx, payload);
        expect(point.upsert).toHaveBeenCalledTimes(2);
        for (const call of point.upsert.mock.calls) {
            expect(call[0].where).toHaveProperty('seriesId_date');
            expect(call[0]).toHaveProperty('update');
        }

        // Second run: the series already exists, so it is REUSED, not remade.
        jest.clearAllMocks();
        series.findFirst.mockResolvedValue({ id: 'ser1', unit: 'BGN/t', currency: 'BGN' });
        const again = await upsertManualPriceSeries(ctx, payload);
        expect(series.create).not.toHaveBeenCalled();
        expect(again.created).toBe(false);
        expect(point.upsert).toHaveBeenCalledTimes(2);
    });

    // Break: two prices typed for one day. The feeds average genuine
    // duplicate observations; averaging a TYPO produces a number nobody
    // entered and no error anywhere.
    it('rejects a duplicate date inside one payload', async () => {
        await expect(
            upsertManualPriceSeries(
                ctx,
                input({
                    points: [
                        { date: '2026-07-01', price: 1420.5 },
                        { date: '2026-07-01', price: 1999 },
                    ],
                }),
            ),
        ).rejects.toThrow(/Duplicate observation date/);
        expect(point.upsert).not.toHaveBeenCalled();
    });
});

describe('unit and currency consistency', () => {
    // Break: THE one this check exists for. currency+unit are part of the
    // natural key, so a mismatched write does NOT collide — it mints a
    // SECOND series and the chart draws two half-histories in two unit
    // groups, with no error anywhere. The constraint cannot catch this;
    // only an explicit pre-write lookup can.
    it('refuses a currency that differs from the stored series', async () => {
        series.findFirst.mockResolvedValue({ id: 'ser1', unit: 'BGN/t', currency: 'BGN' });
        await expect(upsertManualPriceSeries(ctx, input({ currency: 'EUR' }))).rejects.toThrow(
            /already recorded in BGN BGN\/t/,
        );
        expect(series.create).not.toHaveBeenCalled();
        expect(point.upsert).not.toHaveBeenCalled();
    });

    it('refuses a unit that differs from the stored series', async () => {
        series.findFirst.mockResolvedValue({ id: 'ser1', unit: 'BGN/t', currency: 'BGN' });
        await expect(upsertManualPriceSeries(ctx, input({ unit: 'BGN/kg' }))).rejects.toThrow(
            /refusing to write BGN BGN\/kg/,
        );
        expect(point.upsert).not.toHaveBeenCalled();
    });

    it('names the stored denomination in the error, so the entry can be corrected', async () => {
        series.findFirst.mockResolvedValue({ id: 'ser1', unit: 'USD/mt', currency: 'USD' });
        await expect(upsertManualPriceSeries(ctx, input({ currency: 'EUR', unit: 'EUR/t' }))).rejects.toThrow(
            /USD USD\/mt/,
        );
    });

    it('accepts a matching denomination and appends', async () => {
        series.findFirst.mockResolvedValue({ id: 'ser1', unit: 'BGN/t', currency: 'BGN' });
        const res = await upsertManualPriceSeries(ctx, input());
        expect(res).toMatchObject({ seriesId: 'ser1', created: false, pointsUpserted: 1 });
    });
});

describe('provenance and audit', () => {
    // Break: a hand-typed number indistinguishable from a live quote.
    it("stamps source 'manual' on every series it creates", async () => {
        await upsertManualPriceSeries(ctx, input());
        expect(series.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ source: 'manual' }) }),
        );
    });

    // Break: manual price entry moving money decisions with no trail. This
    // is the requirement the API-key gate could not have satisfied at all.
    it('writes a real audit event, with a category the validator accepts', async () => {
        await upsertManualPriceSeries(ctx, input());
        expect(logEvent).toHaveBeenCalledTimes(1);
        const [, , payload] = logEvent.mock.calls[0];
        expect(payload.action).toBe('MARKET_PRICE_MANUAL_UPSERT');
        expect(payload.entityType).toBe('MarketPriceSeries');
        // Only six categories exist and 'market' is not one; an off-enum
        // value makes logEvent throw a 400 at runtime.
        expect(['entity_lifecycle', 'data_lifecycle', 'status_change', 'relationship', 'access', 'custom'])
            .toContain(payload.detailsJson.category);
        expect(payload.detailsJson.after).toMatchObject({ source: 'manual', commodity: 'map' });
    });

    it('distinguishes creating a series from appending to one', async () => {
        await upsertManualPriceSeries(ctx, input());
        expect(logEvent.mock.calls[0][2].detailsJson.operation).toBe('created');

        jest.clearAllMocks();
        series.findFirst.mockResolvedValue({ id: 'ser1', unit: 'BGN/t', currency: 'BGN' });
        await upsertManualPriceSeries(ctx, input());
        expect(logEvent.mock.calls[0][2].detailsJson.operation).toBe('appended');
    });
});

describe('the write schema', () => {
    it('parses a date to UTC midnight, so it keys the same as a fed point', () => {
        const parsed = ManualPriceSeriesSchema.parse({
            commodity: 'urea', unit: 'USD/mt', currency: 'USD',
            points: [{ date: '2026-07-01', price: 400 }],
        });
        expect(parsed.points[0].date.toISOString()).toBe('2026-07-01T00:00:00.000Z');
        expect(parsed.region).toBe('BG');
    });

    it.each([
        [{ date: '2026-02-30', price: 1 }, 'a date that is not on the calendar'],
        [{ date: '01/07/2026', price: 1 }, 'a non-ISO date'],
        [{ date: '2026-07-01', price: -5 }, 'a negative price'],
        [{ date: '2026-07-01', price: Number.NaN }, 'NaN'],
        [{ date: '2026-07-01', price: Number.POSITIVE_INFINITY }, 'Infinity'],
    ])('rejects %p (%s)', (badPoint) => {
        expect(() =>
            ManualPriceSeriesSchema.parse({
                commodity: 'urea', unit: 'USD/mt', currency: 'USD', points: [badPoint],
            }),
        ).toThrow();
    });

    it('rejects a currency that is not a 3-letter ISO code', () => {
        expect(() =>
            ManualPriceSeriesSchema.parse({
                commodity: 'urea', unit: 'USD/mt', currency: 'dollars',
                points: [{ date: '2026-07-01', price: 400 }],
            }),
        ).toThrow();
    });

    it('bounds the payload — this is typing, not a bulk import', () => {
        const points = Array.from({ length: 501 }, (_, i) => ({
            date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
            price: 1,
        }));
        expect(() =>
            ManualPriceSeriesSchema.parse({
                commodity: 'urea', unit: 'USD/mt', currency: 'USD', points,
            }),
        ).toThrow();
    });
});

describe('price storage', () => {
    it('rounds to two decimals as a Decimal, matching the pull job', async () => {
        await upsertManualPriceSeries(ctx, input({ points: [{ date: '2026-07-01', price: 1420.567 }] }));
        const written = point.upsert.mock.calls[0][0].create.price;
        expect(written).toBeInstanceOf(Prisma.Decimal);
        expect(written.toString()).toBe('1420.57');
    });
});

/**
 * The superuser price OVERRIDE (#1587).
 *
 * Owner ruling 2026-10-10: a typed price always wins over the API, for every
 * farm and every surface, until it is cleared. The override shares this
 * module's write path, so most of what makes that write safe is already
 * covered above — these cases pin what is DIFFERENT, and the differences are
 * the parts that would be invisible if they broke.
 */
describe('the platform price override (#1587)', () => {
    const SER = { id: 'ovr1' };

    it('writes source "platform", not "manual"', async () => {
        series.findFirst.mockResolvedValue(null);
        series.create.mockResolvedValue(SER);

        await upsertPlatformPriceOverride(ctx, input({ commodity: 'wheat' }));

        expect(series.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ source: PLATFORM_OVERRIDE_SOURCE }),
            }),
        );
        // The two sources must stay distinct. `manual` fills a gap and has no
        // feed to outrank; `platform` overrides a live one. Reusing `manual`
        // would retroactively turn every gap-fill row ever entered into an
        // always-wins override.
        expect(PLATFORM_OVERRIDE_SOURCE).not.toBe(MANUAL_SOURCE);
    });

    it('looks for an EXISTING series under its own source only', async () => {
        // The lookup decides "append to the run in progress" vs "start one". If
        // it searched `manual`, a commodity with a gap-fill history would have
        // its override appended onto the gap-fill series — one row, two
        // meanings, and the feed silently outranked by data nobody meant as an
        // override.
        await upsertPlatformPriceOverride(ctx, input({ commodity: 'wheat' }));

        expect(series.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ source: PLATFORM_OVERRIDE_SOURCE }),
            }),
        );
    });

    it('emits a DISTINCT audit action from a manual entry', async () => {
        await upsertPlatformPriceOverride(ctx, input({ commodity: 'wheat' }));
        const overrideAction = logEvent.mock.calls[0][2].action;

        logEvent.mockClear();
        await upsertManualPriceSeries(ctx, input());
        const manualAction = logEvent.mock.calls[0][2].action;

        // Two different events to anyone reading the trail later: one filled a
        // gap, one overrode a live feed for every farm. A shared action name
        // would make them indistinguishable in exactly the audit nobody runs
        // until it matters.
        expect(overrideAction).toBe('MARKET_PRICE_OVERRIDE_UPSERT');
        expect(manualAction).toBe('MARKET_PRICE_MANUAL_UPSERT');
        expect(overrideAction).not.toBe(manualAction);
    });

    it('still refuses a SECOND denomination for the same commodity', async () => {
        // Inherited from the shared write path, asserted here because the
        // inheritance is the claim. Diesel is typed in EUR/l and the rest in
        // EUR/t, so a per-commodity denomination guard is the thing standing
        // between a 1.95 and a 1950 — and a series that changes denomination
        // mid-history renders as one continuous line and is a lie.
        series.findFirst.mockResolvedValue({ id: 'ovr1', unit: 'EUR/l', currency: 'EUR' });

        await expect(
            upsertPlatformPriceOverride(
                ctx,
                input({ commodity: 'diesel', unit: 'EUR/t', currency: 'EUR' }),
            ),
        ).rejects.toThrow(/already recorded in EUR EUR\/l/);
    });

    it('is gated like the manual write — the gate is not re-implemented', async () => {
        assertPlatformSupport.mockImplementation(() => {
            throw new Error('not the platform tenant');
        });

        await expect(upsertPlatformPriceOverride(ctx, input())).rejects.toThrow(
            'not the platform tenant',
        );
        await expect(clearPlatformPriceOverride(ctx, 'wheat')).rejects.toThrow(
            'not the platform tenant',
        );
    });
});

describe('clearing the override (#1587)', () => {
    it('returns cleared:false for an override that is not set — NOT an error', async () => {
        series.findMany.mockResolvedValue([]);

        const r = await clearPlatformPriceOverride(ctx, 'wheat');

        expect(r).toEqual({ commodity: 'wheat', cleared: false, pointsRemoved: 0 });
        // Nothing deleted and nothing logged: there was no event.
        expect(series.deleteMany).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('deletes every region and stage for the commodity', async () => {
        series.findMany.mockResolvedValue([
            { id: 'a', region: 'BG', stage: null, unit: 'EUR/t', currency: 'EUR', points: [] },
            { id: 'b', region: 'EU', stage: 'ex-works', unit: 'EUR/t', currency: 'EUR', points: [] },
        ]);
        series.deleteMany.mockResolvedValue({ count: 2 });

        const r = await clearPlatformPriceOverride(ctx, 'wheat');

        expect(r.cleared).toBe(true);
        // Scoped by commodity, not by one region: a stray row left behind would
        // keep overriding one surface while the superuser believed they had
        // cleared it.
        expect(series.deleteMany).toHaveBeenCalledWith({
            where: { source: PLATFORM_OVERRIDE_SOURCE, commodity: 'wheat' },
        });
    });

    it('records every typed point in the audit row BEFORE deleting', async () => {
        series.findMany.mockResolvedValue([
            {
                id: 'a',
                region: 'BG',
                stage: null,
                unit: 'EUR/t',
                currency: 'EUR',
                points: [
                    { date: new Date('2026-07-01T00:00:00Z'), price: new Prisma.Decimal('210.5') },
                    { date: new Date('2026-07-02T00:00:00Z'), price: new Prisma.Decimal('211') },
                ],
            },
        ]);
        series.deleteMany.mockResolvedValue({ count: 1 });

        const r = await clearPlatformPriceOverride(ctx, 'wheat');

        expect(r.pointsRemoved).toBe(2);
        const before = logEvent.mock.calls[0][2].detailsJson.before;
        // The whole reason deleting is acceptable. The read path has no source
        // filter, so "absent from the payload" has to mean deleted — and the
        // trail has to live somewhere.
        expect(before.points).toEqual([
            expect.objectContaining({ date: '2026-07-01', price: '210.5' }),
            expect.objectContaining({ date: '2026-07-02', price: '211' }),
        ]);
        expect(before.pointsTruncated).toBe(0);
    });

    it('SAYS SO when the audit trail is truncated', async () => {
        // 450 points against a 400 cap. A reader of a truncated trail must know
        // it is truncated; a prefix presented as the whole history is worse than
        // an explicit gap.
        series.findMany.mockResolvedValue([
            {
                id: 'a',
                region: 'BG',
                stage: null,
                unit: 'EUR/t',
                currency: 'EUR',
                points: Array.from({ length: 450 }, (_, i) => ({
                    date: new Date(Date.UTC(2026, 0, 1 + i)),
                    price: new Prisma.Decimal('200'),
                })),
            },
        ]);
        series.deleteMany.mockResolvedValue({ count: 1 });

        await clearPlatformPriceOverride(ctx, 'wheat');
        const before = logEvent.mock.calls[0][2].detailsJson.before;

        expect(before.pointsRemoved).toBe(450);
        expect(before.pointsRecorded).toBe(400);
        expect(before.pointsTruncated).toBe(50);
    });

    it('THROWS when the delete removes a different number than it found', async () => {
        // A delete that removed fewer rows than expected is a silent success —
        // the shape that left a DB-backed guard permanently red elsewhere in
        // this project. Assert the COUNT, never that the call returned.
        series.findMany.mockResolvedValue([
            { id: 'a', region: 'BG', stage: null, unit: 'EUR/t', currency: 'EUR', points: [] },
            { id: 'b', region: 'EU', stage: null, unit: 'EUR/t', currency: 'EUR', points: [] },
        ]);
        series.deleteMany.mockResolvedValue({ count: 1 });

        await expect(clearPlatformPriceOverride(ctx, 'wheat')).rejects.toThrow(
            /Expected to clear 2 override series for wheat, deleted 1/,
        );
    });

    it('refuses an unresolvable commodity rather than clearing nothing', async () => {
        // "Cleared nothing" and "cleared a commodity you misspelled" must not
        // look the same. A silent no-op on a typo would read as a fact about
        // the platform's position.
        // CODED, and asserted as such: a client must be able to tell "you
        // misspelled it" from "there was no override", which is a 200 with
        // `cleared: false`. The value is echoed back so the client can show
        // what it sent.
        await expect(clearPlatformPriceOverride(ctx, 'unobtainium')).rejects.toMatchObject({
            code: 'UNKNOWN_COMMODITY',
            params: { commodity: 'unobtainium' },
        });
        expect(series.deleteMany).not.toHaveBeenCalled();
    });

    it('normalises the spelling before it looks anything up', async () => {
        series.findMany.mockResolvedValue([]);

        const r = await clearPlatformPriceOverride(ctx, 'Canola');

        // The canonical value is what the key is stored under, so a client
        // sending any accepted spelling must hit the same rows.
        expect(r.commodity).toBe('rapeseed');
        expect(series.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ commodity: 'rapeseed' }),
            }),
        );
    });
});
