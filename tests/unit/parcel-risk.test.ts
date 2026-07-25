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
jest.mock('@/app-layer/repositories/ParcelRepository', () => ({
    ParcelRepository: {
        geometryForParcel: (...a: unknown[]) => mockGeometryForParcel(...a),
    },
}));

const mockIsGeeConfigured = jest.fn<boolean, []>();
const mockGetIndexMeansForPolygon = jest.fn();
jest.mock('@/lib/agro/earth-engine', () => ({
    isGeeConfigured: () => mockIsGeeConfigured(),
    getIndexMeansForPolygon: (...a: unknown[]) => mockGetIndexMeansForPolygon(...a),
}));

const redisGet = jest.fn<Promise<string | null>, [string]>();
const redisSet = jest.fn<Promise<unknown>, unknown[]>();
let redisInstance: { get: typeof redisGet; set: typeof redisSet } | null = null;
jest.mock('@/lib/redis', () => ({
    getRedis: () => redisInstance,
}));

import { analyzeParcelRisk } from '@/app-layer/usecases/parcel-risk';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('READER', { userId: 'u-1', tenantId: 't-1', tenantSlug: 'acme' });
const NOW = new Date('2026-07-20T09:00:00.000Z');
const PARCEL = { id: 'p-1', name: 'North field', areaHa: 12.5, cropType: 'WHEAT' };
const GEOMETRY = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

beforeEach(() => {
    jest.clearAllMocks();
    redisInstance = { get: redisGet, set: redisSet };
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    mockParcelFindFirst.mockResolvedValue(PARCEL);
    mockGeometryForParcel.mockResolvedValue(GEOMETRY);
    mockIsGeeConfigured.mockReturnValue(true);
});

describe('analyzeParcelRisk — cache condition (degraded readings must not stick)', () => {
    it('caches a reading that had imagery', async () => {
        mockGetIndexMeansForPolygon.mockResolvedValue({
            ndvi: 0.72,
            ndmi: 0.18,
            acquiredDate: '2026-07-18',
        });

        const result = await analyzeParcelRisk(ctx, 'p-1', { now: NOW });

        expect(result.overall).toBe('good');
        expect(redisSet).toHaveBeenCalledTimes(1);
        const [key, value, ex, ttl] = redisSet.mock.calls[0];
        expect(key).toBe('parcel-risk:v1:t-1:p-1:2026-07-20');
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
