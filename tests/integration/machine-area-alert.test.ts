/**
 * #2948 stage 5 — the leaving-the-area alert, against real PostGIS.
 *
 * ## The two assertions this suite exists for
 *
 * **One push per EVENT.** The owner ruled one alert per departure rather than
 * one per interval while a machine is away, which means the second run over
 * an unchanged situation must send NOTHING. A suite that only proved "leaving
 * sends an alert" would pass just as happily against a job that notifies every
 * five minutes for as long as a tractor sits at a dealership — the behaviour
 * the ruling moved away from.
 *
 * **A farm with no parcels is skipped, not alerted.** `ST_Union` over zero
 * rows is NULL, and a `COALESCE(..., true)` written for tidiness turns "this
 * farm has no area" into "every machine has left" — one push per machine per
 * run, at the farm least equipped to understand why.
 *
 * ## Geometry in degrees, thresholds in metres
 *
 * The parcel sits at ~43.1°N / 26.6°E where a degree of longitude is about
 * 81 km. The "far" fixture is 0.05° east, roughly 4 km out, comfortably past
 * the 2 km buffer; the "near" one is inside the parcel. Both are written in
 * degrees because the column is SRID 4326, and every distance the job computes
 * goes through EPSG:32635 first — which is the bug this would otherwise hide.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

const mockEnqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));

// eslint-disable-next-line import/order
import { runMachineAreaAlert, AREA_BUFFER_M } from '@/app-layer/jobs/machine-area-alert';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT = `t-maa-${TAG}`;
/** A farm with machines and NO parcels drawn. */
const BARE_TENANT = `t-maa-bare-${TAG}`;
const OWNER = `u-maa-owner-${TAG}`;
const ADMIN = `u-maa-admin-${TAG}`;
const EDITOR = `u-maa-editor-${TAG}`;
const MECHANISATOR = `u-maa-mech-${TAG}`;

const LON0 = 26.6;
const LAT0 = 43.1;
const SPAN = 0.01;
/** Inside the parcel. */
const INSIDE = { lat: LAT0 + SPAN / 2, lon: LON0 + SPAN / 2 };
/** ~4 km east of the parcel's edge — past the 2 km buffer. */
const FAR = { lat: LAT0 + SPAN / 2, lon: LON0 + 0.06 };

let assetId = '';
let bareAssetId = '';
const NOW = '2026-11-13T10:00:00.000Z';

async function fix(asset: string, tenant: string, at: Date, p: { lat: number; lon: number }) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "MachinePosition"
           ("id","tenantId","assetId","recordedAt","lat","lon","speedKph","ignition","source","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,10,true,'TRACKER',NOW())`,
        randomUUID(), tenant, asset, at, p.lat, p.lon,
    );
}

const minutesBefore = (m: number) => new Date(new Date(NOW).getTime() - m * 60_000);

async function clearRuntime() {
    for (const t of [TENANT, BARE_TENANT]) {
        await prisma.$executeRawUnsafe(`DELETE FROM "MachinePosition" WHERE "tenantId" = $1`, t);
        await prisma.machineAreaState.deleteMany({ where: { tenantId: t } });
    }
    mockEnqueue.mockClear();
}

describeFn('#2948 stage 5 — the leaving-the-area alert', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.createMany({
            data: [
                { id: TENANT, name: 'ЗК Хоризонт', slug: TENANT },
                { id: BARE_TENANT, name: 'ЗК Без карта', slug: BARE_TENANT },
            ],
        });
        for (const [id, role] of [
            [OWNER, 'OWNER'], [ADMIN, 'ADMIN'],
            [EDITOR, 'EDITOR'], [MECHANISATOR, 'MECHANISATOR'],
        ] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({
                data: { id, email, emailHash: hashForLookup(email), uiLanguage: 'bg' },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }
        const a = await prisma.asset.create({
            data: { tenantId: TENANT, name: 'Трактор 3', type: 'VEHICLE' },
            select: { id: true },
        });
        assetId = a.id;
        const b = await prisma.asset.create({
            data: { tenantId: BARE_TENANT, name: 'Комбайн 1', type: 'VEHICLE' },
            select: { id: true },
        });
        bareAssetId = b.id;

        const loc = await prisma.location.create({
            data: { tenantId: TENANT, name: `Блок ${TAG}` },
            select: { id: true },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Parcel" ("id","tenantId","locationId","name","areaHa","geometry","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5, ST_Multi(ST_SetSRID(ST_GeomFromText($6), 4326)), NOW(), NOW())`,
            randomUUID(), TENANT, loc.id, `Парцел ${TAG}`, 80,
            `POLYGON((${LON0} ${LAT0}, ${LON0 + SPAN} ${LAT0}, ${LON0 + SPAN} ${LAT0 + SPAN}, ${LON0} ${LAT0 + SPAN}, ${LON0} ${LAT0}))`,
        );
    });

    afterAll(async () => {
        await clearRuntime();
        await prisma.$executeRawUnsafe(`DELETE FROM "Parcel" WHERE "tenantId" = $1`, TENANT);
        await prisma.asset.deleteMany({ where: { tenantId: { in: [TENANT, BARE_TENANT] } } });
        await prisma.location.deleteMany({ where: { tenantId: TENANT } });
        /*
         * The MEMBERSHIPS, USERS and TENANTS all stay, and chasing them was a
         * real failure rather than laziness: deleting them raised
         * `P0001 LAST_OWNER_GUARD: tenant … would have zero active OWNERs` —
         * the database trigger CLAUDE.md describes, which exists so a tenant
         * cannot be left ownerless, and which a test tidying up has no
         * business defeating.
         *
         * `apns-environment-write` records the same conclusion after three
         * attempts at its own leftovers, and the audit chain's rows carry no
         * cascade either. Every identifier here is TAG-scoped to one run, so
         * the leftovers collide with nothing and accumulate under no name
         * another suite reads.
         */
        await prisma.$disconnect();
    });

    beforeEach(clearRuntime);

    const pushes = () =>
        mockEnqueue.mock.calls
            .filter((c) => c[0] === 'push-send')
            .map((c) => c[1] as Record<string, unknown>);

    it('a machine INSIDE the area raises nothing, and records that it is inside', async () => {
        await fix(assetId, TENANT, minutesBefore(2), INSIDE);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ evaluated: 1, departures: 0, pushesEnqueued: 0 });
        expect(pushes()).toHaveLength(0);
        const st = await prisma.machineAreaState.findUniqueOrThrow({
            where: { assetId }, select: { outside: true, alertedAt: true },
        });
        expect(st.outside).toBe(false);
        expect(st.alertedAt).toBeNull();
    }, 60_000);

    it('a machine OUTSIDE raises one push per OWNER and ADMIN — and nobody else', async () => {
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 1 });
        const sent = pushes();
        // OWNER + ADMIN only. EDITOR is not an audience and MECHANISATOR is
        // the SUBJECT — §7's reason, kept verbatim in the job.
        expect(sent.map((p) => p.recipientUserId).sort()).toEqual([ADMIN, OWNER].sort());
        expect(sent.map((p) => p.recipientUserId)).not.toContain(EDITOR);
        expect(sent.map((p) => p.recipientUserId)).not.toContain(MECHANISATOR);
        // The link is root-relative and tenant-prefixed — #2932 is what a
        // bare path cost.
        expect(sent[0].link).toBe(`/t/${TENANT}/machines/${assetId}`);
        expect(sent[0].collapseKey).toBe(`machine-area-${assetId}`);
        // The machine's name reaches the body, in Bulgarian.
        expect(String(sent[0].body)).toContain('Трактор 3');
    }, 60_000);

    it('STAYING outside sends nothing on the next run — one push per EVENT', async () => {
        await fix(assetId, TENANT, minutesBefore(10), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(pushes()).toHaveLength(2);

        // A newer fix, still outside: the situation has not changed, so a
        // second notification would be the per-interval behaviour the ruling
        // rejected.
        mockEnqueue.mockClear();
        await fix(assetId, TENANT, minutesBefore(1), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 0, pushesEnqueued: 0 });
        expect(pushes()).toHaveLength(0);
    }, 60_000);

    it('RETURNING is silent, and flips the stored verdict', async () => {
        await fix(assetId, TENANT, minutesBefore(10), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        mockEnqueue.mockClear();

        await fix(assetId, TENANT, minutesBefore(1), INSIDE);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        // A farm is told when a machine leaves, not when it comes back: the
        // second is not a risk, and the first loses force in a pair.
        expect(pushes()).toHaveLength(0);
        const st = await prisma.machineAreaState.findUniqueOrThrow({
            where: { assetId }, select: { outside: true },
        });
        expect(st.outside).toBe(false);
    }, 60_000);

    it('leaving AGAIN after a return is a NEW event, and alerts', async () => {
        // The control for "staying outside is silent": that silence must come
        // from the verdict being unchanged, not from a machine being alerted
        // at most once ever.
        await fix(assetId, TENANT, minutesBefore(20), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        await fix(assetId, TENANT, minutesBefore(10), INSIDE);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        mockEnqueue.mockClear();

        await fix(assetId, TENANT, minutesBefore(1), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 1 });
        expect(pushes()).toHaveLength(2);
    }, 60_000);

    it('a farm with NO parcels is SKIPPED, never alerted', async () => {
        // The loudest possible failure if it were wrong: one push per machine
        // per run, at the farm least able to explain it.
        await fix(bareAssetId, BARE_TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: BARE_TENANT, now: NOW });

        expect(result.details).toMatchObject({
            skippedNoArea: 1, evaluated: 0, departures: 0, pushesEnqueued: 0,
        });
        expect(pushes()).toHaveLength(0);
        // And no verdict is stored — "no area" is not "inside".
        expect(await prisma.machineAreaState.count({ where: { tenantId: BARE_TENANT } })).toBe(0);
    }, 60_000);

    it('a STALE fix is not a verdict', async () => {
        // A machine switched off in a shed last week must not keep producing
        // verdicts from its final fix.
        await fix(assetId, TENANT, minutesBefore(120), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.itemsScanned).toBe(0);
        expect(pushes()).toHaveLength(0);
        expect(await prisma.machineAreaState.count({ where: { tenantId: TENANT } })).toBe(0);
    }, 60_000);

    it('the SAME fix re-evaluated sends nothing — idempotence', async () => {
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(pushes()).toHaveLength(2);

        mockEnqueue.mockClear();
        // No new fix: a job that wakes twice before the tracker reports again.
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(result.details).toMatchObject({ departures: 0 });
        expect(pushes()).toHaveLength(0);
    }, 60_000);

    it("a machine ALREADY outside at its first verdict counts as a departure", async () => {
        /*
         * Deliberate: a farm fitting a tracker to a machine that is away wants
         * to know it is away. Treating an absent prior row as "inside" would
         * stay silent on exactly the case somebody fitted the tracker to find.
         */
        expect(await prisma.machineAreaState.count({ where: { assetId } })).toBe(0);
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(result.details).toMatchObject({ departures: 1 });
    }, 60_000);

    it('the buffer is TWO KILOMETRES, in metres', async () => {
        // A fix ~1 km out: outside the parcel, inside the buffer, so not a
        // departure. This is the assertion that fails if the buffer is ever
        // applied in degrees — 2000 degrees contains the planet, and every
        // machine would read as inside for ever.
        expect(AREA_BUFFER_M).toBe(2_000);
        await fix(assetId, TENANT, minutesBefore(2), { lat: LAT0 + SPAN / 2, lon: LON0 + SPAN + 0.012 });
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ evaluated: 1, departures: 0 });
        const st = await prisma.machineAreaState.findUniqueOrThrow({
            where: { assetId }, select: { outside: true },
        });
        expect(st.outside).toBe(false);
    }, 60_000);
});
