/**
 * Unit test — `getParcelRiskHistory` (the per-pass satellite series, #2837).
 *
 * Three invariants, each of which a plausible implementation gets wrong in a
 * way no type catches:
 *
 * 1. **A null index must stay null.** A pass can be in the collection and
 *    fully cloud-masked over this parcel. Coercing that to 0 draws a cliff to
 *    bare soil on the chart; the levels must say `unknown`, not `stress`.
 * 2. **The levels come from the CARD's functions.** `vegetationLevel` /
 *    `moistureLevel` are not exported, so this asserts the property instead:
 *    a pass's levels equal what `analyzeParcelRisk` reports for the same pair
 *    of numbers. Two call sites with copied thresholds pass every
 *    hand-written expectation and drift the first time somebody retunes 0.6.
 * 3. **`days` is IN the cache key, and a degraded series is NOT cached.** A
 *    30-day and a 60-day request are different answers; and caching an Earth
 *    Engine failure would pin an empty chart for the full 6h TTL after EE
 *    recovered — `analyzeParcelRisk`'s rule, same reason.
 *
 * Prisma, Redis and Earth Engine are all mocked — no DB, no network.
 */
const mockAssertCanRead = jest.fn();
jest.mock('@/app-layer/policies/common', () => ({
    assertCanRead: (...a: unknown[]) => mockAssertCanRead(...a),
}));

const mockParcelFindFirst = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ parcel: { findFirst: (...a: unknown[]) => mockParcelFindFirst(...a) } }),
}));

const mockGeometryForParcel = jest.fn();
const mockStoredIndexReadings = jest.fn();
const mockStoreIndexReadings = jest.fn();
jest.mock('@/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        geometryForParcel: (...a: unknown[]) => mockGeometryForParcel(...a),
        storedIndexReadings: (...a: unknown[]) => mockStoredIndexReadings(...a),
        storeIndexReadings: (...a: unknown[]) => mockStoreIndexReadings(...a),
        countForLocation: jest.fn(),
        listIdsForLocation: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/LocationRepository', () => ({
    LocationRepository: { getById: jest.fn() },
}));

const mockIsGeeConfigured = jest.fn<boolean, []>();
const mockGetIndexMeansPerPass = jest.fn();
const mockGetIndexMeansForPolygon = jest.fn();
jest.mock('@/lib/agro/earth-engine', () => ({
    isGeeConfigured: () => mockIsGeeConfigured(),
    getIndexMeansPerPass: (...a: unknown[]) => mockGetIndexMeansPerPass(...a),
    getIndexMeansForPolygon: (...a: unknown[]) => mockGetIndexMeansForPolygon(...a),
    // The CONSTANT has to be in the mock, and it is the kind of omission that
    // reads as a pass. Measured: without it the import resolves to
    // `undefined` in BOTH the usecase and this file, so every
    // `coveredAlgo === SCENE_SELECTION_VERSION` comparison is
    // `undefined === undefined` — always true, the mismatch branch never
    // executes, and the fixtures below mean nothing. A partial barrel mock
    // makes untestable indistinguishable from untested.
    SCENE_SELECTION_VERSION: 1,
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = null;
jest.mock('@/lib/redis', () => ({ getRedis: () => redisInstance }));

import {
    analyzeParcelRisk,
    getParcelRiskHistory,
    uncoveredRanges,
    HISTORY_DEFAULT_DAYS,
    HISTORY_MAX_DAYS,
    HISTORY_MIN_DAYS,
} from '@/app-layer/usecases/parcel-risk';
import { SCENE_SELECTION_VERSION } from '@/lib/agro/earth-engine';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('READER', { userId: 'u-1', tenantId: 't-1', tenantSlug: 'acme' });
const NOW = new Date('2026-11-07T09:00:00.000Z');
const PARCEL = { id: 'p-1' };
const GEOMETRY = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    mockParcelFindFirst.mockResolvedValue(PARCEL);
    mockGeometryForParcel.mockResolvedValue(GEOMETRY);
    mockIsGeeConfigured.mockReturnValue(true);
    mockGetIndexMeansPerPass.mockResolvedValue([]);
    // The default fixture is a COLD parcel: it exists, nothing is stored, and
    // nothing has ever been asked about. That is the state in which every
    // request must reach Earth Engine, so a test that means to exercise the
    // stored path has to say so.
    mockStoredIndexReadings.mockResolvedValue({
        coveredFrom: null,
        coveredThrough: null,
            coveredAlgo: SCENE_SELECTION_VERSION,
        readings: [],
    });
    mockStoreIndexReadings.mockResolvedValue(undefined);
});

describe('getParcelRiskHistory — a masked pass is a GAP, never a zero', () => {
    it('keeps a null index null and reports the level as unknown', async () => {
        mockGetIndexMeansPerPass.mockResolvedValue([
            { date: '2026-10-20', ndvi: 0.71, ndmi: 0.33 },
            { date: '2026-10-25', ndvi: null, ndmi: null },
        ]);

        const { passes } = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(passes).toHaveLength(2);
        // The readable pass.
        expect(passes[0]).toMatchObject({ ndvi: 0.71, vegetation: 'good' });
        // The masked one: null survives, and the level is ABSENCE — not the
        // 'stress' that a `?? 0` would produce.
        expect(passes[1].ndvi).toBeNull();
        expect(passes[1].ndmi).toBeNull();
        expect(passes[1].vegetation).toBe('unknown');
        expect(passes[1].moisture).toBe('unknown');
        expect(passes[1].overall).toBe('unknown');
    });

    it('scores every pass exactly as the parcel CARD scores the same numbers', async () => {
        // Two readings either side of each threshold, so a copied-and-drifted
        // constant shows up rather than a single mid-band value that any
        // plausible scale agrees on.
        const readings = [
            { date: '2026-10-01', ndvi: 0.6, ndmi: 0.35 },
            { date: '2026-10-06', ndvi: 0.59, ndmi: 0.34 },
            { date: '2026-10-11', ndvi: 0.35, ndmi: 0.2 },
            { date: '2026-10-16', ndvi: 0.34, ndmi: 0.19 },
        ];
        mockGetIndexMeansPerPass.mockResolvedValue(readings);

        const { passes } = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        // The card is the reference implementation. Ask it about the SAME
        // numbers and require agreement, field by field.
        for (const [i, reading] of readings.entries()) {
            mockParcelFindFirst.mockResolvedValue({
                id: 'p-1',
                name: 'North field',
                areaHa: 10,
                cropType: 'WHEAT',
            });
            mockGetIndexMeansForPolygon.mockResolvedValue({
                ndvi: reading.ndvi,
                ndmi: reading.ndmi,
                acquiredDate: reading.date,
            });
            redisGet.mockResolvedValue(null);
            const card = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

            expect({
                vegetation: passes[i].vegetation,
                moisture: passes[i].moisture,
                overall: passes[i].overall,
            }).toEqual({
                vegetation: card.vegetation,
                moisture: card.moisture,
                overall: card.overall,
            });
        }
        // A control: the four readings must not all have scored the same, or
        // the comparison above is satisfied by any constant.
        expect(new Set(passes.map((p) => p.overall)).size).toBeGreaterThan(1);
    });
});

describe('getParcelRiskHistory — the window', () => {
    it('puts `days` in the cache key, so two windows are two answers', async () => {
        mockGetIndexMeansPerPass.mockResolvedValue([
            { date: '2026-10-20', ndvi: 0.5, ndmi: 0.3 },
        ]);

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });
        await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        const keys = redisSet.mock.calls.map((c) => c[0]);
        expect(keys).toEqual([
            'parcel-risk-history:v1:t-1:p-1:30:2026-11-07',
            'parcel-risk-history:v1:t-1:p-1:60:2026-11-07',
        ]);
        // And the READ side agrees — a 60-day request must not be served a
        // 30-day entry.
        expect(redisGet.mock.calls.map((c) => c[0])).toEqual(keys);
    });

    it('clamps rather than refusing, and echoes the window it used', async () => {
        const huge = await getParcelRiskHistory(ctx, 'p-1', 400, { now: NOW });
        expect(huge.days).toBe(HISTORY_MAX_DAYS);

        const tiny = await getParcelRiskHistory(ctx, 'p-1', 1, { now: NOW });
        expect(tiny.days).toBe(HISTORY_MIN_DAYS);

        // NaN survives a route that let a bad query string through. It must
        // resolve to the default BEFORE clamping — `Math.max(7, NaN)` is NaN,
        // which would reach the cache key as the literal "NaN".
        const nan = await getParcelRiskHistory(ctx, 'p-1', Number.NaN, { now: NOW });
        expect(nan.days).toBe(HISTORY_DEFAULT_DAYS);
    });

    it('asks Earth Engine for a window that ENDS today and spans `days` on a cold parcel', async () => {
        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        expect(mockGetIndexMeansPerPass).toHaveBeenCalledTimes(1);
        const [, win] = mockGetIndexMeansPerPass.mock.calls[0] as [unknown, { start: string; end: string }];
        expect(win.end).toBe('2026-11-07');
        expect(win.start).toBe('2026-10-08');
    });
});

describe('getParcelRiskHistory — a degraded series must not stick', () => {
    it('does NOT cache when Earth Engine throws, and degrades instead of raising', async () => {
        mockGetIndexMeansPerPass.mockRejectedValue(new Error('EE reduceColumns failed'));

        const result = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(result.passes).toEqual([]);
        // `configured` stays true: EE is set up, it failed. A client needs
        // that to tell a failure from an unconfigured deployment.
        expect(result.configured).toBe(true);
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('does NOT cache an empty series', async () => {
        mockGetIndexMeansPerPass.mockResolvedValue([]);

        await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(redisSet).not.toHaveBeenCalled();
    });

    it('makes no Earth Engine call at all when EE is unconfigured', async () => {
        mockIsGeeConfigured.mockReturnValue(false);

        const result = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(mockGetIndexMeansPerPass).not.toHaveBeenCalled();
        expect(result.configured).toBe(false);
        expect(result.passes).toEqual([]);
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('makes no Earth Engine call when the parcel has no geometry', async () => {
        mockGeometryForParcel.mockResolvedValue(null);

        const result = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(mockGetIndexMeansPerPass).not.toHaveBeenCalled();
        expect(result.passes).toEqual([]);
    });
});

describe('getParcelRiskHistory — the boring guarantees', () => {
    it('checks read permission before touching anything', async () => {
        await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });
        expect(mockAssertCanRead).toHaveBeenCalledWith(ctx);
    });

    it('404s a parcel the repository cannot find for this tenant', async () => {
        // `storedIndexReadings` returns null for a parcel that does not exist
        // for this tenant — the tenant scoping lives in its own `where`, which
        // the integration test reads back against a real database.
        mockStoredIndexReadings.mockResolvedValue(null);

        await expect(getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW })).rejects.toMatchObject({
            code: 'PARCEL_NOT_FOUND',
        });

        // The mock answers whatever it is asked, so the refusal above proves
        // nothing about which parcel was looked up. Read the arguments back.
        const [, , askedParcelId] = mockStoredIndexReadings.mock.calls[0] as [unknown, unknown, string, Date];
        expect(askedParcelId).toBe('p-1');
    });

    it('serves a cache hit without calling Earth Engine', async () => {
        redisGet.mockResolvedValue(
            JSON.stringify({
                parcelId: 'p-1',
                days: 60,
                configured: true,
                passes: [{ date: '2026-10-20', ndvi: 0.5, ndmi: 0.3, vegetation: 'watch', moisture: 'watch', overall: 'watch', source: 'stored' }],
                truncated: false,
                generatedAt: NOW.toISOString(),
            }),
        );

        const result = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(result.passes).toHaveLength(1);
        expect(mockGetIndexMeansPerPass).not.toHaveBeenCalled();
    });

    it('still answers when Redis is absent', async () => {
        redisInstance = null;
        mockGetIndexMeansPerPass.mockResolvedValue([
            { date: '2026-10-20', ndvi: 0.5, ndmi: 0.3 },
        ]);

        const result = await getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW });

        expect(result.passes).toHaveLength(1);
    });
});

describe('uncoveredRanges — what still needs an Earth Engine call', () => {
    // A pure function, so these are exhaustive rather than illustrative. NOW
    // is 2026-11-07, so the 7-day refresh tail begins 2026-10-31.
    const plan = (start: string, end: string, from: string | null, through: string | null) =>
        uncoveredRanges(start, end, from ? new Date(`${from}T00:00:00Z`) : null,
            through ? new Date(`${through}T00:00:00Z`) : null, NOW);

    it('asks for the whole window when nothing has ever been asked', () => {
        expect(plan('2026-10-08', '2026-11-07', null, null)).toEqual([
            { start: '2026-10-08', end: '2026-11-07' },
        ]);
    });

    it('treats a half-set watermark as never asked', () => {
        // Both ends are written together, so one end alone means something
        // went wrong. Re-searching the window is the recoverable direction;
        // trusting half a watermark would skip dates for ever.
        expect(plan('2026-10-08', '2026-11-07', '2026-10-08', null)).toEqual([
            { start: '2026-10-08', end: '2026-11-07' },
        ]);
        expect(plan('2026-10-08', '2026-11-07', null, '2026-11-07')).toEqual([
            { start: '2026-10-08', end: '2026-11-07' },
        ]);
    });

    it('asks only for the recent tail when the window is fully covered', () => {
        // THE point of storing readings. A 30-day window already searched
        // costs one 7-day call, not a 30-day one — and it is not zero calls,
        // because Sentinel-2 L2A for the last few days is still processing and
        // a covered date can still gain a pass.
        expect(plan('2026-10-08', '2026-11-07', '2026-09-01', '2026-11-07')).toEqual([
            { start: '2026-10-31', end: '2026-11-07' },
        ]);
    });

    it('asks for the tail only, however far back the window reaches, once covered', () => {
        // A 120-day question on a warm parcel is the same one call as a
        // 14-day one. That is what makes a period question cheap.
        expect(plan('2026-07-10', '2026-11-07', '2026-01-01', '2026-11-07')).toEqual([
            { start: '2026-10-31', end: '2026-11-07' },
        ]);
    });

    it('backfills the front when the window reaches back past the watermark', () => {
        const ranges = plan('2026-08-01', '2026-11-07', '2026-10-01', '2026-11-07');
        expect(ranges).toEqual([
            // up to the day BEFORE the watermark starts — not including it,
            // or every request re-searches the boundary day for ever.
            { start: '2026-08-01', end: '2026-09-30' },
            { start: '2026-10-31', end: '2026-11-07' },
        ]);
    });

    it('keeps a covered sliver in the MIDDLE of the window out of both ranges', () => {
        // Covered 10-28..10-30, window 10-25..11-07, tail from 10-31. Two
        // calls, and the three searched days in between are correctly skipped
        // — the saving storage is for. My first expectation here said these
        // two ranges merge; they do not, and should not, because merging them
        // would re-search the sliver on every request.
        expect(plan('2026-10-25', '2026-11-07', '2026-10-28', '2026-10-30')).toEqual([
            { start: '2026-10-25', end: '2026-10-27' },
            { start: '2026-10-31', end: '2026-11-07' },
        ]);
    });

    it('merges the two ranges into one call when they touch', () => {
        // The ranges touch only when the whole watermark lies INSIDE the
        // refresh tail — covered 11-01..11-05 against a tail from 10-31. Then
        // the front gap runs to 10-31 and the tail starts at 10-31, so one
        // call covers both and the sliver is going to be re-searched anyway.
        expect(plan('2026-10-25', '2026-11-07', '2026-11-01', '2026-11-05')).toEqual([
            { start: '2026-10-25', end: '2026-11-07' },
        ]);
    });

    it('covers a GAP between a stale watermark and the tail in one call', () => {
        // The watermark ends well before the refresh tail begins — a parcel
        // nobody has opened for a month. Asking from just after the watermark
        // rather than from the tail start is what stops those three weeks
        // being skipped permanently.
        expect(plan('2026-10-08', '2026-11-07', '2026-09-01', '2026-10-10')).toEqual([
            { start: '2026-10-11', end: '2026-11-07' },
        ]);
    });

    it('never asks for a date outside the requested window', () => {
        // The watermark starts before the window AND the tail start precedes
        // it: the result must still begin at the window start.
        const ranges = plan('2026-11-05', '2026-11-07', '2026-01-01', '2026-11-07');
        expect(ranges).toEqual([{ start: '2026-11-05', end: '2026-11-07' }]);
        for (const r of ranges) {
            expect(r.start >= '2026-11-05').toBe(true);
            expect(r.end <= '2026-11-07').toBe(true);
        }
    });
});

describe('getParcelRiskHistory — stored readings', () => {
    it('the mocked scene-selection version is a real number (mock completeness)', () => {
        // Without this the comparison in the usecase is `undefined ===
        // undefined`, which is true, and every assertion about the watermark
        // below passes whatever the code does.
        expect(typeof SCENE_SELECTION_VERSION).toBe('number');
    });

    it('treats a watermark written under a DIFFERENT algorithm as absent', async () => {
        // A looser cloud threshold admits passes the old rules rejected, so a
        // watermark from the old rules is not evidence about the new ones.
        // Believing it would silently freeze every chart at the old answer.
        mockStoredIndexReadings.mockResolvedValue({
            coveredFrom: new Date('2026-09-01T00:00:00Z'),
            coveredThrough: new Date('2026-11-07T00:00:00Z'),
            coveredAlgo: SCENE_SELECTION_VERSION + 1,
            readings: [{ acquiredOn: new Date('2026-10-20T00:00:00Z'), ndvi: 0.71, ndmi: 0.33 }],
        });
        mockGetIndexMeansPerPass.mockResolvedValue([]);

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        // The WHOLE window is re-searched, not just the 7-day tail.
        const [, win] = mockGetIndexMeansPerPass.mock.calls[0] as [unknown, { start: string; end: string }];
        expect(win).toEqual({ start: '2026-10-08', end: '2026-11-07' });
    });

    it('stamps the current algorithm version on the coverage it writes', async () => {
        mockGetIndexMeansPerPass.mockResolvedValue([{ date: '2026-10-20', ndvi: 0.6, ndmi: 0.3 }]);

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        const [, , , , coverage] = mockStoreIndexReadings.mock.calls[0] as [
            unknown, unknown, string, unknown, { algo: number } | null,
        ];
        expect(coverage?.algo).toBe(SCENE_SELECTION_VERSION);
    });

    it('serves a covered window from the record, calling EE only for the tail', async () => {
        mockStoredIndexReadings.mockResolvedValue({
            coveredFrom: new Date('2026-09-01T00:00:00Z'),
            coveredThrough: new Date('2026-11-07T00:00:00Z'),
            coveredAlgo: SCENE_SELECTION_VERSION,
            readings: [
                { acquiredOn: new Date('2026-10-20T00:00:00Z'), ndvi: 0.71, ndmi: 0.33 },
                { acquiredOn: new Date('2026-10-25T00:00:00Z'), ndvi: 0.44, ndmi: 0.21 },
            ],
        });
        mockGetIndexMeansPerPass.mockResolvedValue([]);

        const { passes } = await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        expect(passes.map((p) => [p.date, p.source])).toEqual([
            ['2026-10-20', 'stored'],
            ['2026-10-25', 'stored'],
        ]);
        // One call, and it is the 7-day tail — not the 30 days asked for.
        expect(mockGetIndexMeansPerPass).toHaveBeenCalledTimes(1);
        const [, win] = mockGetIndexMeansPerPass.mock.calls[0] as [unknown, { start: string; end: string }];
        expect(win).toEqual({ start: '2026-10-31', end: '2026-11-07' });
    });

    it('still answers from the record when Earth Engine fails', async () => {
        // The failure the storage was asked for. Before this, a 14-day
        // question during an EE outage returned nothing at all.
        mockStoredIndexReadings.mockResolvedValue({
            coveredFrom: new Date('2026-09-01T00:00:00Z'),
            coveredThrough: new Date('2026-11-07T00:00:00Z'),
            coveredAlgo: SCENE_SELECTION_VERSION,
            readings: [{ acquiredOn: new Date('2026-10-20T00:00:00Z'), ndvi: 0.71, ndmi: 0.33 }],
        });
        mockGetIndexMeansPerPass.mockRejectedValue(new Error('EE unavailable'));

        const result = await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        expect(result.passes.map((p) => p.date)).toEqual(['2026-10-20']);
        expect(result.configured).toBe(true);
        // Not cached: the series is short through no fault of the data, and
        // pinning it for 6h would hide the recovery.
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('does NOT advance the watermark over a range it failed to search', async () => {
        // The one unrecoverable mistake here: recording a gap as searched
        // means nothing ever goes back for it.
        mockStoredIndexReadings.mockResolvedValue({
            coveredFrom: new Date('2026-10-01T00:00:00Z'),
            coveredThrough: new Date('2026-10-10T00:00:00Z'),
            coveredAlgo: SCENE_SELECTION_VERSION,
            readings: [],
        });
        mockGetIndexMeansPerPass
            .mockResolvedValueOnce([{ date: '2026-08-15', ndvi: 0.6, ndmi: 0.3 }])
            .mockRejectedValueOnce(new Error('EE unavailable'));

        await getParcelRiskHistory(ctx, 'p-1', 120, { now: NOW });

        // The pass that DID come back is still stored — the data is good.
        expect(mockStoreIndexReadings).toHaveBeenCalledTimes(1);
        const [, , , readings, coverage] = mockStoreIndexReadings.mock.calls[0] as [
            unknown, unknown, string,
            Array<{ acquiredOn: Date }>,
            { from: Date; through: Date } | null,
        ];
        expect(readings.map((r) => r.acquiredOn.toISOString().slice(0, 10))).toEqual(['2026-08-15']);
        // …and the coverage is explicitly withheld.
        expect(coverage).toBeNull();
    });

    it('advances the watermark across the whole window when every range succeeded', async () => {
        mockGetIndexMeansPerPass.mockResolvedValue([{ date: '2026-10-20', ndvi: 0.6, ndmi: 0.3 }]);

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        const [, , , , coverage] = mockStoreIndexReadings.mock.calls[0] as [
            unknown, unknown, string, unknown, { from: Date; through: Date } | null,
        ];
        expect(coverage?.from.toISOString().slice(0, 10)).toBe('2026-10-08');
        expect(coverage?.through.toISOString().slice(0, 10)).toBe('2026-11-07');
    });

    it('prefers a freshly computed pass over the stored one for the same date', async () => {
        // Both halves come from the same algorithm on the same imagery, so a
        // disagreement means the archive was reprocessed.
        mockStoredIndexReadings.mockResolvedValue({
            coveredFrom: new Date('2026-09-01T00:00:00Z'),
            coveredThrough: new Date('2026-11-07T00:00:00Z'),
            coveredAlgo: SCENE_SELECTION_VERSION,
            readings: [{ acquiredOn: new Date('2026-11-03T00:00:00Z'), ndvi: 0.2, ndmi: 0.1 }],
        });
        mockGetIndexMeansPerPass.mockResolvedValue([{ date: '2026-11-03', ndvi: 0.8, ndmi: 0.4 }]);

        const { passes } = await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        // One point for the date, not two, and it is the fresh one.
        expect(passes).toHaveLength(1);
        expect(passes[0]).toMatchObject({ ndvi: 0.8, source: 'earthengine', vegetation: 'good' });
    });

    it('writes nothing when Earth Engine returned nothing', async () => {
        mockGetIndexMeansPerPass.mockResolvedValue([]);

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        expect(mockStoreIndexReadings).not.toHaveBeenCalled();
    });

    it('still returns the series when the WRITE fails', async () => {
        // A failed write must not fail a read: the caller asked for a chart,
        // and the only cost of not storing is asking Earth Engine again.
        mockGetIndexMeansPerPass.mockResolvedValue([{ date: '2026-10-20', ndvi: 0.6, ndmi: 0.3 }]);
        mockStoreIndexReadings.mockRejectedValue(new Error('deadlock detected'));

        const { passes } = await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        expect(passes.map((p) => p.date)).toEqual(['2026-10-20']);
    });

    it('stores a fully-masked pass as a reading, NULLs and all', async () => {
        // A row with a null index records that a pass EXISTED and the parcel
        // was under cloud. Skipping it would make the backfill re-ask Earth
        // Engine about every cloudy day for ever.
        mockGetIndexMeansPerPass.mockResolvedValue([{ date: '2026-10-20', ndvi: null, ndmi: null }]);

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        const [, , , readings] = mockStoreIndexReadings.mock.calls[0] as [
            unknown, unknown, string, Array<{ acquiredOn: Date; ndvi: number | null }>,
        ];
        expect(readings).toHaveLength(1);
        expect(readings[0].ndvi).toBeNull();
    });

    it('keeps the Earth Engine calls OUTSIDE the read transaction', async () => {
        // `EE_CALL_TIMEOUT_MS` is 25s and `PG_POOL_MAX` is 12, so holding a
        // connection across those calls would let twelve concurrent chart
        // opens exhaust the pool. Two separate tenant contexts, in order:
        // read, then Earth Engine, then write.
        const order: string[] = [];
        mockStoredIndexReadings.mockImplementation(async () => {
            order.push('read');
            return { coveredFrom: null, coveredThrough: null,
            coveredAlgo: SCENE_SELECTION_VERSION, readings: [] };
        });
        mockGetIndexMeansPerPass.mockImplementation(async () => {
            order.push('earthengine');
            return [{ date: '2026-10-20', ndvi: 0.6, ndmi: 0.3 }];
        });
        mockStoreIndexReadings.mockImplementation(async () => {
            order.push('write');
        });

        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

        expect(order).toEqual(['read', 'earthengine', 'write']);
    });
});
