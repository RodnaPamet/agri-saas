/**
 * The superuser daily price override (#1587), against the contract recorded on
 * that issue — v1 / v1.1 / v1.2 and the 12:26 clarification.
 *
 * ## Why this file exists at all
 *
 * The first implementation (#1618 at `806fe8e`) was built against a partial
 * reading of that contract and diverged from it in six ways. agrent-ios found
 * every one of them by reading the published spec. None of this repo's 5096
 * guard assertions could have: a contract published as prose on an issue is
 * invisible to a guard, so the only control is a test that encodes each clause.
 * That is what these cases are — one per clause, named after the clause.
 *
 * The clause that mattered most is §5(d): unit and currency are derived
 * server-side and never accepted from a client, because *"a caller that could
 * choose the unit could put a per-tonne figure into the litre series, and the
 * six-column key would dutifully create it."* The first implementation took
 * them from the request body.
 */
import { Prisma } from '@prisma/client';
import { makeRequestContext } from '../../helpers/make-context';

const series = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
};
const point = { upsert: jest.fn(), updateMany: jest.fn() };
/**
 * `unknown` rather than `any` throughout, which is not style policing: the
 * repo's lint ceiling counts every warning and `no-explicit-any` is by far the
 * largest category, so six casual `any`s here would have taken the whole gate
 * over. Silencing them with `eslint-disable` would not have helped — the
 * ceiling counts suppressions too, deliberately, so that muting is never the
 * cheapest fix. The sibling `manual-prices.test.ts` predates that and is left
 * alone rather than widened.
 */
const mockDb = { marketPriceSeries: series, marketPricePoint: point };
type MockDb = typeof mockDb;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: MockDb) => unknown) => fn(mockDb),
}));

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEvent(...a),
}));

const assertPlatformSupport = jest.fn();
jest.mock('@/lib/auth/platform-support', () => ({
    assertPlatformSupport: (...a: unknown[]) => assertPlatformSupport(...a),
    isPlatformTenant: () => true,
}));

import {
    upsertOverrideDay,
    clearOverride,
    readOverrideForm,
    PLATFORM_OVERRIDE_SOURCE,
} from '@/app-layer/usecases/market-price-overrides';
import { OVERRIDE_COMMODITIES, OVERRIDE_ENTRY } from '@/lib/market/price-override-denominations';

const ctx = makeRequestContext('ADMIN');
const DAY = new Date('2026-10-10T00:00:00.000Z');

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears CALLS but not IMPLEMENTATIONS, so a gate test that
    // makes this throw would otherwise poison every test after it.
    assertPlatformSupport.mockReset();
    series.findFirst.mockResolvedValue(null);
    series.findMany.mockResolvedValue([]);
    series.create.mockResolvedValue({ id: 'ser1' });
    series.update.mockResolvedValue({});
    series.updateMany.mockResolvedValue({ count: 0 });
    point.upsert.mockResolvedValue({});
    point.updateMany.mockResolvedValue({ count: 0 });
});

describe('§3 — the denomination is the SERVER’s, never the caller’s', () => {
    it('derives EUR/t for a crop, with no unit in the input at all', async () => {
        await upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'wheat', value: 210 }] });

        expect(series.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ unit: 'EUR/t', currency: 'EUR' }),
            }),
        );
    });

    it('derives EUR/l for DIESEL — the 1000× case', async () => {
        // Diesel is ~1.95 EUR/l or ~1950 EUR/t. The owner confirmed EUR/l
        // directly, after #1587 had recorded "EUR per tonne, diesel included"
        // via a relay. This is the single assertion standing between a 1.95 and
        // a 1950 in every farm's cost figures.
        await upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'diesel', value: 1.95 }] });

        expect(series.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ unit: 'EUR/l', currency: 'EUR' }),
            }),
        );
    });

    it('every overridable commodity HAS a denomination — no silent default', async () => {
        // Total over the list, so adding a commodity without naming its unit is
        // a compile error. Asserted at runtime too because a default would be
        // EUR/t: right for nine of ten and wrong by a factor of a thousand for
        // the tenth, which is the worst possible place for a fallback.
        expect(OVERRIDE_COMMODITIES.length).toBe(10);
        for (const c of OVERRIDE_COMMODITIES) {
            expect(OVERRIDE_ENTRY[c]).toEqual({
                unit: c === 'diesel' ? 'EUR/l' : 'EUR/t',
                currency: 'EUR',
            });
        }
    });

    it('a CLEARED series in another denomination does not block a new run', async () => {
        // The guard is about a LIVE override, not a historical one. A cleared
        // EUR/t diesel run must not refuse a fresh EUR/l one forever — that
        // would make a denomination change unrecoverable without a manual
        // delete, which is the opposite of what marking-rather-than-deleting
        // was for.
        series.findMany.mockResolvedValue([
            {
                id: 'old',
                commodity: 'diesel',
                unit: 'EUR/t',
                currency: 'EUR',
                clearedAt: new Date('2026-10-09'),
            },
        ]);
        series.create.mockResolvedValue({ id: 'new' });

        await expect(
            upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'diesel', value: 1.95 }] }),
        ).resolves.toEqual(expect.objectContaining({ written: 1 }));
        // A new series, because the key differs by unit.
        expect(series.create).toHaveBeenCalled();
    });

    it('refuses a live override recorded in a DIFFERENT denomination', async () => {
        // If `OVERRIDE_ENTRY` ever changes, the new key would mint a SECOND
        // series while the old stayed live, and two live overrides for one
        // commodity is an ambiguity no consumer can resolve.
        // One pre-loop read now returns every platform series for the day's
        // commodities, so the fixture carries `commodity` and `clearedAt` —
        // the usecase partitions in memory rather than querying per commodity.
        series.findMany.mockResolvedValue([
            { id: 'old', commodity: 'diesel', unit: 'EUR/t', currency: 'EUR', clearedAt: null },
        ]);

        await expect(
            upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'diesel', value: 1.95 }] }),
        ).rejects.toMatchObject({ code: 'OVERRIDE_DENOMINATION_CHANGED' });
    });
});

describe('§5(d) — a day is written all or nothing', () => {
    it('writes every commodity in one call', async () => {
        await upsertOverrideDay(ctx, {
            date: DAY,
            prices: [
                { commodity: 'wheat', value: 210 },
                { commodity: 'barley', value: 180 },
            ],
        });

        const r = point.upsert.mock.calls.length;
        expect(r).toBe(2);
        expect(logEvent).toHaveBeenCalledTimes(1);
    });

    it('returns `written`, which is the contract’s field name', async () => {
        const res = await upsertOverrideDay(ctx, {
            date: DAY,
            prices: [{ commodity: 'wheat', value: 210 }],
        });

        expect(res.written).toBe(1);
        expect(res.series[0]).toEqual(
            expect.objectContaining({ commodity: 'wheat', unit: 'EUR/t', currency: 'EUR' }),
        );
    });

    it('refuses the WHOLE day when any commodity is unresolvable', async () => {
        // Before anything is written. A day that half-commits is worse than one
        // that failed, because the superuser cannot tell which prices are live
        // — and these move every farm's calculator.
        await expect(
            upsertOverrideDay(ctx, {
                date: DAY,
                prices: [
                    { commodity: 'wheat', value: 210 },
                    { commodity: 'unobtainium', value: 1 },
                ],
            }),
        ).rejects.toMatchObject({ code: 'UNKNOWN_COMMODITY' });

        expect(point.upsert).not.toHaveBeenCalled();
        expect(series.create).not.toHaveBeenCalled();
    });

    it('distinguishes "not a commodity" from "not overridable"', async () => {
        // Two different things to fix: a typo, versus the owner not having
        // opened that commodity to overrides. `oats` is in the vocabulary with
        // no feed, so it is a plausible thing to try.
        await expect(
            upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'oats', value: 150 }] }),
        ).rejects.toMatchObject({
            code: 'COMMODITY_NOT_OVERRIDABLE',
            params: { commodity: 'oats' },
        });
    });

    it('refuses the same commodity twice in one day', async () => {
        // A typo, not two observations. The feeds average genuine duplicates;
        // averaging a typo produces a number nobody entered, and taking the
        // last silently discards the first.
        await expect(
            upsertOverrideDay(ctx, {
                date: DAY,
                prices: [
                    { commodity: 'wheat', value: 210 },
                    { commodity: 'Wheat', value: 215 },
                ],
            }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_COMMODITY' });
    });

    it('records the override’s OWN source in the audit trail', async () => {
        // #1618 wrote `'manual'` here while its action said otherwise, and the
        // test asserted the action and never this — so it passed while the
        // trail lied. agrent-ios read the code rather than the test.
        await upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'wheat', value: 210 }] });

        const ev = logEvent.mock.calls[0][2];
        expect(ev.action).toBe('MARKET_PRICE_OVERRIDE_UPSERT');
        expect(ev.detailsJson.after.source).toBe(PLATFORM_OVERRIDE_SOURCE);
        expect(ev.detailsJson.after.source).not.toBe('manual');
    });
});

describe('§5(b) — clearing MARKS, and a re-type starts a fresh run', () => {
    const live = (points: { date: Date; price: string }[]) => [
        {
            id: 'ovr1',
            region: 'BG',
            stage: null,
            unit: 'EUR/t',
            currency: 'EUR',
            points: points.map((p) => ({ date: p.date, price: new Prisma.Decimal(p.price) })),
        },
    ];

    it('stamps the points and the series rather than deleting either', async () => {
        series.findMany.mockResolvedValue(live([{ date: DAY, price: '210' }]));
        point.updateMany.mockResolvedValue({ count: 1 });
        series.updateMany.mockResolvedValue({ count: 1 });

        const r = await clearOverride(ctx, 'wheat');

        expect(r).toEqual({ commodity: 'wheat', cleared: true, pointsWithdrawn: 1 });
        // The typed history survives, per the contract. Nothing is deleted.
        expect(point.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ clearedAt: expect.any(Date) }) }),
        );
        // The mock has no `deleteMany` at all, which is the assertion: if the
        // usecase ever reached for one the call would throw rather than quietly
        // deleting. Stronger than checking it was not called.
        expect('deleteMany' in mockDb.marketPriceSeries).toBe(false);
    });

    it('returns cleared:false for an override that is not live — NOT an error', async () => {
        series.findMany.mockResolvedValue([]);

        const r = await clearOverride(ctx, 'wheat');

        expect(r).toEqual({ commodity: 'wheat', cleared: false, pointsWithdrawn: 0 });
        expect(logEvent).not.toHaveBeenCalled();
        expect(point.updateMany).not.toHaveBeenCalled();
    });

    it('THROWS when it stamps a different number of rows than it found', async () => {
        // An update that touched fewer rows than it found is a silent success —
        // the shape that left a DB-backed guard permanently red elsewhere here.
        series.findMany.mockResolvedValue(live([{ date: DAY, price: '210' }]));
        point.updateMany.mockResolvedValue({ count: 0 });
        series.updateMany.mockResolvedValue({ count: 1 });

        await expect(clearOverride(ctx, 'wheat')).rejects.toThrow(/expected to stamp 1 point/i);
    });

    it('a RE-TYPE un-clears the series but brings back only the typed date', async () => {
        // agrent-ios' test, and the one that distinguishes this design from a
        // run-start date. The series row is reused — the six-column key is
        // unique — so the write must un-clear the SERIES while leaving the old
        // run's points stamped, and set `clearedAt: null` on the point it
        // touches so a re-typed date rejoins the current run.
        series.findMany.mockResolvedValue([
            {
                id: 'ovr1',
                commodity: 'wheat',
                unit: 'EUR/t',
                currency: 'EUR',
                clearedAt: new Date('2026-10-09'),
            },
        ]);

        await upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'wheat', value: 215 }] });

        // The series is live again...
        expect(series.update).toHaveBeenCalledWith({
            where: { id: 'ovr1' },
            data: { clearedAt: null },
        });
        // ...and the ONE point written rejoins the run, on both paths of the
        // upsert. `update` is the path that matters: a date stamped by an
        // earlier clear must not stay hidden once it is typed again.
        const call = point.upsert.mock.calls[0][0];
        expect(call.create).toEqual(expect.objectContaining({ clearedAt: null }));
        expect(call.update).toEqual(expect.objectContaining({ clearedAt: null }));
        // Nothing un-stamps the rest of the old run.
        expect(point.updateMany).not.toHaveBeenCalled();
    });

    it('the audit row carries the withdrawn points, and says if truncated', async () => {
        series.findMany.mockResolvedValue(
            live(
                Array.from({ length: 450 }, (_, i) => ({
                    date: new Date(Date.UTC(2026, 0, 1 + i)),
                    price: '200',
                })),
            ),
        );
        point.updateMany.mockResolvedValue({ count: 450 });
        series.updateMany.mockResolvedValue({ count: 1 });

        await clearOverride(ctx, 'wheat');
        const before = logEvent.mock.calls[0][2].detailsJson.before;

        expect(before.pointsWithdrawn).toBe(450);
        expect(before.pointsRecorded).toBe(400);
        // A reader of a truncated trail must know it is truncated; a prefix
        // presented as the whole history is worse than an explicit gap.
        expect(before.pointsTruncated).toBe(50);
    });
});

describe('v1.2 §5(c) — the form read', () => {
    it('returns a row for EVERY overridable commodity, not only those with one', async () => {
        series.findMany.mockResolvedValue([]);

        const rows = await readOverrideForm(ctx);

        // The form is ten fields, not a list of existing entries. A commodity
        // with neither price is a row with both null, which is true about it.
        expect(rows).toHaveLength(10);
        expect(rows.every((r) => r.typed === null && r.api === null)).toBe(true);
    });

    it('carries entryUnit so a client holds no copy of the §3 table', async () => {
        const rows = await readOverrideForm(ctx);

        expect(rows.find((r) => r.commodity === 'wheat')?.entryUnit).toBe('EUR/t');
        // The one that breaks by a factor of a thousand if a client guesses.
        expect(rows.find((r) => r.commodity === 'diesel')?.entryUnit).toBe('EUR/l');
    });

    it('apiFeed:"none" is a different claim from api:null', async () => {
        // `none` means no feed exists EVER, so a typed price is the only source
        // and clearing it leaves nothing. `api: null` with a real feed means the
        // feed exists but has no current point. One empty column for both would
        // tell the owner their override is replacing something when it replaces
        // nothing.
        const rows = await readOverrideForm(ctx);

        expect(rows.find((r) => r.commodity === 'map')?.apiFeed).toBe('none');
        expect(rows.find((r) => r.commodity === 'wheat')?.apiFeed).toBe('ec-agrifood');
        expect(rows.find((r) => r.commodity === 'diesel')?.apiFeed).toBe('oil-bulletin');
        expect(rows.find((r) => r.commodity === 'urea')?.apiFeed).toBe('world-bank');
    });

    it('shows the typed price beside the API one', async () => {
        series.findMany.mockResolvedValue([
            {
                source: PLATFORM_OVERRIDE_SOURCE,
                commodity: 'wheat',
                unit: 'EUR/t',
                currency: 'EUR',
                clearedAt: null,
                points: [{ date: DAY, price: new Prisma.Decimal('215') }],
            },
            {
                source: 'ec-agrifood',
                commodity: 'wheat',
                unit: 'EUR/t',
                currency: 'EUR',
                clearedAt: null,
                points: [{ date: new Date('2026-10-08T00:00:00Z'), price: new Prisma.Decimal('210') }],
            },
        ]);

        const wheat = (await readOverrideForm(ctx)).find((r) => r.commodity === 'wheat')!;

        expect(wheat.typed).toEqual({
            value: 215,
            currency: 'EUR',
            unit: 'EUR/t',
            date: '2026-10-10',
        });
        expect(wheat.api).toEqual(
            expect.objectContaining({ value: 210, date: '2026-10-08', source: 'ec-agrifood' }),
        );
    });

    it('`typed` is NULL after a clear, even though the history is kept', async () => {
        // agrent-ios asked for exactly this. The cleared series is given a
        // VISIBLE point on purpose: in production the point-level `clearedAt`
        // filter would have hidden it, so a fixture with `points: []` passes
        // whether or not the SERIES filter exists — which is how the first
        // version of this test was green for the wrong reason. Handing it a
        // point is what makes it test the series flag specifically, and the two
        // columns are deliberately defence in depth rather than one check
        // written twice.
        series.findMany.mockResolvedValue([
            {
                source: PLATFORM_OVERRIDE_SOURCE,
                commodity: 'wheat',
                unit: 'EUR/t',
                currency: 'EUR',
                clearedAt: new Date('2026-10-09'),
                points: [{ date: DAY, price: new Prisma.Decimal('215') }],
            },
        ]);

        const wheat = (await readOverrideForm(ctx)).find((r) => r.commodity === 'wheat')!;
        expect(wheat.typed).toBeNull();
    });

    it('does NOT present a hand-entered `manual` price as the API’s', async () => {
        // `manual` is a typed price too. Showing it as `api` would tell the
        // owner their override is replacing a feed when it is replacing
        // somebody's typing.
        series.findMany.mockResolvedValue([
            {
                source: 'manual',
                commodity: 'map',
                unit: 'EUR/t',
                currency: 'EUR',
                clearedAt: null,
                points: [{ date: DAY, price: new Prisma.Decimal('700') }],
            },
        ]);

        const map = (await readOverrideForm(ctx)).find((r) => r.commodity === 'map')!;
        expect(map.api).toBeNull();
    });
});

describe('the gate', () => {
    it('every entry point asserts platform support', async () => {
        assertPlatformSupport.mockImplementation(() => {
            throw new Error('not the platform tenant');
        });

        await expect(
            upsertOverrideDay(ctx, { date: DAY, prices: [{ commodity: 'wheat', value: 1 }] }),
        ).rejects.toThrow('not the platform tenant');
        await expect(clearOverride(ctx, 'wheat')).rejects.toThrow('not the platform tenant');
        await expect(readOverrideForm(ctx)).rejects.toThrow('not the platform tenant');
    });
});
