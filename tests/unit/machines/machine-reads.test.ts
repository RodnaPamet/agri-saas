/**
 * The three `/machines` reads — #2948 stage 3.
 *
 * The repository is mocked, so this covers the usecase's own decisions: what
 * it refuses, what it does NOT query, and the shape it hands the phone.
 * Everything asserted here is something a client renders directly.
 */
const mockDb = {} as never;
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const MachineRepository = {
    listLocatableAssets: jest.fn(),
    findLocatableAsset: jest.fn(),
    liveTrackerAssetIds: jest.fn(),
    liveTelematicsProviders: jest.fn(),
    latestPositions: jest.fn(),
    listDayPositions: jest.fn(),
    listWorkedParcels: jest.fn(),
    findWorkedDayMarker: jest.fn(),
};
jest.mock('../../../src/app-layer/repositories/MachineRepository', () => ({
    MachineRepository,
}));

import { MAX_POSITIONS_PER_DAY } from '@/lib/machines/fleet-view';
import {
    listMachines,
    readMachineTrack,
    readMachineWorked,
} from '@/app-layer/usecases/machines';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const ASSET = { id: 'a1', name: 'John Deere 6155M', type: 'TRACTOR' as const };

/** A position row shaped as Prisma returns it — Decimal-like, real Date. */
function position(over: Partial<Record<string, unknown>> = {}) {
    return {
        assetId: 'a1',
        lat: { toString: () => '43.4120000' },
        lon: { toString: () => '27.8310000' },
        recordedAt: new Date('2026-11-12T08:00:00.000Z'),
        speedKph: { toString: () => '7.5' },
        ignition: true,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears CALLS, not implementations — so every default is
    // reinstalled here rather than once at module scope, or a test that
    // installs a throwing implementation poisons every later one in the file.
    MachineRepository.listLocatableAssets.mockResolvedValue([ASSET]);
    MachineRepository.findLocatableAsset.mockResolvedValue(ASSET);
    MachineRepository.liveTrackerAssetIds.mockResolvedValue(new Set<string>());
    MachineRepository.liveTelematicsProviders.mockResolvedValue(new Map());
    MachineRepository.latestPositions.mockResolvedValue([]);
    MachineRepository.listDayPositions.mockResolvedValue([]);
    MachineRepository.listWorkedParcels.mockResolvedValue([]);
    // No marker by default: an UNPROCESSED day is the empty state.
    MachineRepository.findWorkedDayMarker.mockResolvedValue(null);
});

describe('listMachines', () => {
    it('reports configuration and liveness as SEPARATE answers', async () => {
        // The split #2948 settled without adding a field: `positionSource`
        // null means nothing is connected, `lastPosition` null means connected
        // and never heard from. Both null is the "no tracker yet" machine.
        const out = await listMachines(ctx);
        expect(out.machines).toEqual([
            {
                assetId: 'a1',
                name: 'John Deere 6155M',
                type: 'TRACTOR',
                positionSource: null,
                lastPosition: null,
            },
        ]);
    });

    it('derives `moving` on the server and emits coordinates as STRINGS', async () => {
        MachineRepository.liveTrackerAssetIds.mockResolvedValue(new Set(['a1']));
        MachineRepository.latestPositions.mockResolvedValue([position()]);

        const [row] = (await listMachines(ctx)).machines;
        expect(row.positionSource).toEqual({ kind: 'TRACKER', provider: null });
        expect(row.lastPosition).toEqual({
            lat: '43.4120000',
            lon: '27.8310000',
            recordedAt: '2026-11-12T08:00:00.000Z',
            speedKph: 7.5,
            ignition: true,
            moving: true,
        });
        // The coordinate is the stored decimal's string, NOT a float. A
        // `Number()` here is what the Decimal column exists to prevent, and it
        // would read as a harmless formatting choice.
        expect(typeof row.lastPosition!.lat).toBe('string');
        expect(row.lastPosition!.lat).toBe('43.4120000');
    });

    it('reports a parked machine as not moving', async () => {
        MachineRepository.latestPositions.mockResolvedValue([
            position({ speedKph: { toString: () => '0.4' } }),
        ]);
        const [row] = (await listMachines(ctx)).machines;
        expect(row.lastPosition!.moving).toBe(false);
    });

    it('does NOT read per machine — three queries for any fleet size', async () => {
        const many = Array.from({ length: 25 }, (_, i) => ({
            id: `a${i}`,
            name: `M${i}`,
            type: 'TRACTOR' as const,
        }));
        MachineRepository.listLocatableAssets.mockResolvedValue(many);

        await listMachines(ctx);

        // The D1 N+1 shape would be 3 x 25. Each of these must be called ONCE,
        // with the whole id list.
        expect(MachineRepository.liveTrackerAssetIds).toHaveBeenCalledTimes(1);
        expect(MachineRepository.liveTelematicsProviders).toHaveBeenCalledTimes(1);
        expect(MachineRepository.latestPositions).toHaveBeenCalledTimes(1);
        expect(MachineRepository.latestPositions.mock.calls[0][2]).toHaveLength(25);
    });

    it('asks nothing further when the farm has no machines', async () => {
        MachineRepository.listLocatableAssets.mockResolvedValue([]);
        const out = await listMachines(ctx);
        expect(out).toEqual({ machines: [] });
        // An empty `IN ()` is not a query worth sending, and the repository
        // guards it too — this asserts the usecase does not rely on that.
        expect(MachineRepository.latestPositions).not.toHaveBeenCalled();
    });
});

describe('readMachineTrack', () => {
    it('refuses a date that does not exist, before any query', async () => {
        // A parser is not a validator: `new Date('2026-02-31')` rolls forward
        // to 3 March rather than failing, so a shape check alone would answer
        // confidently about the wrong day.
        await expect(readMachineTrack(ctx, 'a1', '2026-02-31')).rejects.toThrow(
            /does not exist/i,
        );
        expect(MachineRepository.findLocatableAsset).not.toHaveBeenCalled();
        expect(MachineRepository.listDayPositions).not.toHaveBeenCalled();
    });

    it('refuses a missing or malformed date rather than defaulting to today', async () => {
        // Defaulting would answer about a different day than the caller meant,
        // on an endpoint whose whole subject is which day.
        await expect(readMachineTrack(ctx, 'a1', null)).rejects.toThrow(/required/i);
        await expect(readMachineTrack(ctx, 'a1', '12/11/2026')).rejects.toThrow(/required/i);
        expect(MachineRepository.listDayPositions).not.toHaveBeenCalled();
    });

    it('404s for an asset that is absent OR not locatable', async () => {
        MachineRepository.findLocatableAsset.mockResolvedValue(null);
        await expect(readMachineTrack(ctx, 'a1', '2026-11-12')).rejects.toThrow(
            /No such machine/,
        );
    });

    it('reports a day past the window as NOT RETAINED and queries nothing', async () => {
        const out = await readMachineTrack(
            ctx,
            'a1',
            '2026-01-01',
            new Date('2026-11-12T10:00:00Z'),
        );
        expect(out.retained).toBe(false);
        expect(out.points).toEqual([]);
        // The whole point: an empty array here MEANS the deletion. Querying a
        // range the sweep has emptied would also be a scan for nothing.
        expect(MachineRepository.listDayPositions).not.toHaveBeenCalled();
    });

    it('distinguishes TRUNCATED from SIMPLIFIED', async () => {
        // Two different claims. `truncated` means rows were never considered;
        // `simplified` means they all were and the line was reduced. A day
        // that hit the read ceiling must not render as a complete one.
        const rows = Array.from({ length: MAX_POSITIONS_PER_DAY + 1 }, (_, i) =>
            position({
                lat: { toString: () => `43.${String(400000 + i).padStart(7, '0')}` },
                recordedAt: new Date(Date.UTC(2026, 10, 12, 6, 0, i % 60)),
            }),
        );
        MachineRepository.listDayPositions.mockResolvedValue(rows);

        const out = await readMachineTrack(
            ctx,
            'a1',
            '2026-11-12',
            new Date('2026-11-12T23:00:00Z'),
        );
        expect(out.truncated).toBe(true);
        expect(out.rawCount).toBe(MAX_POSITIONS_PER_DAY);
        expect(out.points.length).toBeLessThan(out.rawCount);
        expect(out.simplified).toBe(true);
    });

    it('reports a short day as neither truncated nor simplified', async () => {
        MachineRepository.listDayPositions.mockResolvedValue([position(), position()]);
        const out = await readMachineTrack(
            ctx,
            'a1',
            '2026-11-12',
            new Date('2026-11-12T23:00:00Z'),
        );
        expect(out.truncated).toBe(false);
        expect(out.simplified).toBe(false);
        expect(out.rawCount).toBe(2);
        expect(out.points).toHaveLength(2);
    });

    it('hands the simplifier STRING coordinates and returns them unrebuilt', async () => {
        MachineRepository.listDayPositions.mockResolvedValue([position(), position()]);
        const out = await readMachineTrack(
            ctx,
            'a1',
            '2026-11-12',
            new Date('2026-11-12T23:00:00Z'),
        );
        expect(out.points[0].lat).toBe('43.4120000');
        // Trailing zeros survive, which is the observable proof no float was
        // involved: `Number('43.4120000')` renders back as "43.412".
        expect(out.points[0].lat).not.toBe('43.412');
    });
});

describe('readMachineWorked', () => {
    it('always reports retained — this is what survives the sweep', async () => {
        const out = await readMachineWorked(ctx, 'a1', '2024-01-01');
        expect(out.retained).toBe(true);
        // Years old, and still answerable, which is the whole reason for
        // aggregating rather than keeping the raw trace.
        expect(MachineRepository.listWorkedParcels).toHaveBeenCalled();
    });

    it('matches the @db.Date column on the plain day, not a Sofia instant', async () => {
        await readMachineWorked(ctx, 'a1', '2026-11-12');
        const passed = MachineRepository.listWorkedParcels.mock.calls[0][3] as Date;
        // `farmDayRange` would give 2026-11-11T22:00Z for a Sofia day, which
        // on a DATE column selects the neighbouring day's rows.
        expect(passed.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    });

    it('maps a derived row to the client shape', async () => {
        MachineRepository.listWorkedParcels.mockResolvedValue([
            {
                parcelId: 'p1',
                minutesWorked: 95,
                areaHa: { toString: () => '12.250' },
                confidence: { toString: () => '0.80' },
                derivedAt: new Date('2026-11-13T02:15:00.000Z'),
                parcel: { name: 'Юг 4' },
            },
        ]);
        // #2984: the timestamp is the MARKER's, not the row's. The row still
        // carries one and it is deliberately DIFFERENT here, so a reader that
        // went back to reducing over rows fails rather than passing by
        // coincidence.
        MachineRepository.findWorkedDayMarker.mockResolvedValue({
            derivedAt: new Date('2026-11-13T02:20:00.000Z'),
            derivedFrom: 'v1:test',
            positionsConsidered: 120,
            parcelsMatched: 1,
        });
        const out = await readMachineWorked(ctx, 'a1', '2026-11-12');
        expect(out.parcels).toEqual([
            {
                parcelId: 'p1',
                name: 'Юг 4',
                minutesWorked: 95,
                areaHa: 12.25,
                confidence: 0.8,
            },
        ]);
        expect(out.derivedAt).toBe('2026-11-13T02:20:00.000Z');
    });

    it('reports the LATEST run when a day was re-derived', async () => {
        /*
         * Previously this reduced over the rows' own `derivedAt` values and
         * took the newest. Since #2984 the marker answers it, and the marker
         * is UPSERTED per (asset, day) — so "the latest run" is a property of
         * that one row rather than something reconstructed from the rows it
         * produced. The row timestamps below are deliberately STALE, which is
         * the case a re-derivation leaves behind when it rewrites some parcels
         * and not others.
         */
        MachineRepository.listWorkedParcels.mockResolvedValue([
            {
                parcelId: 'p1', minutesWorked: 10, areaHa: null, confidence: null,
                derivedAt: new Date('2026-11-13T02:00:00.000Z'), parcel: { name: 'A' },
            },
            {
                parcelId: 'p2', minutesWorked: 20, areaHa: null, confidence: null,
                derivedAt: new Date('2026-11-13T02:00:00.000Z'), parcel: { name: 'B' },
            },
        ]);
        MachineRepository.findWorkedDayMarker.mockResolvedValue({
            derivedAt: new Date('2026-11-14T02:00:00.000Z'),
            derivedFrom: 'v1:test',
            positionsConsidered: 300,
            parcelsMatched: 2,
        });
        const out = await readMachineWorked(ctx, 'a1', '2026-11-12');
        expect(out.derivedAt).toBe('2026-11-14T02:00:00.000Z');
    });

    it('an empty day WITH a marker says "ran and found nothing" — #2984', async () => {
        /*
         * The limit this file pinned until now, and its predecessor said "when
         * it lands this test changes in the same diff". It has: the middle row
         * of #2948 Addendum 2's table is expressible, because the timestamp
         * comes from `MachineWorkedDay` rather than from rows an idle day does
         * not have.
         */
        MachineRepository.findWorkedDayMarker.mockResolvedValue({
            derivedAt: new Date('2026-11-13T02:20:00.000Z'),
            derivedFrom: 'v1:test',
            // The machine reported, and nothing was work — which is what
            // separates an idle day from a tracker that sent nothing usable.
            positionsConsidered: 420,
            parcelsMatched: 0,
        });
        const out = await readMachineWorked(ctx, 'a1', '2026-11-12');
        expect(out.parcels).toEqual([]);
        expect(out.derivedAt).toBe('2026-11-13T02:20:00.000Z');
    });

    it('an empty day with NO marker still says "not computed yet"', async () => {
        // The control for the test above. Without it, a reader that reported a
        // timestamp unconditionally would satisfy the new assertion and
        // destroy the distinction the whole issue is about.
        const out = await readMachineWorked(ctx, 'a1', '2026-11-12');
        expect(out.parcels).toEqual([]);
        expect(out.derivedAt).toBeNull();
    });

    it('404s for an asset that is absent OR not locatable', async () => {
        MachineRepository.findLocatableAsset.mockResolvedValue(null);
        await expect(readMachineWorked(ctx, 'a1', '2026-11-12')).rejects.toThrow(
            /No such machine/,
        );
    });
});
