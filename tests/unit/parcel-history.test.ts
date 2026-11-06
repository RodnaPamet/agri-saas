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
    updateParcelCropSeason,
    updateParcelWeedObservation,
} from '@/app-layer/usecases/parcel-history';
import { logEvent } from '@/app-layer/events/audit';
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
    mockPrisma.parcelCropSeason.findFirst.mockResolvedValue({
        id: 'cs1', parcelId: 'p1', year: 2025, cropType: 'Wheat',
    });
    mockPrisma.parcelWeedObservation.findFirst.mockResolvedValue({
        id: 'wo1', parcelId: 'p1', observedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    mockPrisma.parcelCropSeason.update.mockImplementation(({ data }: never) => ({
        id: 'cs1', parcelId: 'p1', year: 2025, cropType: 'Wheat', ...(data as object),
    }));
    mockPrisma.parcelWeedObservation.update.mockImplementation(({ data }: never) => ({
        id: 'wo1', parcelId: 'p1', observedAt: new Date('2026-05-01T00:00:00.000Z'), ...(data as object),
    }));
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

    it('every limit refusal names the limit AND carries it as a param', async () => {
        // All four of these told the caller what it SENT and never what is
        // allowed: "out of range", "too many weeds", "too long". A farmer who
        // types 2001 characters of notes was left to guess at 2000.
        //
        // Both halves are asserted. The SENTENCE is what a person reads, and
        // the PARAM is what a client needs to render its own hint or cap an
        // input — and the param is the half that would quietly disappear,
        // since nothing renders it today.
        // THUNKS, not promises. Building the calls eagerly starts all four
        // at once and leaves their rejections unhandled until the loop gets
        // to them — Node reports an unhandled rejection and jest reports the
        // whole suite as 0 tests. It passed by timing alone until a mutation
        // shifted it, which is the kind of pass a mutation proof is for.
        const cases: Array<[() => Promise<unknown>, RegExp, string[]]> = [
            [
                () => createParcelCropSeason(ctx, { parcelId: 'p1', year: 1799, cropType: 'Wheat' }),
                /between 1900 and \d{4}/,
                ['year', 'min', 'max'],
            ],
            [
                () => createParcelWeedObservation(ctx, {
                    parcelId: 'p1',
                    observedAt: new Date('2026-05-14'),
                    weeds: Array.from({ length: 51 }, (_, i) => `weed-${i}`),
                }),
                /at most 50/,
                ['count', 'max'],
            ],
            [
                () => createParcelWeedObservation(ctx, {
                    parcelId: 'p1',
                    observedAt: new Date('2026-05-14'),
                    weeds: ['x'.repeat(121)],
                }),
                /at most 120 characters/,
                ['max'],
            ],
            [
                () => createParcelCropSeason(ctx, {
                    parcelId: 'p1',
                    year: 2026,
                    cropType: 'Wheat',
                    notes: 'n'.repeat(2001),
                }),
                /at most 2000 characters/,
                ['max'],
            ],
        ];

        for (const [call, namesTheLimit, wantParams] of cases) {
            const err = await call().then(
                () => null,
                (e: unknown) => e as { message: string; params?: Record<string, unknown> },
            );
            // A control: if the call stopped refusing, every assertion below
            // would be skipped and this test would pass on nothing.
            expect(err).not.toBeNull();
            expect(err!.message).toMatch(namesTheLimit);
            expect(Object.keys(err!.params ?? {}).sort()).toEqual([...wantParams].sort());
        }
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
        //
        // The tiebreak is `id`, not `createdAt` as it was before pagination.
        // `createdAt` was a fine STABLE order but is not a valid CURSOR key:
        // two seasons created in the same millisecond compare equal, so the
        // pair straddling a page boundary loses one and repeats the other. `id`
        // is unique, which makes the order total.
        expect(orderBy[1]).toEqual({ id: 'desc' });
    });
});

describe('pagination — three lists, three cursors', () => {
    /** n rows sharing a year, so the tiebreak is what separates them. */
    function seasons(n: number, year = 2024) {
        return Array.from({ length: n }, (_, i) => ({
            id: `cs${String(i).padStart(3, '0')}`,
            year, cropType: 'Wheat', sownAt: null, harvestedAt: null, notes: null,
        }));
    }
    function ops(n: number) {
        return Array.from({ length: n }, (_, i) => ({
            id: `op${String(i).padStart(3, '0')}`,
            taskId: 't1',
            completedAt: new Date(`2026-05-${String(28 - i).padStart(2, '0')}T08:00:00Z`),
            doseValue: 1, targetNote: null,
            product: { name: 'P' }, doseUnit: { symbol: 'l' },
            task: { operationType: 'SPRAY', title: 'Spray' },
        }));
    }
    function weeds(n: number) {
        return Array.from({ length: n }, (_, i) => ({
            id: `w${String(i).padStart(3, '0')}`,
            observedAt: new Date(`2026-05-${String(28 - i).padStart(2, '0')}T08:00:00Z`),
            weedKeys: [], otherWeeds: [], notes: null,
        }));
    }

    it('over-fetches one row per list to learn whether more exist', async () => {
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue(seasons(2));
        mockPrisma.operationParcel.findMany.mockResolvedValue(ops(2));
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue(weeds(2));
        await getParcelHistory(ctx, 'p1', { limit: 5 });
        for (const m of [
            mockPrisma.parcelCropSeason.findMany,
            mockPrisma.operationParcel.findMany,
            mockPrisma.parcelWeedObservation.findMany,
        ]) {
            expect((m.mock.calls.at(-1) as [{ take: number }])[0].take).toBe(6);
        }
    });

    it('a FULL final page on any list reports no cursor for that list', async () => {
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue(seasons(5));
        mockPrisma.operationParcel.findMany.mockResolvedValue(ops(5));
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue(weeds(5));
        const r = await getParcelHistory(ctx, 'p1', { limit: 5 });
        expect(r.cropSeasons).toHaveLength(5);
        expect(r.cropSeasonsCursor).toBeNull();
        expect(r.operationsCursor).toBeNull();
        expect(r.weedObservationsCursor).toBeNull();
    });

    it('paginates each list INDEPENDENTLY — one long list does not cursor the others', async () => {
        // The point of three cursors. A parcel with 200 operations and 3 crop
        // seasons must not advertise more crop seasons.
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue(seasons(3));
        mockPrisma.operationParcel.findMany.mockResolvedValue(ops(6));
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue(weeds(1));
        const r = await getParcelHistory(ctx, 'p1', { limit: 5 });
        expect(r.cropSeasonsCursor).toBeNull();
        expect(r.weedObservationsCursor).toBeNull();
        expect(r.operationsCursor).toEqual(expect.any(String));
        expect(r.operations).toHaveLength(5);
    });

    it("the crop-season cursor carries the YEAR, not a fabricated date", async () => {
        // `year` is an integer. Encoding it as a date would put a fake
        // January the 1st in the cursor and paginate on a value the ORDER BY
        // does not use, which skips rows rather than failing.
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue(seasons(6, 2019));
        mockPrisma.operationParcel.findMany.mockResolvedValue([]);
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue([]);
        const r = await getParcelHistory(ctx, 'p1', { limit: 5 });
        const decoded = Buffer.from(String(r.cropSeasonsCursor), 'base64url').toString('utf8');
        expect(decoded).toBe('2019|cs004');
    });

    it('feeding a cursor back builds a keyset predicate, not a bare lt', async () => {
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue(seasons(6, 2019));
        mockPrisma.operationParcel.findMany.mockResolvedValue([]);
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue([]);
        const first = await getParcelHistory(ctx, 'p1', { limit: 5 });
        await getParcelHistory(ctx, 'p1', { limit: 5, seasonsBefore: first.cropSeasonsCursor });
        const [args] = mockPrisma.parcelCropSeason.findMany.mock.calls.at(-1) as [
            { where: { OR?: unknown[] } },
        ];
        expect(args.where?.OR).toHaveLength(2);
    });

    it('a garbage cursor restarts that list rather than erroring', async () => {
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue(seasons(2));
        mockPrisma.operationParcel.findMany.mockResolvedValue([]);
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue([]);
        const r = await getParcelHistory(ctx, 'p1', { seasonsBefore: 'nonsense' });
        expect(r.cropSeasons).toHaveLength(2);
        const [args] = mockPrisma.parcelCropSeason.findMany.mock.calls.at(-1) as [
            { where: Record<string, unknown> },
        ];
        expect(args.where.OR).toBeUndefined();
    });
});


describe('what was applied — the category, not the label', () => {
    function opLine(over: Record<string, unknown> = {}) {
        return [{
            id: 'op1', taskId: 't1',
            completedAt: new Date('2026-05-20T08:00:00Z'),
            doseValue: 2.5, targetNote: null,
            product: { name: 'Roundup', category: 'PESTICIDE' },
            doseUnit: { symbol: 'l/da' },
            task: { operationType: 'SPRAY', title: 'Spray' },
            ...over,
        }];
    }

    beforeEach(() => {
        mockPrisma.parcelCropSeason.findMany.mockResolvedValue([]);
        mockPrisma.parcelWeedObservation.findMany.mockResolvedValue([]);
    });

    it('projects the item category', async () => {
        mockPrisma.operationParcel.findMany.mockResolvedValue(opLine());
        const r = await getParcelHistory(ctx, 'p1');
        expect(r.operations[0].productCategory).toBe('PESTICIDE');
    });

    it('answers even when operationType is NULL — the case it exists for', async () => {
        // A third of the operation lines in production have no operationType,
        // and for those it is the only thing that can say what was applied.
        mockPrisma.operationParcel.findMany.mockResolvedValue(
            opLine({
                product: { name: 'Urea', category: 'FERTILIZER' },
                task: { operationType: null, title: 'Application' },
            }),
        );
        const r = await getParcelHistory(ctx, 'p1');
        expect(r.operations[0].operationType).toBeNull();
        expect(r.operations[0].productCategory).toBe('FERTILIZER');
    });

    it('contradicts a mislabelled operationType rather than echoing it', async () => {
        // `operationType` is caller-settable and wins over the server's own
        // derivation, so a fertiliser CAN be recorded as SPRAY. The category
        // comes off the item and cannot be talked out of it.
        mockPrisma.operationParcel.findMany.mockResolvedValue(
            opLine({
                product: { name: 'Urea', category: 'FERTILIZER' },
                task: { operationType: 'SPRAY', title: 'Mislabelled' },
            }),
        );
        const r = await getParcelHistory(ctx, 'p1');
        expect(r.operations[0].operationType).toBe('SPRAY');
        expect(r.operations[0].productCategory).toBe('FERTILIZER');
    });

    it('is NULL, not empty string, when the relation is missing', async () => {
        // Unlike its `productName` neighbour, which collapses to ''. An empty
        // string is a plausible name and not a plausible category.
        mockPrisma.operationParcel.findMany.mockResolvedValue(opLine({ product: null }));
        const r = await getParcelHistory(ctx, 'p1');
        expect(r.operations[0].productCategory).toBeNull();
        expect(r.operations[0].productName).toBe('');
    });
});

/**
 * Corrections (owner ruling 2026-11-06).
 *
 * A mock is the RIGHT instrument here, which is worth saying because this repo's
 * standing rule is that a double cannot report an encoding. None of these
 * columns is encrypted, and every property below is about WHICH KEYS reach
 * `update()` — exactly what a double reports perfectly and a real row would
 * obscure behind a round trip.
 */
describe('a correction is partial: omitted is not null', () => {
    it('sends ONLY the fields given, leaving the rest untouched', async () => {
        await updateParcelCropSeason(ctx, 'cs1', { cropType: 'Barley' });

        const { data } = mockPrisma.parcelCropSeason.update.mock.calls[0][0];
        expect(Object.keys(data).sort()).toEqual(['cropType']);
        // The assertion that matters: the four fields NOT sent are absent from
        // `data` rather than present as null. Present-as-null would blank a
        // sowing date every time somebody corrected a crop name.
        expect(data).not.toHaveProperty('year');
        expect(data).not.toHaveProperty('sownAt');
        expect(data).not.toHaveProperty('harvestedAt');
        expect(data).not.toHaveProperty('notes');
    });

    it('an explicit null CLEARS a nullable field', async () => {
        await updateParcelCropSeason(ctx, 'cs1', { sownAt: null });
        const { data } = mockPrisma.parcelCropSeason.update.mock.calls[0][0];
        expect(Object.keys(data)).toEqual(['sownAt']);
        expect(data.sownAt).toBeNull();
    });

    it('refuses a body that changes nothing', async () => {
        await expect(updateParcelCropSeason(ctx, 'cs1', {})).rejects.toMatchObject({
            code: 'NO_FIELDS_TO_UPDATE',
        });
        expect(mockPrisma.parcelCropSeason.update).not.toHaveBeenCalled();
    });

    it('cannot move the record to another parcel', async () => {
        // `parcelId` is not on the input type, so the only way to try is to
        // smuggle it. It must not reach `data` — a relocated agronomic record
        // would leave the receiving parcel with a season nobody recorded.
        await updateParcelCropSeason(ctx, 'cs1', { parcelId: 'p2', cropType: 'Oats' } as never);
        const { data } = mockPrisma.parcelCropSeason.update.mock.calls[0][0];
        expect(data).not.toHaveProperty('parcelId');
    });

    it('reads through the soft-delete filter, so a tombstone is not editable', async () => {
        await updateParcelCropSeason(ctx, 'cs1', { cropType: 'Rye' });
        const { where } = mockPrisma.parcelCropSeason.findFirst.mock.calls.at(-1)![0];
        // `deletedAt: null` is the half that matters — without it an edit would
        // resurrect a deleted season's content while leaving it deleted.
        expect(where).toMatchObject({ id: 'cs1', tenantId: 'tnt_1', deletedAt: null });
    });

    it('404s when the row is gone', async () => {
        mockPrisma.parcelCropSeason.findFirst.mockResolvedValue(null);
        await expect(updateParcelCropSeason(ctx, 'cs1', { cropType: 'Rye' })).rejects.toMatchObject({
            code: 'CROP_SEASON_NOT_FOUND',
        });
    });
});

describe('a correction is audited, not silent', () => {
    it('writes UPDATE with changedFields naming what moved', async () => {
        await updateParcelCropSeason(ctx, 'cs1', { year: 2026, notes: 'rechecked' });

        const payload = (logEvent as jest.Mock).mock.calls.at(-1)![2];
        expect(payload.action).toBe('UPDATE');
        expect(payload.entityType).toBe('ParcelCropSeason');
        expect(payload.detailsJson.operation).toBe('updated');
        expect(payload.detailsJson.changedFields.sort()).toEqual(['notes', 'year']);
        // before/after carry the identifying fields so a reader can tell WHICH
        // season this was and what it became.
        expect(payload.detailsJson.before).toMatchObject({ year: 2025 });
        expect(payload.detailsJson.after).toMatchObject({ year: 2026 });
    });
});

describe('a weed observation correction replaces the list whole', () => {
    it('re-partitions into BOTH columns together', async () => {
        const known = WEED_OPTIONS[0].key;
        await updateParcelWeedObservation(ctx, 'wo1', { weeds: [known, 'some weed nobody catalogued'] });

        const { data } = mockPrisma.parcelWeedObservation.update.mock.calls[0][0];
        // Both halves move, or neither. One without the other would leave a row
        // whose two columns came from different submissions.
        expect(Object.keys(data).sort()).toEqual(['otherWeeds', 'weedKeys']);
        expect(data.weedKeys).toEqual([known]);
        expect(data.otherWeeds).toEqual(['some weed nobody catalogued']);
    });

    it('refuses an EMPTY list rather than emptying the observation', async () => {
        await expect(updateParcelWeedObservation(ctx, 'wo1', { weeds: [] })).rejects.toMatchObject({
            code: 'WEEDS_REQUIRED',
        });
        expect(mockPrisma.parcelWeedObservation.update).not.toHaveBeenCalled();
    });

    it('never touches the create path\u2019s idempotency key', async () => {
        await updateParcelWeedObservation(ctx, 'wo1', { notes: 'clarified' });
        const { data } = mockPrisma.parcelWeedObservation.update.mock.calls[0][0];
        // It identifies the SUBMISSION, not the contents — rewriting it would
        // make a replay of the original create return this edited row.
        expect(data).not.toHaveProperty('clientMutationId');
    });
});
