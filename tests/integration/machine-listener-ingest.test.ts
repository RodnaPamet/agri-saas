/**
 * The listener's two database effects, against the live database — #2948 §3.
 *
 * ## Why this is an integration test and not a mock
 *
 * Both properties here are properties of POSTGRES, not of our code. The
 * allowlist's `removedAt: null` only means something if the column behaves;
 * and the timestamp property is entirely about how a `timestamp without time
 * zone` round-trips. A mocked Prisma would return whatever the double was told
 * to, which is the `bullmq` lesson in CLAUDE.md: a test that mocks the thing
 * whose behaviour you depend on verifies your wiring and nothing about the
 * dependency.
 *
 * ## The reader trap this file exists to pin
 *
 * Measured while smoke-testing the real bundle: the listener stored
 * `2026-11-10 12:00:00` (correct UTC) and a RAW `pg` read printed
 * `10:00:00.000Z` — because node-pg applies the CLIENT's timezone to a naive
 * `timestamp` column, and the process was `Europe/Sofia`. It looked exactly
 * like a two-hour ingest bug. The subject was fine; the INSTRUMENT was wrong.
 *
 * A two-hour shift on a GPS track is invisible until somebody asks which day a
 * machine worked, and `?date=` is a Europe/Sofia calendar day resolved
 * server-side, so a shifted row lands on the wrong one. So the assertion here
 * is on the STORED TEXT, which is the only reading that is not itself
 * timezone-dependent.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { makeTrackerLookup, storePositions } from '@/lib/machines/ingest';
import type { Codec8Position } from '@/lib/machines/codec8';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** 2026-11-10T12:00:00.000Z — midday UTC, 14:00 in Sofia. */
const INSTANT_MS = 1_794_312_000_000;
const INSTANT_ISO = '2026-11-10T12:00:00.000Z';

function position(over: Partial<Codec8Position> = {}): Codec8Position {
    return {
        recordedAt: new Date(INSTANT_MS),
        priority: 1,
        lat: '42.6977000',
        lon: '23.3219000',
        altitudeM: 550,
        headingDeg: 180,
        satellites: 11,
        speedKph: 12,
        ignition: true,
        ...over,
    };
}

describeFn('#2948 — the listener ingest path', () => {
    const sfx = `li-${randomUUID().slice(0, 8)}`;
    const tenantId = `t-${sfx}`;
    const assetId = `a-${sfx}`;
    const userId = `u-${sfx}`;
    const liveImei = '356938035643801';
    const removedImei = '356938035643802';
    let liveTrackerId = '';

    beforeAll(async () => {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Tenant" ("id","name","slug","createdAt","updatedAt") VALUES ($1,$2,$3,now(),now())`,
            tenantId, `Farm ${sfx}`, `farm-${sfx}`,
        );
        await prisma.$executeRawUnsafe(
            `INSERT INTO "User" ("id","emailEncrypted","emailHash","createdAt","updatedAt") VALUES ($1,$2,$3,now(),now())`,
            userId, 'ciphertext', `hash-${sfx}`,
        );
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Asset" ("id","tenantId","name","type","createdAt","updatedAt") VALUES ($1,$2,$3,'TRACTOR',now(),now())`,
            assetId, tenantId, `Tractor ${sfx}`,
        );
        const live = await prisma.machineTracker.create({
            data: {
                tenantId, assetId, imei: liveImei,
                driversInformedAt: new Date(), driversInformedByUserId: userId,
            },
            select: { id: true },
        });
        liveTrackerId = live.id;
        // A REMOVED tracker for the same asset. The partial unique index
        // permits it precisely because `removedAt` is set, which is also what
        // makes this the allowlist's negative case.
        await prisma.machineTracker.create({
            data: {
                tenantId, assetId, imei: removedImei, removedAt: new Date(),
                driversInformedAt: new Date(), driversInformedByUserId: userId,
            },
        });
    }, 60_000);

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "MachinePosition" WHERE "tenantId" = $1`, tenantId);
        await prisma.$executeRawUnsafe(`DELETE FROM "MachineTracker" WHERE "tenantId" = $1`, tenantId);
        await prisma.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "id" = $1`, assetId);
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
        await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        await prisma.$disconnect();
    }, 60_000);

    describe('§1 the allowlist', () => {
        it('resolves a live IMEI to its tracker, asset and tenant', async () => {
            const found = await makeTrackerLookup(prisma)(liveImei);
            expect(found).toEqual({ trackerId: liveTrackerId, assetId, tenantId });
        });

        it('returns null for an IMEI nobody registered', async () => {
            expect(await makeTrackerLookup(prisma)('999999999999999')).toBeNull();
        });

        it('returns null for a REMOVED tracker — the clause that stops it failing open', async () => {
            // Without `removedAt: null` a decommissioned box keeps writing.
            // Paired with §1's positive above, so "null for everything" cannot
            // satisfy this.
            expect(await makeTrackerLookup(prisma)(removedImei)).toBeNull();
        });
    });

    describe('§2 the store', () => {
        it('writes the batch and reports the count', async () => {
            const n = await storePositions(
                prisma,
                { trackerId: liveTrackerId, assetId, tenantId },
                [position(), position({ recordedAt: new Date(INSTANT_MS + 30_000) })],
            );
            expect(n).toBe(2);
        });

        it('stores the instant as UTC — asserted on the STORED TEXT', async () => {
            // The whole point of this test. A raw `pg` read of this column
            // applies the CLIENT timezone, so reading it as a Date and
            // comparing ISO strings would be testing node-pg's locale. The
            // text cast is timezone-independent.
            const rows = await prisma.$queryRawUnsafe<{ stored: string }[]>(
                `SELECT "recordedAt"::text AS stored FROM "MachinePosition"
                  WHERE "tenantId" = $1 ORDER BY "recordedAt" LIMIT 1`,
                tenantId,
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].stored).toMatch(/^2026-11-10 12:00:00/);
        });

        it('round-trips through PRISMA to the same instant', async () => {
            // The other half: Prisma reads back what it wrote, whatever the
            // process timezone. If this and the text assertion ever disagree,
            // the reader is the thing that changed.
            const back = await prisma.machinePosition.findFirst({
                where: { tenantId },
                orderBy: { recordedAt: 'asc' },
                select: { recordedAt: true },
            });
            expect(back?.recordedAt.toISOString()).toBe(INSTANT_ISO);
        });

        it('keeps the coordinates EXACT through the Decimal column', async () => {
            // `toFixedDegrees` avoids binary floating point on the way in; this
            // asserts the column does not reintroduce it on the way out.
            const rows = await prisma.$queryRawUnsafe<{ lat: string; lon: string; speed: string }[]>(
                `SELECT lat::text AS lat, lon::text AS lon, "speedKph"::text AS speed
                   FROM "MachinePosition" WHERE "tenantId" = $1 LIMIT 1`,
                tenantId,
            );
            expect(rows[0].lat).toBe('42.6977000');
            expect(rows[0].lon).toBe('23.3219000');
            expect(rows[0].speed).toBe('12.0');
        });

        it('stores a null ignition as NULL, not false', async () => {
            await storePositions(
                prisma,
                { trackerId: liveTrackerId, assetId, tenantId },
                [position({ recordedAt: new Date(INSTANT_MS + 90_000), ignition: null })],
            );
            const row = await prisma.machinePosition.findFirst({
                where: { tenantId, recordedAt: new Date(INSTANT_MS + 90_000) },
                select: { ignition: true },
            });
            // `false` means the engine is off; NULL means nothing is wired.
            // Collapsing them claims every uninstrumented machine is idle.
            expect(row?.ignition).toBeNull();
        });

        it('writes nothing for an empty batch, and says 0', async () => {
            expect(await storePositions(prisma, { trackerId: liveTrackerId, assetId, tenantId }, [])).toBe(0);
        });
    });
});
