/**
 * `ParcelIndexReading` — tenant isolation, the idempotent upsert, and the
 * monotonic coverage watermark, against a real database (#2837 stage 1b).
 *
 * Three things here cannot be covered by the mocked unit suite, and all three
 * are the kind that fail silently:
 *
 * 1. **The policies.** `ALTER DEFAULT PRIVILEGES` (migration 20260323180000)
 *    already grants `app_user` SELECT/INSERT/UPDATE/DELETE on every new table
 *    in `public`, so this table is reachable by a tenant session the moment it
 *    exists. RLS is the only thing between it and a cross-farm read.
 * 2. **The upsert's unique key.** A mocked Prisma returns its row whatever it
 *    was asked, so "a re-run replaces the day rather than appending" is a
 *    claim about a constraint only the database can refuse.
 * 3. **The watermark SQL.** `storeIndexReadings` widens the window with raw
 *    `LEAST`/`GREATEST` inside a `CASE` on the algorithm version. Nothing in
 *    TypeScript executes that expression; a wrong `COALESCE` or a reversed
 *    comparison narrows coverage and silently re-searches — or worse, stops
 *    searching — for ever.
 *
 * ## The shape of the negatives, and why it is not optional
 *
 * Under RLS a write is refused with `42501` only when the row is VISIBLE. When
 * SELECT hides it, a DELETE or UPDATE affects ZERO rows and returns NORMALLY.
 * So every negative asserts a row COUNT or a raised code, never that a call
 * returned.
 *
 * And the positives carry the same weight: a silently unset session variable
 * also yields zero rows, so each case asserts its OWN farm sees its row before
 * asserting the other farm does not.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { withTenantDb, runInTenantContext } from '@/lib/db-context';
import { ParcelRepository } from '@/app-layer/repositories/ParcelRepository';
import { makeRequestContext } from '../helpers/make-context';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `pir-${randomUUID().slice(0, 8)}`;

let farmA = '';
let farmB = '';
let parcelA = '';
let parcelB = '';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function makeFarm(suffix: string): Promise<{ tenantId: string; parcelId: string }> {
    const tenant = await prisma.tenant.create({
        data: { name: `${TAG}-${suffix}`, slug: `${TAG}-${suffix}` },
        select: { id: true },
    });
    const location = await prisma.location.create({
        data: { tenantId: tenant.id, name: `${TAG}-${suffix}-blok` },
        select: { id: true },
    });
    const parcel = await prisma.parcel.create({
        data: { tenantId: tenant.id, locationId: location.id, name: `${TAG}-${suffix}-parcel` },
        select: { id: true },
    });
    return { tenantId: tenant.id, parcelId: parcel.id };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const a = await makeFarm('a');
    const b = await makeFarm('b');
    farmA = a.tenantId;
    parcelA = a.parcelId;
    farmB = b.tenantId;
    parcelB = b.parcelId;

    // One reading per farm, written through the real repository under the real
    // tenant context — not seeded privileged, or the INSERT policy is never
    // exercised by the fixture that everything else stands on.
    const ctxA = makeRequestContext('EDITOR', { tenantId: farmA, userId: 'u-a' });
    const ctxB = makeRequestContext('EDITOR', { tenantId: farmB, userId: 'u-b' });
    await runInTenantContext(ctxA, (db) =>
        ParcelRepository.storeIndexReadings(
            db,
            ctxA,
            parcelA,
            [{ acquiredOn: d('2026-10-20'), ndvi: 0.71, ndmi: 0.33 }],
            { from: d('2026-10-01'), through: d('2026-10-31'), algo: 1 },
        ),
    );
    await runInTenantContext(ctxB, (db) =>
        ParcelRepository.storeIndexReadings(
            db,
            ctxB,
            parcelB,
            [{ acquiredOn: d('2026-10-20'), ndvi: 0.22, ndmi: 0.11 }],
            { from: d('2026-10-01'), through: d('2026-10-31'), algo: 1 },
        ),
    );
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Every FK on the way down is ON DELETE CASCADE.
    await prisma.tenant.deleteMany({ where: { id: { in: [farmA, farmB] } } }).catch(() => {});
});

describeFn('ParcelIndexReading — the fixture itself', () => {
    it('the repository wrote both rows — the positive control for everything below', async () => {
        // Privileged read. If this is not 2, no later assertion means
        // anything: "no rows" and "the policy hid them" are the same
        // observation, and the write runs under RLS so it could have been
        // refused rather than merely invisible.
        const n = await prisma.parcelIndexReading.count({
            where: { tenantId: { in: [farmA, farmB] } },
        });
        expect(n).toBe(2);
    });

    it('stamped the coverage watermark on the parcel', async () => {
        const p = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelA },
            select: { indexReadingsFrom: true, indexReadingsThrough: true, indexReadingsAlgo: true },
        });
        expect(p.indexReadingsFrom?.toISOString().slice(0, 10)).toBe('2026-10-01');
        expect(p.indexReadingsThrough?.toISOString().slice(0, 10)).toBe('2026-10-31');
        expect(p.indexReadingsAlgo).toBe(1);
    });
});

describeFn('ParcelIndexReading is tenant-isolated', () => {
    it('a farm reads its OWN readings back through the repository', async () => {
        const ctxA = makeRequestContext('READER', { tenantId: farmA, userId: 'u-a' });
        const got = await runInTenantContext(ctxA, (db) =>
            ParcelRepository.storedIndexReadings(db, ctxA, parcelA, d('2026-01-01')),
        );
        expect(got).not.toBeNull();
        expect(got?.readings).toHaveLength(1);
        expect(got?.readings[0].ndvi).toBeCloseTo(0.71, 6);
        expect(got?.coveredAlgo).toBe(1);
    });

    it('and CANNOT see the other farm', async () => {
        const rows = await withTenantDb(farmA, (db) =>
            db.parcelIndexReading.findMany({ where: { tenantId: farmB }, select: { id: true } }),
        );
        expect(rows).toHaveLength(0);

        // As a COUNT too, so an empty list from a broken query cannot read as
        // isolation.
        const n = await withTenantDb(farmA, (db) =>
            db.parcelIndexReading.count({ where: { tenantId: farmB } }),
        );
        expect(n).toBe(0);
    });

    it('the repository read answers null for another farm’s parcel', async () => {
        // The route turns this into PARCEL_NOT_FOUND. Existence-hiding: farm A
        // asking about farm B's parcel must be indistinguishable from asking
        // about a parcel that does not exist.
        const ctxA = makeRequestContext('READER', { tenantId: farmA, userId: 'u-a' });
        const other = await runInTenantContext(ctxA, (db) =>
            ParcelRepository.storedIndexReadings(db, ctxA, parcelB, d('2026-01-01')),
        );
        const madeUp = await runInTenantContext(ctxA, (db) =>
            ParcelRepository.storedIndexReadings(db, ctxA, 'no-such-parcel', d('2026-01-01')),
        );
        expect(other).toBeNull();
        expect(madeUp).toBeNull();
    });

    it('a forged INSERT for another farm is REFUSED with 42501', async () => {
        await expect(
            withTenantDb(farmA, (db) =>
                db.parcelIndexReading.create({
                    data: { tenantId: farmB, parcelId: parcelB, acquiredOn: d('2026-10-21'), ndvi: 0.9 },
                    select: { id: true },
                }),
            ),
        ).rejects.toThrow(/42501|row-level security/i);

        // The raise is not the whole proof — it really did not land.
        const n = await prisma.parcelIndexReading.count({ where: { tenantId: farmB } });
        expect(n).toBe(1);
    });

    it('a DELETE aimed at another farm removes NOTHING, and returns normally', async () => {
        const deleted = await withTenantDb(farmA, (db) =>
            db.parcelIndexReading.deleteMany({ where: { tenantId: farmB } }),
        );
        expect(deleted.count).toBe(0);

        const survivors = await prisma.parcelIndexReading.count({ where: { tenantId: farmB } });
        expect(survivors).toBe(1);
    });
});

describeFn('storeIndexReadings — the upsert and the watermark', () => {
    const ctxA = () => makeRequestContext('EDITOR', { tenantId: farmA, userId: 'u-a' });

    it('REPLACES a stored day rather than appending a second reading', async () => {
        // The chart would draw two points at one x. Only the unique constraint
        // can refuse this, which is why it is tested here and not against a
        // double that returns its row whatever it was asked.
        const ctx = ctxA();
        await runInTenantContext(ctx, (db) =>
            ParcelRepository.storeIndexReadings(
                db,
                ctx,
                parcelA,
                [{ acquiredOn: d('2026-10-20'), ndvi: 0.55, ndmi: 0.25 }],
                null,
            ),
        );

        const rows = await prisma.parcelIndexReading.findMany({
            where: { tenantId: farmA, parcelId: parcelA, acquiredOn: d('2026-10-20') },
            select: { ndvi: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].ndvi).toBeCloseTo(0.55, 6);
    });

    it('stores a fully-masked pass with NULL indices', async () => {
        // A row with a null index records that a pass EXISTED and the parcel
        // was under cloud. Dropping it would make the backfill re-ask Earth
        // Engine about every cloudy day for ever.
        const ctx = ctxA();
        await runInTenantContext(ctx, (db) =>
            ParcelRepository.storeIndexReadings(
                db,
                ctx,
                parcelA,
                [{ acquiredOn: d('2026-10-22'), ndvi: null, ndmi: null }],
                null,
            ),
        );

        const row = await prisma.parcelIndexReading.findFirstOrThrow({
            where: { tenantId: farmA, parcelId: parcelA, acquiredOn: d('2026-10-22') },
            select: { ndvi: true, ndmi: true },
        });
        expect(row.ndvi).toBeNull();
        expect(row.ndmi).toBeNull();
    });

    it('widens the watermark in BOTH directions and never narrows it', async () => {
        // The raw LEAST/GREATEST. A reversed comparison here narrows coverage
        // on every request, and the symptom is an Earth Engine bill rather
        // than a failing test.
        const ctx = ctxA();
        const widen = (from: string, through: string) =>
            runInTenantContext(ctx, (db) =>
                ParcelRepository.storeIndexReadings(db, ctx, parcelA, [], {
                    from: d(from),
                    through: d(through),
                    algo: 1,
                }),
            );
        const read = async () => {
            const p = await prisma.parcel.findUniqueOrThrow({
                where: { id: parcelA },
                select: { indexReadingsFrom: true, indexReadingsThrough: true },
            });
            return [
                p.indexReadingsFrom?.toISOString().slice(0, 10),
                p.indexReadingsThrough?.toISOString().slice(0, 10),
            ];
        };

        // Reaching further back extends the FROM end only.
        await widen('2026-08-01', '2026-10-31');
        expect(await read()).toEqual(['2026-08-01', '2026-10-31']);

        // Reaching further forward extends the THROUGH end only.
        await widen('2026-10-01', '2026-11-07');
        expect(await read()).toEqual(['2026-08-01', '2026-11-07']);

        // A narrower window in the middle changes NOTHING — the union is
        // monotonic, so two concurrent requests for different windows cannot
        // shrink each other's coverage.
        await widen('2026-09-01', '2026-09-30');
        expect(await read()).toEqual(['2026-08-01', '2026-11-07']);
    });

    it('REPLACES the watermark when the algorithm version differs', async () => {
        // Unioning across versions would produce a window no single set of
        // rules ever covered — the precise failure the version exists to
        // prevent. So a different algo REPLACES rather than widens.
        const ctx = ctxA();
        await runInTenantContext(ctx, (db) =>
            ParcelRepository.storeIndexReadings(db, ctx, parcelA, [], {
                from: d('2026-10-05'),
                through: d('2026-10-09'),
                algo: 2,
            }),
        );

        const p = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelA },
            select: { indexReadingsFrom: true, indexReadingsThrough: true, indexReadingsAlgo: true },
        });
        expect(p.indexReadingsFrom?.toISOString().slice(0, 10)).toBe('2026-10-05');
        expect(p.indexReadingsThrough?.toISOString().slice(0, 10)).toBe('2026-10-09');
        expect(p.indexReadingsAlgo).toBe(2);
    });

    it('cannot widen another farm’s parcel under a tenant context — RLS hides the row', async () => {
        const before = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelB },
            select: { indexReadingsFrom: true },
        });
        const ctx = ctxA();
        await runInTenantContext(ctx, (db) =>
            ParcelRepository.storeIndexReadings(db, ctx, parcelB, [], {
                from: d('2020-01-01'),
                through: d('2026-11-07'),
                algo: 1,
            }),
        );

        // A no-op UPDATE under RLS returns normally, so the assertion has to
        // read the row rather than rely on the call not throwing.
        const after = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelB },
            select: { indexReadingsFrom: true },
        });
        expect(after.indexReadingsFrom?.toISOString()).toBe(before.indexReadingsFrom?.toISOString());
    });

    it('and the `tenantId` in the UPDATE’s own WHERE is what stops it PRIVILEGED', async () => {
        /*
         * The case above is held entirely by RLS: under farm A's session the
         * Parcel row is invisible, so the statement matches nothing however it
         * is written. Measured — removing `tenantId` from the UPDATE's WHERE
         * left all twelve tests green, which means the application-layer
         * filter was defence in depth that nothing exercised.
         *
         * So this runs the SAME repository call with the PRIVILEGED client,
         * which is the only context in which that clause is the control. It is
         * not how the usecase calls it; it is how the clause gets tested at
         * all, and this repository's convention is that every write carries
         * the tenant in its WHERE precisely so a privileged caller cannot
         * cross a farm by passing the wrong id.
         */
        const before = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelB },
            select: { indexReadingsFrom: true, indexReadingsAlgo: true },
        });
        const ctx = ctxA(); // farm A's context, farm B's parcel id
        await ParcelRepository.storeIndexReadings(prisma, ctx, parcelB, [], {
            from: d('2020-01-01'),
            through: d('2026-11-07'),
            algo: 99,
        });

        const after = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelB },
            select: { indexReadingsFrom: true, indexReadingsAlgo: true },
        });
        expect(after.indexReadingsFrom?.toISOString()).toBe(before.indexReadingsFrom?.toISOString());
        expect(after.indexReadingsAlgo).toBe(before.indexReadingsAlgo);
    });

    it('…and the privileged write DOES land on its own farm — the control', async () => {
        // Without this, the assertion above is satisfied by a call that
        // silently does nothing for any input.
        const ctx = ctxA();
        await ParcelRepository.storeIndexReadings(prisma, ctx, parcelA, [], {
            from: d('2019-01-01'),
            through: d('2026-11-07'),
            algo: 1,
        });

        const p = await prisma.parcel.findUniqueOrThrow({
            where: { id: parcelA },
            select: { indexReadingsFrom: true },
        });
        expect(p.indexReadingsFrom?.toISOString().slice(0, 10)).toBe('2019-01-01');
    });
});
