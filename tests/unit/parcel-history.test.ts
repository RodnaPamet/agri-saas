/**
 * Parcel history — the archive of what a parcel grew, and what was done to it.
 *
 * The behaviour worth pinning is not CRUD. It is:
 *
 *  1. **Weeds are split server-side.** The client sends ONE list; storage keeps
 *     two. `weedKeys` must only ever hold catalogue binomials, because that is
 *     the column "which parcels had Sorghum halepense over five years" is
 *     asked of. If a client could push free text into it by mislabelling, the
 *     controlled half would stop being reportable — silently, and only
 *     noticeably years later when the report is wrong.
 *  2. **The year is not derived from the sowing date.** Wheat sown in October
 *     2025 is the 2026 harvest. Deriving it would misfile most of Bulgarian
 *     arable cropping.
 *  3. **Only DONE operations are history.** A PENDING line is a plan.
 */
const mockPrisma = {
    parcel: { findFirst: jest.fn() },
    parcelCropSeason: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    parcelWeedObservation: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    operationParcel: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: mockPrisma, default: mockPrisma }));
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) => cb(mockPrisma),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import {
    getParcelHistory,
    createParcelCropSeason,
    createParcelWeedObservation,
} from '@/app-layer/usecases/parcel-history';
import { WEED_OPTIONS } from '@/lib/agriculture/weed-options';
import type { RequestContext } from '@/app-layer/types';

const ctx = {
    requestId: 'r',
    userId: 'usr_1',
    tenantId: 'tnt_1',
    tenantSlug: 'acme',
    role: 'EDITOR',
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false },
    appPermissions: {},
} as unknown as RequestContext;

const PARCEL = { id: 'p1', name: 'North block', cropType: 'Wheat' };

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.parcel.findFirst.mockResolvedValue(PARCEL);
    mockPrisma.parcelCropSeason.findMany.mockResolvedValue([]);
    mockPrisma.parcelWeedObservation.findMany.mockResolvedValue([]);
    mockPrisma.operationParcel.findMany.mockResolvedValue([]);
    mockPrisma.parcelCropSeason.create.mockImplementation(({ data }: never) => ({ id: 'cs1', ...(data as object) }));
    mockPrisma.parcelWeedObservation.create.mockImplementation(({ data }: never) => ({ id: 'wo1', ...(data as object) }));
});

describe('weeds are partitioned server-side', () => {
    const CATALOGUE = WEED_OPTIONS[0].value; // 'Sorghum halepense'

    it('a catalogue binomial goes to weedKeys, free text to otherWeeds', async () => {
        await createParcelWeedObservation(ctx, {
            parcelId: 'p1',
            observedAt: new Date('2026-05-14'),
            weeds: [CATALOGUE, 'някакъв друг плевел'],
        });
        const { data } = mockPrisma.parcelWeedObservation.create.mock.calls[0][0];
        expect(data.weedKeys).toEqual([CATALOGUE]);
        expect(data.otherWeeds).toEqual(['някакъв друг плевел']);
    });

    it('a client cannot push free text into the reportable column', () => {
        // The whole point of splitting on the server. There is no input shape
        // that lets the caller choose which column a value lands in.
        return createParcelWeedObservation(ctx, {
            parcelId: 'p1',
            observedAt: new Date('2026-05-14'),
            weeds: ['Not A Real Binomial'],
        }).then(() => {
            const { data } = mockPrisma.parcelWeedObservation.create.mock.calls[0][0];
            expect(data.weedKeys).toEqual([]);
            expect(data.otherWeeds).toEqual(['Not A Real Binomial']);
        });
    });

    it('duplicates collapse, in both halves', async () => {
        await createParcelWeedObservation(ctx, {
            parcelId: 'p1',
            observedAt: new Date('2026-05-14'),
            weeds: [CATALOGUE, CATALOGUE, 'дива ряпа', 'дива ряпа'],
        });
        const { data } = mockPrisma.parcelWeedObservation.create.mock.calls[0][0];
        expect(data.weedKeys).toHaveLength(1);
        expect(data.otherWeeds).toHaveLength(1);
    });

    it('an observation with nothing in it is refused', async () => {
        await expect(
            createParcelWeedObservation(ctx, {
                parcelId: 'p1',
                observedAt: new Date('2026-05-14'),
                weeds: ['   '],
            }),
        ).rejects.toThrow(/at least one weed/i);
    });
});

describe('the harvest year', () => {
    it('accepts a year two ahead — an autumn crop is sown the year before', async () => {
        const next = new Date().getUTCFullYear() + 1;
        await createParcelCropSeason(ctx, { parcelId: 'p1', year: next, cropType: 'Wheat' });
        expect(mockPrisma.parcelCropSeason.create).toHaveBeenCalled();
    });

    it('accepts a back-filled year decades ago — that is what an archive is for', async () => {
        await createParcelCropSeason(ctx, { parcelId: 'p1', year: 1985, cropType: 'Barley' });
        expect(mockPrisma.parcelCropSeason.create).toHaveBeenCalled();
    });

    it('refuses a year outside the range', async () => {
        await expect(
            createParcelCropSeason(ctx, { parcelId: 'p1', year: 1799, cropType: 'Wheat' }),
        ).rejects.toThrow(/out of range/i);
        await expect(
            createParcelCropSeason(ctx, { parcelId: 'p1', year: 2.5, cropType: 'Wheat' }),
        ).rejects.toThrow(/out of range/i);
    });

    it('accepts an off-catalogue crop — production already holds one', async () => {
        // `Grass` is live on a real parcel and is not in CROP_OPTIONS. Strict
        // validation would make existing data un-backfillable on day one.
        await createParcelCropSeason(ctx, { parcelId: 'p1', year: 2024, cropType: 'Grass' });
        const { data } = mockPrisma.parcelCropSeason.create.mock.calls[0][0];
        expect(data.cropType).toBe('Grass');
    });
});

describe('the timeline', () => {
    it('reads only COMPLETED operations — a plan is not history', async () => {
        await getParcelHistory(ctx, 'p1');
        const where = mockPrisma.operationParcel.findMany.mock.calls[0][0].where;
        expect(where.status).toBe('DONE');
        expect(where.parcelId).toBe('p1');
        expect(where.tenantId).toBe('tnt_1');
    });

    it('carries the dose as a string, so it cannot be rounded', async () => {
        mockPrisma.operationParcel.findMany.mockResolvedValue([
            {
                id: 'op1', taskId: 't1', completedAt: new Date('2026-04-02'),
                doseValue: { toString: () => '1.2345' }, targetNote: null,
                product: { name: 'Roundup' }, doseUnit: { symbol: 'l/ha' },
                task: { operationType: 'SPRAY', title: 'Spray' },
            },
        ]);
        const history = await getParcelHistory(ctx, 'p1');
        expect(history.operations[0].doseValue).toBe('1.2345');
        expect(typeof history.operations[0].doseValue).toBe('string');
    });

    it('refuses a parcel outside the tenant', async () => {
        mockPrisma.parcel.findFirst.mockResolvedValue(null);
        await expect(getParcelHistory(ctx, 'p-other')).rejects.toThrow(/not found/i);
    });

    it('orders crop seasons newest-first with a stable tie-break', async () => {
        await getParcelHistory(ctx, 'p1');
        const orderBy = mockPrisma.parcelCropSeason.findMany.mock.calls[0][0].orderBy;
        expect(orderBy[0]).toEqual({ year: 'desc' });
        // Second crop in the same year must not be ordered by the query plan.
        expect(orderBy[1]).toEqual({ createdAt: 'desc' });
    });
});
