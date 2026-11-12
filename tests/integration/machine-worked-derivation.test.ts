/**
 * #2948 stage 4 and #2984 — the nightly worked-parcel derivation.
 *
 * Executed against a real PostGIS database, because the whole thing IS the
 * geometry: a test with a mocked Prisma would assert that the job called
 * `$queryRawUnsafe` and nothing about whether a tractor driving across a field
 * produces a row.
 *
 * ## The assertion this suite exists for is the EMPTY one
 *
 * «a machine that worked nothing still gets a marker». Everything else here —
 * minutes, thresholds, confidence — is about rows the old code could already
 * have produced. The reason #2984 was filed is that "the derivation ran and
 * found nothing" had nowhere to live, so an idle machine was indistinguishable
 * from an unprocessed one and the phone said «изчисляват се през нощта» for
 * ever. That case is asserted twice: once on the marker row, and once through
 * `readMachineWorked`, which is where a farm actually sees it.
 *
 * ## Geometry is in metres only after the transform
 *
 * The parcel sits at ~43.1°N / 26.6°E, where a degree of longitude is about
 * 81 km and a degree of latitude about 111 km. The fixtures below are written
 * in degrees because `Parcel.geometry` is SRID 4326; every distance the job
 * computes goes through EPSG:32635 first, which is the bug this would
 * otherwise hide — in degrees a 20 m inward buffer is 0.00018°, and a
 * threshold applied in the wrong unit still produces plausible-looking rows.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    deriveAssetDay, sofiaYesterday, DERIVED_FROM,
} from '@/app-layer/jobs/worked-parcel-derivation';
import { readMachineWorked } from '@/app-layer/usecases/machines';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT = `t-wpd-${TAG}`;
const USER = `u-wpd-${TAG}`;
const DATE = '2026-11-10';

/** The parcel's south-west corner. A ~0.01° × 0.01° box, roughly 800 m × 1.1 km. */
const LON0 = 26.6;
const LAT0 = 43.1;
const SPAN = 0.01;

let assetId = '';
let parcelId = '';
let locationId = '';

function ctxFor(): RequestContext {
    return {
        requestId: `req-${randomUUID()}`,
        userId: USER,
        tenantId: TENANT,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/**
 * Positions along a line, one per minute.
 *
 * `speedKph` and `ignition` are per-call so each threshold can be exercised
 * without rewriting the walk. The track runs west→east across the parcel at a
 * chosen latitude offset, so a central pass and a boundary-hugging pass differ
 * only in that offset.
 */
async function walk(opts: {
    minutes: number;
    speedKph: number;
    ignition: boolean | null;
    latOffset: number;
    startMinute?: number;
    lonFrom?: number;
    lonTo?: number;
    /** NOT NULL on the table, and the matcher filters on it. */
    source?: 'TRACKER' | 'TELEMATICS' | 'SIMULATED';
}) {
    const rows = [];
    const from = opts.lonFrom ?? LON0 + 0.001;
    const to = opts.lonTo ?? LON0 + SPAN - 0.001;
    for (let i = 0; i < opts.minutes; i++) {
        const frac = opts.minutes === 1 ? 0 : i / (opts.minutes - 1);
        rows.push({
            id: randomUUID(),
            tenantId: TENANT,
            assetId,
            // 09:00 Sofia on DATE, plus i minutes. Written as +02:00 so the
            // instant lands inside the Sofia day the job derives.
            recordedAt: new Date(
                `${DATE}T09:00:00+02:00`,
            ).getTime() + ((opts.startMinute ?? 0) + i) * 60_000,
            lat: LAT0 + opts.latOffset,
            lon: from + (to - from) * frac,
            speedKph: opts.speedKph,
            ignition: opts.ignition,
        });
    }
    for (const r of rows) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "MachinePosition"
               ("id","tenantId","assetId","recordedAt","lat","lon","speedKph","ignition","source","createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::"MachinePositionSource",NOW())`,
            r.id, r.tenantId, r.assetId, new Date(r.recordedAt),
            r.lat, r.lon, r.speedKph, r.ignition, opts.source ?? 'TRACKER',
        );
    }
}

async function clearPositions() {
    await prisma.$executeRawUnsafe(`DELETE FROM "MachinePosition" WHERE "tenantId" = $1`, TENANT);
    await prisma.$executeRawUnsafe(`DELETE FROM "WorkedParcel" WHERE "tenantId" = $1`, TENANT);
    await prisma.$executeRawUnsafe(`DELETE FROM "MachineWorkedDay" WHERE "tenantId" = $1`, TENANT);
}

describeFn('#2948 stage 4 — worked-parcel derivation', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: 'Фикс ЕООД', slug: TENANT } });
        const loc = await prisma.location.create({
            data: { tenantId: TENANT, name: `Блок ${TAG}` },
            select: { id: true },
        });
        locationId = loc.id;
        const asset = await prisma.asset.create({
            data: { tenantId: TENANT, name: `Трактор ${TAG}`, type: 'VEHICLE' },
            select: { id: true },
        });
        assetId = asset.id;

        parcelId = randomUUID();
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Parcel" ("id","tenantId","locationId","name","areaHa","geometry","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5, ST_Multi(ST_SetSRID(ST_GeomFromText($6), 4326)), NOW(), NOW())`,
            parcelId, TENANT, locationId, `Парцел ${TAG}`, 80,
            `POLYGON((${LON0} ${LAT0}, ${LON0 + SPAN} ${LAT0}, ${LON0 + SPAN} ${LAT0 + SPAN}, ${LON0} ${LAT0 + SPAN}, ${LON0} ${LAT0}))`,
        );
    });

    afterAll(async () => {
        await clearPositions();
        await prisma.$executeRawUnsafe(`DELETE FROM "Parcel" WHERE "tenantId" = $1`, TENANT);
        await prisma.asset.deleteMany({ where: { tenantId: TENANT } });
        await prisma.location.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    beforeEach(clearPositions);

    it('a machine working across a parcel produces a row with minutes', async () => {
        await walk({ minutes: 20, speedKph: 8, ignition: true, latOffset: SPAN / 2 });
        const out = await deriveAssetDay(TENANT, assetId, DATE);

        expect(out).toEqual({ parcels: 1, positions: 20 });
        const rows = await prisma.workedParcel.findMany({
            where: { tenantId: TENANT, assetId },
            select: { parcelId: true, minutesWorked: true, areaHa: true, confidence: true, derivedFrom: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].parcelId).toBe(parcelId);
        // 20 one-minute samples span 19 minutes, not 20: the span is between
        // the first and last fix, which is what was observed.
        expect(rows[0].minutesWorked).toBe(19);
        expect(rows[0].derivedFrom).toBe(DERIVED_FROM);
        // Area is deliberately NOT derived — there is no implement width to
        // multiply the track by, and a guessed area is a number somebody puts
        // in a subsidy return.
        expect(rows[0].areaHa).toBeNull();
    }, 60_000);

    it('a machine that worked NOTHING still gets a marker — #2984', async () => {
        // Inside the parcel but at transport speed: positions exist, so the
        // run is real and the day was processed, and nothing is work.
        await walk({ minutes: 20, speedKph: 30, ignition: true, latOffset: SPAN / 2 });
        const out = await deriveAssetDay(TENANT, assetId, DATE);

        expect(out).toEqual({ parcels: 0, positions: 20 });
        expect(await prisma.workedParcel.count({ where: { tenantId: TENANT } })).toBe(0);

        const marker = await prisma.machineWorkedDay.findFirst({
            where: { tenantId: TENANT, assetId },
            select: { parcelsMatched: true, positionsConsidered: true, derivedFrom: true },
        });
        // THE POINT OF #2984. Without this row the read below cannot tell an
        // idle machine from an unprocessed day.
        expect(marker).not.toBeNull();
        expect(marker!.parcelsMatched).toBe(0);
        // And it says the tracker DID report, which is what separates "the
        // machine idled" from "nothing usable arrived".
        expect(marker!.positionsConsidered).toBe(20);
        expect(marker!.derivedFrom).toBe(DERIVED_FROM);
    }, 60_000);

    it('the READ then reports a timestamp with an empty list, not null', async () => {
        await walk({ minutes: 20, speedKph: 30, ignition: true, latOffset: SPAN / 2 });
        await deriveAssetDay(TENANT, assetId, DATE);

        const view = await readMachineWorked(ctxFor(), assetId, DATE);
        expect(view.parcels).toEqual([]);
        // The middle row of #2984's table, which was inexpressible before.
        expect(view.derivedAt).not.toBeNull();
    }, 60_000);

    it('an UNPROCESSED day still reports null, so the two stay distinguishable', async () => {
        // The control for the test above: if `derivedAt` were non-null here,
        // the previous assertion would be satisfied by a constant.
        const view = await readMachineWorked(ctxFor(), assetId, DATE);
        expect(view.parcels).toEqual([]);
        expect(view.derivedAt).toBeNull();
    }, 60_000);

    it('ignition OFF is not work', async () => {
        await walk({ minutes: 20, speedKph: 8, ignition: false, latOffset: SPAN / 2 });
        expect(await deriveAssetDay(TENANT, assetId, DATE)).toMatchObject({ parcels: 0 });
    }, 60_000);

    it('an UNREPORTED ignition is not treated as off', async () => {
        // `COALESCE(ignition, TRUE)`: a tracker that never sends the field
        // must not have its whole day discarded. Asserted because the obvious
        // `ignition = TRUE` would silently exclude such a fleet entirely.
        await walk({ minutes: 20, speedKph: 8, ignition: null, latOffset: SPAN / 2 });
        expect(await deriveAssetDay(TENANT, assetId, DATE)).toMatchObject({ parcels: 1 });
    }, 60_000);

    it('idling below 2 km/h is not work', async () => {
        await walk({ minutes: 20, speedKph: 1, ignition: true, latOffset: SPAN / 2 });
        expect(await deriveAssetDay(TENANT, assetId, DATE)).toMatchObject({ parcels: 0 });
    }, 60_000);

    it('a pass shorter than five minutes is not work', async () => {
        // A road clipping the corner of a field. Three samples span two
        // minutes, under the floor.
        await walk({ minutes: 3, speedKph: 8, ignition: true, latOffset: SPAN / 2 });
        expect(await deriveAssetDay(TENANT, assetId, DATE)).toMatchObject({ parcels: 0 });
    }, 60_000);

    it('a long gap splits the day into runs, and the gap is not credited', async () => {
        // Two 10-minute passes 40 minutes apart. Crediting the span between
        // the first and last fix would report ~59 minutes of work for 18.
        await walk({ minutes: 10, speedKph: 8, ignition: true, latOffset: SPAN / 2 });
        await walk({ minutes: 10, speedKph: 8, ignition: true, latOffset: SPAN / 2, startMinute: 50 });
        await deriveAssetDay(TENANT, assetId, DATE);

        const row = await prisma.workedParcel.findFirstOrThrow({
            where: { tenantId: TENANT, assetId },
            select: { minutesWorked: true },
        });
        expect(row.minutesWorked).toBe(18);
    }, 60_000);

    it('a boundary-hugging track scores LOWER confidence than a central one', async () => {
        // The signal `confidence` carries: a road along the field edge
        // intersects the parcel and is mostly outside the inward buffer.
        await walk({ minutes: 20, speedKph: 8, ignition: true, latOffset: SPAN / 2 });
        await deriveAssetDay(TENANT, assetId, DATE);
        const central = await prisma.workedParcel.findFirstOrThrow({
            where: { tenantId: TENANT, assetId }, select: { confidence: true },
        });

        await clearPositions();
        // ~0.00005° north of the southern edge: about 5 m, inside the parcel
        // and inside the 20 m buffer zone that is excluded.
        await walk({ minutes: 20, speedKph: 8, ignition: true, latOffset: 0.00005 });
        await deriveAssetDay(TENANT, assetId, DATE);
        const edge = await prisma.workedParcel.findFirstOrThrow({
            where: { tenantId: TENANT, assetId }, select: { confidence: true },
        });

        expect(Number(central.confidence)).toBeGreaterThan(Number(edge.confidence));
        expect(Number(central.confidence)).toBeCloseTo(1, 1);
        expect(Number(edge.confidence)).toBeCloseTo(0, 1);
    }, 60_000);

    it('a RE-RUN updates rather than double-counting, on both tables', async () => {
        await walk({ minutes: 20, speedKph: 8, ignition: true, latOffset: SPAN / 2 });
        await deriveAssetDay(TENANT, assetId, DATE);
        const first = await prisma.machineWorkedDay.findFirstOrThrow({
            where: { tenantId: TENANT, assetId }, select: { derivedAt: true },
        });

        await deriveAssetDay(TENANT, assetId, DATE);

        expect(await prisma.workedParcel.count({ where: { tenantId: TENANT } })).toBe(1);
        expect(await prisma.machineWorkedDay.count({ where: { tenantId: TENANT } })).toBe(1);
        const row = await prisma.workedParcel.findFirstOrThrow({
            where: { tenantId: TENANT }, select: { minutesWorked: true },
        });
        // Idempotence is the UNIQUE INDEX, not a flag the job sets: minutes are
        // replaced, never added to.
        expect(row.minutesWorked).toBe(19);
        const second = await prisma.machineWorkedDay.findFirstOrThrow({
            where: { tenantId: TENANT, assetId }, select: { derivedAt: true },
        });
        expect(second.derivedAt.getTime()).toBeGreaterThanOrEqual(first.derivedAt.getTime());
    }, 60_000);

    it('positions on a DIFFERENT Sofia day are not credited to this one', async () => {
        // The day boundary is computed in Europe/Sofia. A fix at 23:30 Sofia
        // on the 10th belongs to the 10th; the same instant is 21:30 UTC, so a
        // UTC boundary would agree here — the case that separates them is the
        // one below, at 00:30 Sofia on the 11th, which is 22:30 UTC on the
        // 10th and would be mis-credited by a UTC day.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "MachinePosition"
               ("id","tenantId","assetId","recordedAt","lat","lon","speedKph","ignition","source","createdAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'TRACKER',NOW())`,
            randomUUID(), TENANT, assetId, new Date(`${DATE}T22:30:00Z`),
            LAT0 + SPAN / 2, LON0 + 0.005, 8, true,
        );
        const out = await deriveAssetDay(TENANT, assetId, DATE);
        // 22:30 UTC on the 10th is 00:30 Sofia on the 11th — the NEXT day.
        expect(out.positions).toBe(0);
    }, 60_000);

    it('SIMULATED positions are never derived — the owner\'s rule', async () => {
        /*
         * «The thing that must never happen is simulated work reaching a real
         * farm's ДНЕВНИК, even as a «Нов запис» draft» — the enum's own
         * docblock. A `WorkedParcel` row is what fills that draft and carries
         * no provenance, so the filter is the only thing between a farm that
         * once tried the simulator and a register offering to file a
         * simulated afternoon.
         */
        await walk({
            minutes: 20, speedKph: 8, ignition: true,
            latOffset: SPAN / 2, source: 'SIMULATED',
        });
        const out = await deriveAssetDay(TENANT, assetId, DATE);
        expect(out).toEqual({ parcels: 0, positions: 0 });
        expect(await prisma.workedParcel.count({ where: { tenantId: TENANT } })).toBe(0);
    }, 60_000);

    it('a REAL day beside a simulated one derives only the real work', async () => {
        // The control: the filter must exclude the simulated rows rather than
        // the whole day, which is what a tenant-level or asset-level switch
        // would do — and is why the owner put the marker on the POSITION.
        await walk({ minutes: 20, speedKph: 8, ignition: true, latOffset: SPAN / 2 });
        await walk({
            minutes: 20, speedKph: 8, ignition: true, latOffset: SPAN / 2,
            startMinute: 120, source: 'SIMULATED',
        });
        const out = await deriveAssetDay(TENANT, assetId, DATE);
        expect(out).toEqual({ parcels: 1, positions: 20 });
        const row = await prisma.workedParcel.findFirstOrThrow({
            where: { tenantId: TENANT }, select: { minutesWorked: true },
        });
        // 19, not 139: the simulated pass two hours later contributes nothing.
        expect(row.minutesWorked).toBe(19);
    }, 60_000);

    it('sofiaYesterday returns the day before, in Sofia', () => {
        // 00:30 Sofia on the 12th is 22:30 UTC on the 11th, so "yesterday" is
        // the 11th — a UTC-based implementation would answer the 10th.
        expect(sofiaYesterday(new Date('2026-11-11T22:30:00Z'))).toBe('2026-11-11');
        expect(sofiaYesterday(new Date('2026-11-12T12:00:00Z'))).toBe('2026-11-11');
    });
});
