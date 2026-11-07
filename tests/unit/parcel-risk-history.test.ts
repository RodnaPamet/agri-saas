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
jest.mock('@/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        geometryForParcel: (...a: unknown[]) => mockGeometryForParcel(...a),
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
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = null;
jest.mock('@/lib/redis', () => ({ getRedis: () => redisInstance }));

import {
    analyzeParcelRisk,
    getParcelRiskHistory,
    HISTORY_DEFAULT_DAYS,
    HISTORY_MAX_DAYS,
    HISTORY_MIN_DAYS,
} from '@/app-layer/usecases/parcel-risk';
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

    it('asks Earth Engine for a window that ENDS today and spans `days`', async () => {
        await getParcelRiskHistory(ctx, 'p-1', 30, { now: NOW });

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

    it('404s a parcel that is not this tenant’s, scoped in the WHERE', async () => {
        mockParcelFindFirst.mockResolvedValue(null);

        await expect(getParcelRiskHistory(ctx, 'p-1', 60, { now: NOW })).rejects.toMatchObject({
            code: 'PARCEL_NOT_FOUND',
        });

        // The mock returns whatever it is asked, so the refusal above proves
        // nothing about the key. Read the `where` back.
        const [arg] = mockParcelFindFirst.mock.calls[0] as [{ where: Record<string, unknown> }];
        expect(arg.where).toMatchObject({ id: 'p-1', tenantId: 't-1', deletedAt: null });
    });

    it('serves a cache hit without calling Earth Engine', async () => {
        redisGet.mockResolvedValue(
            JSON.stringify({
                parcelId: 'p-1',
                days: 60,
                configured: true,
                passes: [{ date: '2026-10-20', ndvi: 0.5, ndmi: 0.3, vegetation: 'watch', moisture: 'watch', overall: 'watch' }],
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
