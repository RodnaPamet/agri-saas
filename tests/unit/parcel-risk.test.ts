/**
 * Unit test — `analyzeParcelRisk` (per-parcel satellite risk, #13).
 *
 * The invariant this file exists to protect is the CACHE CONDITION. The usecase
 * caches per parcel per day for 6h; caching a DEGRADED reading (Earth Engine
 * threw, or the deploy has no credentials → null indices → "unknown" levels)
 * would pin "No data" on the parcel for the whole TTL, long after EE recovered.
 * So: cache only when the analysis actually had imagery, and let the degraded
 * path stay uncached so the next request retries. Mirrors the
 * `if (briefing && redis)` rule in `satellite-briefing.ts`.
 *
 * Also locks the honesty fixes that landed with it: no `summary` field on the
 * DTO (the module never produced the Claude summary it advertised) and the
 * acquisition date is threaded from Earth Engine rather than assumed to be the
 * request date.
 *
 * Prisma, Redis, and Earth Engine are all mocked — no DB, no network.
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
const mockCountForLocation = jest.fn<Promise<number>, unknown[]>();
const mockListIdsForLocation = jest.fn<Promise<Array<{ id: string; name: string }>>, unknown[]>();
jest.mock('@/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        geometryForParcel: (...a: unknown[]) => mockGeometryForParcel(...a),
        countForLocation: (...a: unknown[]) => mockCountForLocation(...a),
        listIdsForLocation: (...a: unknown[]) => mockListIdsForLocation(...a),
    },
}));

const mockLocationGetById = jest.fn();
jest.mock('@/app-layer/repositories/LocationRepository', () => ({
    LocationRepository: { getById: (...a: unknown[]) => mockLocationGetById(...a) },
}));

const mockIsGeeConfigured = jest.fn<boolean, []>();
const mockGetIndexMeansForPolygon = jest.fn();
const mockGetIndexMeansPerPass = jest.fn();
jest.mock('@/lib/agro/earth-engine', () => ({
    isGeeConfigured: () => mockIsGeeConfigured(),
    getIndexMeansForPolygon: (...a: unknown[]) => mockGetIndexMeansForPolygon(...a),
    // Mocked although nothing in THIS file calls it. A partial barrel mock
    // makes "untestable" indistinguishable from "untested": the member is
    // `undefined`, so a future test here that reached `getParcelRiskHistory`
    // would die on "is not a function" before any assertion ran, and the
    // failure would read as a bug in the usecase.
    getIndexMeansPerPass: (...a: unknown[]) => mockGetIndexMeansPerPass(...a),
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = null;
jest.mock('@/lib/redis', () => ({
    getRedis: () => redisInstance,
}));

import {
    analyzeBlockRisk,
    analyzeParcelRisk,
    MAX_BATCH_PARCELS,
    NDVI_STRESS_THRESHOLD,
} from '@/app-layer/usecases/parcel-risk';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('READER', { userId: 'u-1', tenantId: 't-1', tenantSlug: 'acme' });
const NOW = new Date('2026-07-20T09:00:00.000Z');
const PARCEL = { id: 'p-1', name: 'North field', areaHa: 12.5, cropType: 'WHEAT' };
const GEOMETRY = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

/** One parcel reading at a given NDVI, fresh cache, for threshold probes. */
async function riskAt(ndvi: number) {
    redisGet.mockResolvedValue(null);
    mockGetIndexMeansForPolygon.mockResolvedValue({
        ndvi,
        ndmi: 0.2,
        acquiredDate: '2026-07-18',
        withinField: null,
    });
    return analyzeParcelRisk(ctx, 'p-1', { now: NOW });
}

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    mockParcelFindFirst.mockResolvedValue(PARCEL);
    mockGeometryForParcel.mockResolvedValue(GEOMETRY);
    mockIsGeeConfigured.mockReturnValue(true);
});

describe('analyzeParcelRisk — the within-field distribution (#2837 stage 2)', () => {
    it('asks Earth Engine for the share against the SAME threshold the levels use', async () => {
        /*
         * The property stage 1 already paid to learn: `agrent-ios` caught that
         * draft inventing a parallel level vocabulary, and the fix was the
         * SHARED function rather than the right constant.
         *
         * `belowThresholdShare` is "what share of the parcel is in stress", so
         * the number it compares against must be the one `vegetationLevel`
         * uses for the `stress` boundary. A copy would disagree with the
         * card's own level the first time somebody retunes it — and the share
         * and the level are read side by side on one screen.
         *
         * Asserted as EQUALITY WITH THE LEVEL FUNCTION'S OWN BOUNDARY rather
         * than against the literal 0.35: a hand-written 0.35 here would pass
         * whether or not the constant is shared, which is the whole failure
         * being guarded.
         */
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.72,
            ndmi: 0.18,
            acquiredDate: '2026-07-18',
            withinField: null,
        });

        await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        const [, , opts] = mockGetIndexMeansForPolygon.mock.calls[0] as [
            unknown,
            unknown,
            { stressThreshold?: number } | undefined,
        ];
        expect(opts?.stressThreshold).toBe(NDVI_STRESS_THRESHOLD);

        // …and the constant really is the level boundary: at it, `watch`; a
        // hair below, `stress`. Without this the assertion above is satisfied
        // by any exported number.
        const atThreshold = await riskAt(NDVI_STRESS_THRESHOLD);
        const justBelow = await riskAt(NDVI_STRESS_THRESHOLD - 0.001);
        expect(atThreshold.vegetation).toBe('watch');
        expect(justBelow.vegetation).toBe('stress');
    });

    it('surfaces the distribution unchanged, and null when there was none', async () => {
        const stats = {
            ndviP10: 0.41,
            ndviP50: 0.74,
            ndviP90: 0.88,
            belowThresholdShare: 0.07,
            threshold: NDVI_STRESS_THRESHOLD,
        };
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.72,
            ndmi: 0.18,
            acquiredDate: '2026-07-18',
            withinField: stats,
        });
        const withStats = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });
        expect(withStats.withinField).toEqual(stats);

        // A reading with no imagery carries no distribution — and `null`
        // rather than an absent key, because the spec declares the field
        // always present.
        redisGet.mockResolvedValue(null);
        mockGetIndexMeansForPolygon.mockRejectedValue(new Error('EE down'));
        const degraded = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });
        expect(degraded.withinField).toBeNull();
        expect('withinField' in degraded).toBe(true);
    });

    it('does not ask for a distribution when Earth Engine is unconfigured', async () => {
        mockIsGeeConfigured.mockReturnValue(false);

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(mockGetIndexMeansForPolygon).not.toHaveBeenCalled();
        expect(result.withinField).toBeNull();
    });
});

describe('analyzeParcelRisk — cache condition (degraded readings must not stick)', () => {
    it('caches a reading that had imagery', async () => {
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.72,
            ndmi: 0.18,
            acquiredDate: '2026-07-18',
            withinField: {
                ndviP10: 0.41,
                ndviP50: 0.74,
                ndviP90: 0.88,
                belowThresholdShare: 0.07,
                threshold: 0.35,
            },
        });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.overall).toBe('good');
        expect(redisSet).toHaveBeenCalledTimes(1);
        const [key, value, ex, ttl] = redisSet.mock.calls[0];
        /*
         * `v2` since #2837 stage 2 added `withinField`. The bump is the point
         * rather than an incidental: a `v1` entry written before that deploy
         * has no such key, so a read inside the 6h TTL would return the field
         * ABSENT where the contract says `WithinFieldStats | null` — and the
         * spec declares it always present. Pinned here so a future change
         * that adds a field to this payload without bumping the version fails
         * rather than shipping an under-specified response for six hours.
         */
        expect(key).toBe('parcel-risk:v2:t-1:p-1:2026-07-20');
        expect(JSON.parse(value as string)).toMatchObject({ ndvi: 0.72, ndmi: 0.18 });
        expect(ex).toBe('EX');
        expect(ttl).toBe(21_600);
    });

    it('does NOT cache when Earth Engine throws — the next request retries', async () => {
        mockGetIndexMeansForPolygon.mockRejectedValue(new Error('EE reduceRegion failed'));

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        // Degrades honestly rather than throwing…
        expect(result.ndvi).toBeNull();
        expect(result.ndmi).toBeNull();
        expect(result.vegetation).toBe('unknown');
        expect(result.moisture).toBe('unknown');
        expect(result.overall).toBe('unknown');
        // …and leaves nothing behind that would serve "No data" for 6h.
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('does NOT cache when the pass yielded no clear pixels (both indices null)', async () => {
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: null,
            ndmi: null,
            acquiredDate: null,
        });

        await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(redisSet).not.toHaveBeenCalled();
    });

    it('does NOT cache when Earth Engine is unconfigured (no EE call at all)', async () => {
        mockIsGeeConfigured.mockReturnValue(false);

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(mockGetIndexMeansForPolygon).not.toHaveBeenCalled();
        expect(result.configured).toBe(false);
        expect(result.overall).toBe('unknown');
        expect(redisSet).not.toHaveBeenCalled();
    });

    it('caches a PARTIAL reading — one usable index is still real imagery', async () => {
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.41,
            ndmi: null,
            acquiredDate: '2026-07-15',
        });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.vegetation).toBe('watch');
        expect(result.moisture).toBe('unknown');
        expect(redisSet).toHaveBeenCalledTimes(1);
    });

    it('serves a cache hit without touching Earth Engine', async () => {
        redisGet.mockResolvedValue(
            JSON.stringify({ parcelId: 'p-1', name: 'North field', overall: 'watch' }),
        );

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.overall).toBe('watch');
        expect(mockGetIndexMeansForPolygon).not.toHaveBeenCalled();
    });
});

describe('analyzeParcelRisk — honest shape', () => {
    it('reports the acquisition date Earth Engine gave, not the request date', async () => {
        // The adaptive window can return an older pass than the one asked for.
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.66,
            ndmi: 0.12,
            acquiredDate: '2026-07-02',
        });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.acquiredDate).toBe('2026-07-02');
        // NOW is 2026-07-20 — proving the date came from EE, not the clock.
        expect(result.generatedAt).toBe('2026-07-20T09:00:00.000Z');
    });

    it('carries no `summary` field — the module never produced the advertised AI prose', async () => {
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.5,
            ndmi: 0.05,
            acquiredDate: '2026-07-18',
        });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result).not.toHaveProperty('summary');
    });

    it('runs the read policy before any data access', async () => {
        mockGetIndexMeansForPolygon.mockResolvedValue({ ndvi: 0.5, ndmi: 0.05, acquiredDate: null });

        await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(mockAssertCanRead).toHaveBeenCalledWith(ctx);
    });

    it('works with no Redis at all (returns uncached)', async () => {
        redisInstance = null;
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.8,
            ndmi: 0.2,
            acquiredDate: '2026-07-19',
        });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.overall).toBe('good');
        expect(redisSet).not.toHaveBeenCalled();
    });
});

describe('analyzeParcelRisk — risk levels', () => {
    it.each([
        ['good', 0.7, 0.2, 'good'],
        ['watch on vegetation', 0.4, 0.2, 'watch'],
        ['stress on vegetation', 0.2, 0.2, 'stress'],
        ['watch on moisture', 0.7, 0.0, 'watch'],
        ['stress on moisture', 0.7, -0.2, 'stress'],
        // overall is the WORSE of the two, not an average.
        ['worst-of-two wins', 0.7, -0.5, 'stress'],
    ])('%s → overall %s', async (_label, ndvi, ndmi, expected) => {
        mockGetIndexMeansForPolygon.mockResolvedValue({ ndvi, ndmi, acquiredDate: '2026-07-18' });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.overall).toBe(expected);
    });
});


describe('analyzeBlockRisk — a partial answer must say so (#2631)', () => {
    /** A cached per-parcel result, so no Earth Engine call is needed. */
    const cached = (id: string, overall: 'good' | 'watch' | 'stress' | 'unknown') =>
        JSON.stringify({
            parcelId: id,
            name: id,
            areaHa: 1,
            cropType: 'WHEAT',
            configured: true,
            ndvi: 0.7,
            ndmi: 0.2,
            vegetation: overall,
            moisture: 'good',
            overall,
            acquiredDate: '2026-07-18',
            generatedAt: NOW.toISOString(),
        });

    beforeEach(() => {
        jest.clearAllMocks();
        redisInstance = { get: redisGet, set: redisSet };
        mockIsGeeConfigured.mockReturnValue(true);
        mockLocationGetById.mockResolvedValue({ id: 'loc-1', name: 'Голямо поле' });
    });

    it('reports analysed BELOW total when the block exceeds the bound', async () => {
        // The property the batch exists for. `RiskLevel` already has an
        // `unknown` member, so a caller counting levels would score the 6
        // un-analysed parcels as merely unknown — and "0 stressed" across 24
        // of 30 parcels reads as a clean bill of health for a farm nobody
        // fully looked at.
        const ids = Array.from({ length: MAX_BATCH_PARCELS }, (_, i) => ({
            id: `p-${i}`,
            name: `P${i}`,
        }));
        mockListIdsForLocation.mockResolvedValue(ids);
        mockCountForLocation.mockResolvedValue(30);
        redisGet.mockImplementation(async (k) => cached(k.split(':')[3], 'good'));

        const res = await analyzeBlockRisk(ctx, 'loc-1', { now: NOW });

        expect({ analysed: res.analysed, total: res.total }).toEqual({
            analysed: MAX_BATCH_PARCELS,
            total: 30,
        });
        expect(res.analysed).toBeLessThan(res.total);
        // The bound reached the REPOSITORY, rather than being applied after a
        // full read — the whole point of `listIdsForLocation` taking `take`.
        expect(mockListIdsForLocation).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            'loc-1',
            MAX_BATCH_PARCELS,
        );
        // Every parcel was a cache hit, so no satellite call happened.
        expect(mockGetIndexMeansForPolygon).not.toHaveBeenCalled();
    });

    it('a block that does not exist REFUSES, rather than reading as a block with no parcels', async () => {
        // The two answers are "we could not find your block" and "your block
        // has nothing to worry about". Returning the second for the first is
        // a confident all-clear about a farm we never found.
        mockLocationGetById.mockResolvedValue(null);
        await expect(analyzeBlockRisk(ctx, 'nope', { now: NOW })).rejects.toThrow(
            /not found/i,
        );
        expect(mockListIdsForLocation).not.toHaveBeenCalled();
    });

    it('EXCLUDES a parcel whose analysis throws, rather than substituting `unknown`', async () => {
        mockListIdsForLocation.mockResolvedValue([
            { id: 'p-1', name: 'P1' },
            { id: 'p-2', name: 'P2' },
            { id: 'p-3', name: 'P3' },
        ]);
        mockCountForLocation.mockResolvedValue(3);
        // p-2 vanished between the id query and the analysis.
        redisGet.mockImplementation(async (k) => {
            const id = k.split(':')[3];
            return id === 'p-2' ? null : cached(id, 'good');
        });
        mockParcelFindFirst.mockResolvedValue(null); // → PARCEL_NOT_FOUND for p-2

        const res = await analyzeBlockRisk(ctx, 'loc-1', { now: NOW });

        // Dropped from `parcels`, so `analysed` falls and `total` does not —
        // a synthetic `unknown` row would claim p-2 was looked at.
        expect({ analysed: res.analysed, total: res.total }).toEqual({ analysed: 2, total: 3 });
        expect(res.parcels.map((p) => p.parcelId).sort()).toEqual(['p-1', 'p-3']);
        // counts sums to ANALYSED, never to total.
        const summed = Object.values(res.counts).reduce((a, b) => a + b, 0);
        expect(summed).toBe(res.analysed);
    });

    it('reports the WORST level across the analysed parcels', async () => {
        mockListIdsForLocation.mockResolvedValue([
            { id: 'p-1', name: 'P1' },
            { id: 'p-2', name: 'P2' },
            { id: 'p-3', name: 'P3' },
        ]);
        mockCountForLocation.mockResolvedValue(3);
        redisGet.mockImplementation(async (k) => {
            const id = k.split(':')[3];
            return cached(id, id === 'p-2' ? 'stress' : 'good');
        });

        const res = await analyzeBlockRisk(ctx, 'loc-1', { now: NOW });
        expect(res.worst).toBe('stress');
        expect(res.counts).toEqual({ unknown: 0, good: 2, watch: 0, stress: 1 });
        // And a caller can NAME the stressed parcel rather than report a count.
        expect(res.parcels.filter((p) => p.overall === 'stress').map((p) => p.parcelId)).toEqual([
            'p-2',
        ]);
    });

    it('asserts the read policy', async () => {
        mockListIdsForLocation.mockResolvedValue([]);
        mockCountForLocation.mockResolvedValue(0);
        await analyzeBlockRisk(ctx, 'loc-1', { now: NOW });
        expect(mockAssertCanRead).toHaveBeenCalledWith(ctx);
    });
});
