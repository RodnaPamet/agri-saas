/**
 * #3012 — the raw-position retention sweep.
 *
 * ## The assertion that matters most is the one about AGREEMENT
 *
 * `/track` decides what it will serve with `isDayRetained`, and this job
 * decides what to delete with `sweepCutoff`. If those two windows ever
 * disagree, the endpoint either claims a day it has deleted — an empty track
 * reading as "the machine sat idle" — or disclaims a day it still holds. The
 * constant's own docblock predicted the hazard before the sweep existed, so
 * the first test here compares the two across a range of ages rather than
 * trusting one arithmetic to match another.
 *
 * ## And the second is that an UNARMED run deletes nothing
 *
 * Deploying this job is what schedules its first run, so the default decides
 * whether merging a PR destroys production data. A test that only exercised
 * the armed path would pass just as happily if the default were `delete`.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    runMachinePositionSweep, sweepCutoff, sweepArmed, SWEEP_ARMED_VALUE,
} from '@/app-layer/jobs/machine-position-sweep';
import { isDayRetained, RAW_POSITION_RETENTION_DAYS } from '@/lib/machines/fleet-view';
import { farmDayRange } from '@/lib/calendar-day-key';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT = `t-mps-${TAG}`;
const TODAY = '2026-11-13';

let assetId = '';

/** A position on a given farm day, at noon so no boundary is in play. */
async function positionOn(dayKey: string) {
    const { start } = farmDayRange(dayKey);
    const at = new Date(start.getTime() + 12 * 3600_000);
    await prisma.$executeRawUnsafe(
        `INSERT INTO "MachinePosition"
           ("id","tenantId","assetId","recordedAt","lat","lon","speedKph","ignition","source","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'TRACKER',NOW())`,
        randomUUID(), TENANT, assetId, at, 43.1, 26.6, 8, true,
    );
    return at;
}

function dayAgo(days: number, from = TODAY): string {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}

describeFn('#3012 — the raw-position retention sweep', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: TENANT, name: 'Хронос ООД', slug: TENANT } });
        const a = await prisma.asset.create({
            data: { tenantId: TENANT, name: `Трактор ${TAG}`, type: 'VEHICLE' },
            select: { id: true },
        });
        assetId = a.id;
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "MachinePosition" WHERE "tenantId" = $1`, TENANT);
        await prisma.machineWorkedDay.deleteMany({ where: { tenantId: TENANT } });
        await prisma.asset.deleteMany({ where: { tenantId: TENANT } });
        // The tenant stays: the app client's audit extension writes rows that
        // carry no cascade, and deleting them fights an append-only design.
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "MachinePosition" WHERE "tenantId" = $1`, TENANT);
        await prisma.machineWorkedDay.deleteMany({ where: { tenantId: TENANT } });
        delete process.env.MACHINE_POSITION_SWEEP;
    });

    it('the sweep window and /track\'s window are exact COMPLEMENTS', () => {
        /*
         * One definition, two consumers. Every day either serves from `/track`
         * or is swept, never both and never neither — checked across a range
         * that straddles the boundary rather than at the boundary alone,
         * because an off-by-one shows up on one side only.
         */
        const cutoff = sweepCutoff(TODAY);
        for (let age = 0; age <= RAW_POSITION_RETENTION_DAYS + 5; age++) {
            const day = dayAgo(age);
            const retained = isDayRetained(day, TODAY);
            // A day is swept when its LAST instant is before the cutoff.
            const swept = farmDayRange(day).end <= cutoff;
            expect(swept).toBe(!retained);
        }
        // Positive control: both states actually occur in that range, or the
        // loop above would be asserting a constant against a constant.
        expect(isDayRetained(dayAgo(0), TODAY)).toBe(true);
        expect(isDayRetained(dayAgo(RAW_POSITION_RETENTION_DAYS + 1), TODAY)).toBe(false);
    });

    it('the boundary day itself is KEPT, not swept', () => {
        // `isDayRetained` is `<=`, so a day exactly at the window is still
        // served. An off-by-one here deletes a day the endpoint promises.
        const edge = dayAgo(RAW_POSITION_RETENTION_DAYS);
        expect(isDayRetained(edge, TODAY)).toBe(true);
        expect(farmDayRange(edge).start.getTime()).toBe(sweepCutoff(TODAY).getTime());
    });

    it('an UNARMED run deletes NOTHING and says so', async () => {
        await positionOn(dayAgo(RAW_POSITION_RETENTION_DAYS + 10));
        expect(sweepArmed()).toBe(false);

        const { result } = await runMachinePositionSweep({ today: TODAY });

        expect(result.itemsScanned).toBe(1);
        expect(result.itemsActioned).toBe(0);
        expect(result.details).toMatchObject({ mode: 'dry-run', expired: 1, deleted: 0 });
        // The row is still there — the assertion the default exists for.
        expect(await prisma.machinePosition.count({ where: { tenantId: TENANT } })).toBe(1);
    }, 60_000);

    it('a typo does not arm it', async () => {
        await positionOn(dayAgo(RAW_POSITION_RETENTION_DAYS + 10));
        process.env.MACHINE_POSITION_SWEEP = 'DELETE';  // wrong case
        expect(sweepArmed()).toBe(false);
        const { result } = await runMachinePositionSweep({ today: TODAY });
        expect(result.details).toMatchObject({ mode: 'dry-run', deleted: 0 });
        expect(await prisma.machinePosition.count({ where: { tenantId: TENANT } })).toBe(1);
    }, 60_000);

    it('an ARMED run deletes expired rows and keeps the retained ones', async () => {
        const expiredAt = await positionOn(dayAgo(RAW_POSITION_RETENTION_DAYS + 3));
        await positionOn(dayAgo(RAW_POSITION_RETENTION_DAYS));   // the edge: kept
        await positionOn(dayAgo(1));                              // yesterday: kept
        process.env.MACHINE_POSITION_SWEEP = SWEEP_ARMED_VALUE;

        const { result } = await runMachinePositionSweep({ today: TODAY });

        expect(result.details).toMatchObject({ mode: 'delete', expired: 1, deleted: 1 });
        const left = await prisma.machinePosition.findMany({
            where: { tenantId: TENANT },
            select: { recordedAt: true },
        });
        expect(left).toHaveLength(2);
        // The control: it deleted the RIGHT row, not simply one row.
        expect(left.map((r) => r.recordedAt.getTime())).not.toContain(expiredAt.getTime());
    }, 60_000);

    it('reports the days it deleted WITHOUT a derivation marker', async () => {
        // The loss this job accepts: a day the derivation never processed
        // cannot be reconstructed once its positions are gone, so the count
        // is surfaced rather than absorbed.
        await positionOn(dayAgo(RAW_POSITION_RETENTION_DAYS + 4));
        process.env.MACHINE_POSITION_SWEEP = SWEEP_ARMED_VALUE;

        const { result } = await runMachinePositionSweep({ today: TODAY });
        expect(result.details).toMatchObject({ deleted: 1, daysWithoutMarker: 1 });
    }, 60_000);

    it('a day WITH a marker is not counted as an unreported loss', async () => {
        // The control for the test above — otherwise `daysWithoutMarker` could
        // be a constant and nobody would notice.
        const day = dayAgo(RAW_POSITION_RETENTION_DAYS + 4);
        await positionOn(day);
        await prisma.machineWorkedDay.create({
            data: {
                tenantId: TENANT,
                assetId,
                date: new Date(`${day}T00:00:00Z`),
                derivedFrom: 'v1:test',
                positionsConsidered: 1,
                parcelsMatched: 0,
            },
        });
        process.env.MACHINE_POSITION_SWEEP = SWEEP_ARMED_VALUE;

        const { result } = await runMachinePositionSweep({ today: TODAY });
        expect(result.details).toMatchObject({ deleted: 1, daysWithoutMarker: 0 });
    }, 60_000);

    it('a bounded run leaves the remainder for the next night', async () => {
        for (const age of [40, 41, 42]) await positionOn(dayAgo(age));
        process.env.MACHINE_POSITION_SWEEP = SWEEP_ARMED_VALUE;

        const { result } = await runMachinePositionSweep({ today: TODAY, limit: 2 });

        expect(result.details).toMatchObject({ expired: 3, deleted: 2, remaining: 1 });
        // `remaining` is NOT a failure count — the run worked and said what is
        // left, which is why `success` stays true.
        expect(result.success).toBe(true);
        expect(await prisma.machinePosition.count({ where: { tenantId: TENANT } })).toBe(1);
    }, 60_000);

    it('deletes OLDEST first, so a bounded run makes progress at the far end', async () => {
        const oldest = await positionOn(dayAgo(60));
        await positionOn(dayAgo(45));
        process.env.MACHINE_POSITION_SWEEP = SWEEP_ARMED_VALUE;

        await runMachinePositionSweep({ today: TODAY, limit: 1 });

        const left = await prisma.machinePosition.findMany({
            where: { tenantId: TENANT }, select: { recordedAt: true },
        });
        expect(left).toHaveLength(1);
        expect(left[0].recordedAt.getTime()).not.toBe(oldest.getTime());
    }, 60_000);

    it('an empty window is a real answer, not a skipped run', async () => {
        await positionOn(dayAgo(1));
        process.env.MACHINE_POSITION_SWEEP = SWEEP_ARMED_VALUE;
        const { result } = await runMachinePositionSweep({ today: TODAY });
        expect(result.details).toMatchObject({ mode: 'delete', expired: 0, deleted: 0 });
        expect(result.success).toBe(true);
    }, 60_000);
});
