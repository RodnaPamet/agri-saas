/**
 * Сеитба on the diary write, and OUT of the БАБХ register — #2316.
 *
 * Owner decisions, 2026-10-25:
 *   - a sowing keeps its seed product, so it goes through `/journal/treatments`
 *     rather than `/journal/activities` — the form's «Продукт» column gets the
 *     sown variety;
 *   - it is excluded from the БАБХ register, which covers «РАСТИТЕЛНОЗАЩИТНИ
 *     МЕРОПРИЯТИЯ И ТОРЕНЕ» and therefore neither sowing nor the bare
 *     activities.
 *
 * ## The case this file exists for
 *
 * That exclusion is an ESCAPE HATCH unless the kind is constrained: a real
 * plant-protection treatment recorded as `kind: SEED` would never reach the
 * regulated register. `SEED_EXPECTED` closes it, and the second test is the one
 * that matters most here.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordDiaryTreatment, treatmentKindOf } from '@/app-layer/usecases/diary-treatment';
import {
    gatherFarmRecord,
    generateFarmRecordDiaryPdfScoped,
} from '@/app-layer/reports/pdf/farm-record-diary';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `seed-${randomUUID().slice(0, 8)}`;
let userId = '', unitId = '', tenantId = '', locationId = '', parcelId = '';
let seedItemId = '', pesticideItemId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });
const yesterday = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Seed User' },
    })).id;
    unitId = (await globalPrisma.unit.create({
        data: { key: `kg-per-ha-${TAG}`, name: 'kg per hectare', symbol: 'kg/ha', measure: 'RATE' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    locationId = (await globalPrisma.location.create({ data: { tenantId, name: `Block ${TAG}` } })).id;
    parcelId = (await globalPrisma.parcel.create({
        data: { tenantId, locationId, name: `P1 ${TAG}`, areaHa: 10 },
    })).id;
    seedItemId = (await globalPrisma.item.create({
        data: { tenantId, name: `Пшеница Никол ${TAG}`, category: 'SEED', defaultUnitId: unitId },
    })).id;
    pesticideItemId = (await globalPrisma.item.create({
        data: { tenantId, name: `Карате ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'TreatmentGroup', 'Item', 'Parcel', 'Location', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
    } catch (e) {
        console.warn('[seed-in-the-diary] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

describeFn('сеитба in the diary, out of the БАБХ register (#2316)', () => {
    it('records a sowing with its seed variety and a rate', async () => {
        const r = await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SEED',
                occurredOn: yesterday(),
                parcelIds: [parcelId],
                productItemId: seedItemId,
                doseValue: 220,
                doseUnitId: unitId,
            },
            `${TAG}-sow`,
        );
        expect(r.treatmentGroupId).toBe(`${TAG}-sow`);

        // The TASK must carry SEED. Before this change the usecase wrote
        // `isFertilizer ? 'FERTILIZE' : 'SPRAY'`, which collapsed SEED to
        // SPRAY — and the register's exclusion keys on operationType, so it
        // would never have seen a SEED row to exclude.
        expect(await treatmentKindOf(ctx(), `${TAG}-sow`)).toBe('SEED');

        const line = await globalPrisma.operationParcel.findFirstOrThrow({
            where: { tenantId, task: { treatmentGroupId: `${TAG}-sow` } },
            select: { productItemId: true, doseValue: true },
        });
        // A sowing DOES apply a product, unlike the bare activities.
        expect(line.productItemId).toBe(seedItemId);
        expect(Number(line.doseValue)).toBe(220);
    });

    it('REFUSES a pesticide recorded as a sowing — the escape hatch', async () => {
        // The test this file exists for. SEED is excluded from the БАБХ
        // register, so an unconstrained kind would let a real plant-protection
        // treatment be filed as сеитба and vanish from a regulated document.
        await expect(
            recordDiaryTreatment(
                ctx(),
                {
                    kind: 'SEED',
                    occurredOn: yesterday(),
                    parcelIds: [parcelId],
                    productItemId: pesticideItemId,
                    doseValue: 1,
                    doseUnitId: unitId,
                },
                `${TAG}-evade`,
            ),
        ).rejects.toMatchObject({ code: 'SEED_EXPECTED' });
    });

    it('still accepts any category on a SPRAY, which is deliberate', async () => {
        // The asymmetry is not an oversight: every category genuinely can be
        // sprayed and a SPRAY row still PRINTS, so permissiveness costs
        // nothing there. Asserted so a future tightening is a deliberate
        // decision rather than a side effect of copying the SEED rule.
        const r = await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SPRAY',
                occurredOn: yesterday(),
                parcelIds: [parcelId],
                productItemId: seedItemId, // a SEED item on a spraying
                doseValue: 2,
                doseUnitId: unitId,
            },
            `${TAG}-spray-seed`,
        );
        expect(r.treatmentGroupId).toBe(`${TAG}-spray-seed`);
    });

    it('the PDF generator returns NOTHING for a sowing, which is what the route branches on', async () => {
        // The assertion the owner's decision actually rests on. The route does
        // `if (!pdfDoc) { … NOT_IN_BABH_REGISTER }`, so the refusal only
        // happens if the generator declines to produce a document at all.
        //
        // Asserting the gatherer's empty line sets is NOT the same claim: a
        // generator that happily rendered a zero-row document would leave the
        // route serving a blank регистър — exactly what was rejected, with the
        // line sets empty and this test green.
        const doc = await generateFarmRecordDiaryPdfScoped(ctx(), {
            kind: 'treatment',
            treatmentGroupId: `${TAG}-sow`,
        });
        expect(doc).toBeFalsy();
    });

    it('and DOES produce one for the spraying — the control', async () => {
        const doc = await generateFarmRecordDiaryPdfScoped(ctx(), {
            kind: 'treatment',
            treatmentGroupId: `${TAG}-spray-seed`,
        });
        expect(doc).toBeTruthy();
    });

    it('a sowing enters NEITHER БАБХ table', async () => {
        const data = await gatherFarmRecord(ctx(), {
            kind: 'treatment',
            treatmentGroupId: `${TAG}-sow`,
        });
        // The register covers plant protection and fertilising. Both line sets
        // empty for a sowing is the whole compliance property.
        //
        // Reads `sprayLines` / `fertilizeLines`, which are the real fields. The
        // first version read `data.groups`, which does not exist on
        // `FarmRecordData` — so it compared `[] ` against `[]` and passed
        // having checked nothing. The positive control below is what caught it.
        expect({
            spray: data?.sprayLines?.length ?? 0,
            fertilise: data?.fertilizeLines?.length ?? 0,
        }).toEqual({ spray: 0, fertilise: 0 });
    });

    it('but a SPRAY of the same shape DOES enter the register', async () => {
        // The positive control. Without it, "both empty" could mean the
        // gatherer is broken rather than that the exclusion works — a check
        // that cannot produce the other answer is no evidence.
        const data = await gatherFarmRecord(ctx(), {
            kind: 'treatment',
            treatmentGroupId: `${TAG}-spray-seed`,
        });
        expect(data?.sprayLines?.length ?? 0).toBeGreaterThan(0);
    });
});
