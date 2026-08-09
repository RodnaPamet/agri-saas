/**
 * Season recap — aggregation math + scoping + tenant-scoping assertions.
 * The tenant-context DB is mocked so we assert the mapping, not Prisma.
 */
import type { RequestContext } from '@/app-layer/types';

const db = {
    season: { findFirst: jest.fn(), findMany: jest.fn() },
    // Yield is read as DB aggregates now — the old findMany({ take: 5000 })
    // with no orderBy silently dropped rows past the cap and returned a
    // different subset per call.
    yieldRecord: { aggregate: jest.fn(), groupBy: jest.fn() },
    parcel: { findMany: jest.fn() },
    logEntry: { count: jest.fn(), aggregate: jest.fn() },
    location: { findMany: jest.fn() },
};

// Capture the where-clauses passed to each query so we can assert
// tenant-scoping + season-scoping structurally.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (d: unknown) => unknown) => cb(db),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme Farm' }) } },
}));

// year-on-farm.ts statically imports the certification derivation; mock
// it disabled (empty module list) so the smoke test never hits the
// scheme/readiness queries.
jest.mock('@/app-layer/usecases/modules', () => ({
    getEnabledModules: jest.fn().mockResolvedValue([]),
}));

import { getSeasonRecap } from '@/app-layer/usecases/season-recap';

const ctx = { tenantId: 't1', userId: 'u', requestId: 'r', permissions: { canRead: true } } as unknown as RequestContext;

/** Reset all mocks to an "empty tenant" baseline. */
function resetEmpty() {
    db.season.findFirst.mockReset().mockResolvedValue(null);
    db.season.findMany.mockReset().mockResolvedValue([]);
    db.yieldRecord.aggregate.mockReset().mockImplementation(async (args: any) =>
        args?.where?.netTonnesStd === null
            ? { _sum: { grossTonnes: null } }
            : {
                  _sum: { grossTonnes: null, netTonnesStd: null, areaHa: null },
                  _count: { _all: 0, netTonnesStd: 0 },
              },
    );
    db.yieldRecord.groupBy.mockReset().mockResolvedValue([]);
    db.parcel.findMany.mockReset().mockResolvedValue([]);
    db.logEntry.count.mockReset().mockResolvedValue(0);
    db.logEntry.aggregate.mockReset().mockResolvedValue({ _sum: { costAmount: null }, _count: { costAmount: 0 } });
    db.location.findMany.mockReset().mockResolvedValue([]);
}

/**
 * Wire the two yield aggregates + the per-location groupBy.
 *
 * `harvestedAreaHa` is the area farmers typed on the yield records — the
 * t/ha denominator. It is deliberately NOT the parcel area, which is what
 * the recap used to divide by (and why the same harvest read 7.0 t/ha on
 * the yield page and 4.2 t/ha in the PDF).
 */
function mockYield(opts: {
    grossTonnes?: string | null;
    netTonnesStd?: string | null;
    harvestedAreaHa?: string | null;
    records?: number;
    recordsWithMoisture?: number;
    unadjustedGross?: string | null;
    byLocation?: Array<{
        locationId: string | null;
        gross: string | null;
        net?: string | null;
        area?: string | null;
    }>;
}) {
    db.yieldRecord.aggregate.mockImplementation(async (args: any) =>
        args?.where?.netTonnesStd === null
            ? { _sum: { grossTonnes: opts.unadjustedGross ?? null } }
            : {
                  _sum: {
                      grossTonnes: opts.grossTonnes ?? null,
                      netTonnesStd: opts.netTonnesStd ?? null,
                      areaHa: opts.harvestedAreaHa ?? null,
                  },
                  _count: {
                      _all: opts.records ?? 0,
                      netTonnesStd: opts.recordsWithMoisture ?? 0,
                  },
              },
    );
    db.yieldRecord.groupBy.mockResolvedValue(
        (opts.byLocation ?? []).map((r) => ({
            locationId: r.locationId,
            _sum: { grossTonnes: r.gross, netTonnesStd: r.net ?? null, areaHa: r.area ?? null },
        })),
    );
}

const SEASON = { id: 's1', name: '2026 Main', year: 2026, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') };

describe('getSeasonRecap', () => {
    beforeEach(resetEmpty);

    it('empty tenant → zeros, nulls, empty topFields', async () => {
        const r = await getSeasonRecap(ctx);
        expect(r).toEqual({
            seasonId: null,
            seasonName: null,
            year: null,
            totalAreaHa: 0,
            harvestedAreaHa: 0,
            totalYieldTonnes: 0,
            totalNetTonnesStd: 0,
            unadjustedTonnes: 0,
            recordsWithMoisture: 0,
            yieldRecordCount: 0,
            avgYieldTPerHa: null,
            costPerHa: null,
            topFields: [],
            activityCount: 0,
        });
    });

    it('t/ha divides by HARVESTED area, not the parcel area', async () => {
        // THE regression this change exists for. The farm has 30 ha of
        // parcels under the field, but only 21.4286 ha were cut. Dividing by
        // the parcel area gave 5.0 t/ha in the recap and the PDF while the
        // yield page showed 7.0 for the same harvest.
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({
            grossTonnes: '150',
            netTonnesStd: '150',
            harvestedAreaHa: '21.4286',
            records: 2,
            recordsWithMoisture: 2,
            byLocation: [{ locationId: 'locA', gross: '150', net: '150', area: '21.4286' }],
        });
        db.parcel.findMany.mockResolvedValue([{ locationId: 'locA', areaHa: '30' }]);
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North Field' }]);

        const r = await getSeasonRecap(ctx);
        expect(r.totalYieldTonnes).toBe(150);
        // The cropped-area metric survives under its own name — it is a real
        // figure, it just is not a yield denominator.
        expect(r.totalAreaHa).toBe(30);
        expect(r.harvestedAreaHa).toBe(21.4286);
        expect(r.avgYieldTPerHa).toBe(7); // 150 / 21.4286, not 150 / 30
        expect(r.seasonId).toBe('s1');
        expect(r.seasonName).toBe('2026 Main');
        expect(r.year).toBe(2026);
    });

    it('reports the standard-moisture total beside the gross one', async () => {
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({
            grossTonnes: '278.4',
            netTonnesStd: '278.567',
            harvestedAreaHa: '40',
            records: 2,
            recordsWithMoisture: 2,
            byLocation: [{ locationId: 'locA', gross: '278.4', net: '278.567', area: '40' }],
        });
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);

        const r = await getSeasonRecap(ctx);
        expect(r.totalYieldTonnes).toBe(278.4);
        expect(r.totalNetTonnesStd).toBe(278.567);
        expect(r.unadjustedTonnes).toBe(0);
        expect(r.recordsWithMoisture).toBe(2);
        expect(r.yieldRecordCount).toBe(2);
    });

    it('reports tonnes with no moisture reading separately, and still counts them', async () => {
        // Folding unmeasured tonnes into "at 14%" would make the adjusted
        // total quietly mixed again; dropping them would understate the
        // harvest. Neither — they are counted and disclosed.
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({
            grossTonnes: '150',
            netTonnesStd: '100',
            harvestedAreaHa: '25',
            records: 3,
            recordsWithMoisture: 2,
            unadjustedGross: '50',
            byLocation: [{ locationId: 'locA', gross: '150', net: '100', area: '25' }],
        });
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);

        const r = await getSeasonRecap(ctx);
        expect(r.totalNetTonnesStd).toBe(100);
        expect(r.unadjustedTonnes).toBe(50);
        expect(r.recordsWithMoisture).toBe(2);
        expect(r.yieldRecordCount).toBe(3);
        // Average uses adjusted + unadjusted so no harvest is dropped.
        expect(r.avgYieldTPerHa).toBe(6); // (100 + 50) / 25
    });

    it('a record with no field still contributes BOTH its tonnes and its area', async () => {
        // The old code added tonnes to the numerator from locationId-null
        // records but no area to the denominator, inflating the average.
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({
            grossTonnes: '200',
            netTonnesStd: '200',
            harvestedAreaHa: '40',
            records: 2,
            recordsWithMoisture: 2,
            byLocation: [
                { locationId: 'locA', gross: '100', net: '100', area: '20' },
                { locationId: null, gross: '100', net: '100', area: '20' },
            ],
        });
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);

        const r = await getSeasonRecap(ctx);
        expect(r.avgYieldTPerHa).toBe(5); // 200 / 40 — not 200 / 20
        // The unassigned record has no field row of its own.
        expect(r.topFields.map((f) => f.locationId)).toEqual(['locA']);
    });

    it('avgYieldTPerHa is null when nothing was harvested', async () => {
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({ grossTonnes: '100', netTonnesStd: '100', harvestedAreaHa: null, records: 1, recordsWithMoisture: 1 });
        db.parcel.findMany.mockResolvedValue([]);

        const r = await getSeasonRecap(ctx);
        expect(r.harvestedAreaHa).toBe(0);
        // Zero area is undefined t/ha, not 0 t/ha — the guard is in the
        // shared helper both this and the yield page call.
        expect(r.avgYieldTPerHa).toBeNull();
    });

    it('never truncates: yield is read as an aggregate, not a bounded scan', async () => {
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({ grossTonnes: '9999999', netTonnesStd: '9999999', harvestedAreaHa: '1000', records: 50_000, recordsWithMoisture: 50_000 });

        const r = await getSeasonRecap(ctx);
        // 50k records, all counted — the old take:5000 would have dropped
        // 45k of them and varied which ones between calls.
        expect(r.yieldRecordCount).toBe(50_000);
        expect(r.totalYieldTonnes).toBe(9999999);
        expect(db.yieldRecord.aggregate).toHaveBeenCalled();
        expect((db.yieldRecord as unknown as { findMany?: unknown }).findMany).toBeUndefined();
    });

    it('costPerHa is null when there are NO costAmount rows', async () => {
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({ grossTonnes: '100', netTonnesStd: '100', harvestedAreaHa: '10', records: 1, recordsWithMoisture: 1,
            byLocation: [{ locationId: 'locA', gross: '100', net: '100', area: '10' }] });
        db.parcel.findMany.mockResolvedValue([{ locationId: 'locA', areaHa: '10' }]);
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);
        db.logEntry.aggregate.mockResolvedValue({ _sum: { costAmount: null }, _count: { costAmount: 0 } });

        const r = await getSeasonRecap(ctx);
        expect(r.costPerHa).toBeNull();
    });

    it('costPerHa = sum(costAmount) / totalArea when cost rows present', async () => {
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({ grossTonnes: '100', netTonnesStd: '100', harvestedAreaHa: '5', records: 1, recordsWithMoisture: 1,
            byLocation: [{ locationId: 'locA', gross: '100', net: '100', area: '5' }] });
        db.parcel.findMany.mockResolvedValue([{ locationId: 'locA', areaHa: '20' }]);
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);
        db.logEntry.aggregate.mockResolvedValue({ _sum: { costAmount: '400' }, _count: { costAmount: 3 } });

        const r = await getSeasonRecap(ctx);
        expect(r.costPerHa).toBe(20); // 400 / 20
    });

    it('topFields sorted by yield desc and capped at 3', async () => {
        db.season.findMany.mockResolvedValue([SEASON]);
        mockYield({
            grossTonnes: '135', netTonnesStd: '135', harvestedAreaHa: '10', records: 5, recordsWithMoisture: 5,
            byLocation: [
                { locationId: 'a', gross: '10' },
                { locationId: 'b', gross: '50', net: '50', area: '10' },
                { locationId: 'c', gross: '30' },
                { locationId: 'd', gross: '40' },
                { locationId: 'e', gross: '5' },
            ],
        });
        db.parcel.findMany.mockResolvedValue([
            { locationId: 'b', areaHa: '10' },
        ]);
        db.location.findMany.mockResolvedValue([
            { id: 'b', name: 'B field' },
            { id: 'd', name: 'D field' },
            { id: 'c', name: 'C field' },
        ]);

        const r = await getSeasonRecap(ctx);
        expect(r.topFields).toHaveLength(3);
        expect(r.topFields.map((f) => f.locationId)).toEqual(['b', 'd', 'c']);
        expect(r.topFields.map((f) => f.yieldTonnes)).toEqual([50, 40, 30]);
        // tPerHa computed where area is known (b: 50/10), null otherwise.
        expect(r.topFields[0]).toMatchObject({ name: 'B field', areaHa: 10, tPerHa: 5 });
        expect(r.topFields[1].areaHa).toBeNull();
        expect(r.topFields[1].tPerHa).toBeNull();
    });

    it('scopes by the provided seasonId and every query filters by tenantId', async () => {
        db.season.findFirst.mockResolvedValue(SEASON);
        mockYield({ grossTonnes: '10', netTonnesStd: '10', harvestedAreaHa: '2', records: 1, recordsWithMoisture: 1,
            byLocation: [{ locationId: 'locA', gross: '10', net: '10', area: '2' }] });
        db.parcel.findMany.mockResolvedValue([{ locationId: 'locA', areaHa: '2' }]);
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);

        await getSeasonRecap(ctx, 's1');

        // seasonId path uses findFirst (not the most-recent findMany).
        expect(db.season.findFirst).toHaveBeenCalledTimes(1);
        expect(db.season.findMany).not.toHaveBeenCalled();
        expect(db.season.findFirst.mock.calls[0][0].where).toMatchObject({ id: 's1', tenantId: 't1' });

        // YieldRecord filtered by tenantId AND the season FK.
        const yieldWhere = db.yieldRecord.aggregate.mock.calls[0][0].where;
        expect(yieldWhere).toMatchObject({ tenantId: 't1', seasonId: 's1' });
        // The per-field groupBy is scoped identically.
        expect(db.yieldRecord.groupBy.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', seasonId: 's1' });

        // LogEntry count + aggregate both filter by tenantId + the season window.
        const countWhere = db.logEntry.count.mock.calls[0][0].where;
        expect(countWhere.tenantId).toBe('t1');
        expect(countWhere.occurredAt).toMatchObject({ gte: SEASON.startDate, lte: SEASON.endDate });
        const aggWhere = db.logEntry.aggregate.mock.calls[0][0].where;
        expect(aggWhere.tenantId).toBe('t1');

        // Parcel + Location reads tenant-scoped.
        expect(db.parcel.findMany.mock.calls[0][0].where.tenantId).toBe('t1');
        expect(db.location.findMany.mock.calls[0][0].where.tenantId).toBe('t1');
    });

    it('all-time scope (no seasons) → null season fields, all-tenant parcels, no occurredAt filter', async () => {
        db.season.findMany.mockResolvedValue([]); // no seasons
        mockYield({ grossTonnes: '8', netTonnesStd: '8', harvestedAreaHa: '4', records: 1, recordsWithMoisture: 1,
            byLocation: [{ locationId: 'locA', gross: '8', net: '8', area: '4' }] });
        db.parcel.findMany.mockResolvedValue([{ locationId: 'locA', areaHa: '4' }]);
        db.location.findMany.mockResolvedValue([{ id: 'locA', name: 'North' }]);

        const r = await getSeasonRecap(ctx);
        expect(r.seasonId).toBeNull();
        expect(r.seasonName).toBeNull();
        expect(r.year).toBeNull();

        // No season → YieldRecord where has no seasonId key.
        expect(db.yieldRecord.aggregate.mock.calls[0][0].where.seasonId).toBeUndefined();
        // No season → LogEntry where has no occurredAt window.
        expect(db.logEntry.count.mock.calls[0][0].where.occurredAt).toBeUndefined();
        // All-tenant parcels → no locationId filter.
        expect(db.parcel.findMany.mock.calls[0][0].where.locationId).toBeUndefined();
    });
});

describe('generateYearOnFarmPdf (smoke)', () => {
    beforeEach(resetEmpty);

    it('returns a PDFKit document for an empty tenant without throwing', async () => {
        const { generateYearOnFarmPdf } = await import('@/app-layer/reports/pdf/year-on-farm');
        const doc = await generateYearOnFarmPdf(ctx);
        expect(doc).toBeTruthy();
        expect(typeof (doc as PDFKit.PDFDocument).end).toBe('function');
        // Finalise so the stream is not left dangling.
        (doc as PDFKit.PDFDocument).end();
    });
});
