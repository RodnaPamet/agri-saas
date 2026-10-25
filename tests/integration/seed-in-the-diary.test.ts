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
import {
    recordDiaryTreatment,
    treatmentKindOf,
    getDiaryTreatmentDefinition,
} from '@/app-layer/usecases/diary-treatment';
import { createFieldOperation } from '@/app-layer/usecases/field-operation';
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
    // The BY-NAME path derives a STOCK unit from the dose unit — `kg-per-ha`
    // gives `kg` — and refuses with `DOSE_UNIT_HAS_NO_BASE` if that row is
    // absent. `Unit.key` is globally unique and `kg` is ONE shared catalogue
    // row, so this upserts and `afterAll` deliberately does NOT delete it:
    // removing a shared unit would break every other suite that resolves one.
    await globalPrisma.unit.upsert({
        where: { key: 'kg' },
        update: {},
        create: { key: 'kg', name: 'Kilogram', symbol: 'kg', measure: 'WEIGHT' },
    });
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

    it('a typed seed NAME creates a SEED item, not a PESTICIDE', async () => {
        // «Нов запис» on the phone sends NAMES and finds-or-creates, so this is
        // the path a farmer actually sows through. It was broken two ways.
        //
        // `newProductCategory` is `'PESTICIDE' | 'FERTILIZER'` — SEED is not
        // expressible — so a typed seed name fell to the PESTICIDE default, and
        // `assertPesticideIsFilable` then demanded a ПРЗ № and a quarantine
        // period for a bag of wheat seed. That is all a farmer sowing by name
        // could ever see: сеитба could not be recorded at all.
        const name = `Пшеница Енола ${TAG}`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SEED',
                occurredOn: yesterday(),
                parcelIds: [parcelId],
                productName: name,
                doseValue: 190,
                doseUnitId: unitId,
            },
            `${TAG}-byname`,
        );

        const item = await globalPrisma.item.findFirstOrThrow({
            where: { tenantId, name },
            select: { category: true, pppRegistrationNo: true, defaultUnit: { select: { key: true } } },
        });
        expect(item.category).toBe('SEED');
        // And no regulatory fields were invented to get past the pesticide rule.
        expect(item.pppRegistrationNo).toBeNull();
        // The STOCK unit, derived from the rate unit — not the rate itself.
        expect(item.defaultUnit?.key).toBe('kg');
    });

    it('sows the same name TWICE — the create and the found path agree', async () => {
        // The second sowing takes the FOUND branch, which has always asserted
        // the category against the kind. So the two branches have to agree, and
        // before this change they could not: the create made a PESTICIDE and the
        // found path refused it with `SEED_EXPECTED`. A farmer sowing the same
        // variety on a second parcel would have been refused on the second
        // record — the "refused at the worst moment" shape free text exists to
        // avoid.
        const name = `Слънчоглед Рими ${TAG}`;
        const sow = (key: string) =>
            recordDiaryTreatment(
                ctx(),
                {
                    kind: 'SEED',
                    occurredOn: yesterday(),
                    parcelIds: [parcelId],
                    productName: name,
                    doseValue: 6,
                    doseUnitId: unitId,
                },
                key,
            );
        await sow(`${TAG}-twice-a`);
        await expect(sow(`${TAG}-twice-b`)).resolves.toBeTruthy();

        // ONE item, not two — the second call resolved the existing name.
        const items = await globalPrisma.item.findMany({ where: { tenantId, name }, select: { id: true } });
        expect(items).toHaveLength(1);
    });

    it('an explicit PESTICIDE category loses to the kind on a sowing', async () => {
        // `newProductCategory` is `'PESTICIDE' | 'FERTILIZER'`, so a client can
        // ask for the wrong one on a сеитба. The kind wins, and the field now
        // documents itself as ignored here — the same way it is already ignored
        // on the `fertilizerName` path, which always creates a FERTILIZER.
        const name = `Раундъп ${TAG}`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SEED',
                occurredOn: yesterday(),
                parcelIds: [parcelId],
                productName: name,
                doseValue: 3,
                doseUnitId: unitId,
                newProductCategory: 'PESTICIDE',
            },
            `${TAG}-smuggle`,
        );
        const item = await globalPrisma.item.findFirstOrThrow({
            where: { tenantId, name },
            select: { category: true },
        });
        expect(item.category).toBe('SEED');
    });

    it('the FIELD-OPERATION route cannot smuggle a PESTICIDE in as a sowing', async () => {
        // THE escape hatch, and it is on this route rather than the diary one.
        // `RecordDiaryTreatmentInput` has no `newProductRegistration`, so a
        // diary sowing could never supply the two regulatory fields and a
        // PESTICIDE create died at `assertPesticideIsFilable`.
        // `CreateFieldOperationInput` DOES take them, and its `operationType`
        // enum includes SEED — so before this change:
        //
        //   operationType: SEED + productName + the two ПРЗ fields
        //     → an Item created as PESTICIDE
        //     → a task whose operationType is SEED
        //     → excluded from the БАБХ register by #2316
        //
        // A real plant protection product, out of the regulated document, with
        // the exclusion working exactly as designed. `SEED_EXPECTED` closed this
        // only on the found-by-id path; the create path had no check at all.
        const name = `Децис ${TAG}`;
        await createFieldOperation(
            ctx(),
            locationId,
            {
                assigneeUserId: userId,
                parcelIds: [parcelId],
                operationType: 'SEED',
                productName: name,
                doseValue: 2,
                doseUnitId: unitId,
                newProductRegistration: {
                    pppRegistrationNo: '0123-ПРЗ',
                    quarantinePeriodDays: 30,
                    activeIngredient: 'deltamethrin',
                },
            },
            `${TAG}-fo-smuggle`,
        );
        const item = await globalPrisma.item.findFirstOrThrow({
            where: { tenantId, name },
            select: { category: true, pppRegistrationNo: true },
        });
        expect(item.category).toBe('SEED');
        // The ПРЗ number it sent is still stored — this does not sanitise the
        // payload, it refuses to let the payload choose the CATEGORY. A seed
        // carrying a stray registration number is odd but harmless; a pesticide
        // outside the register is not.
        expect(item.pppRegistrationNo).toBe('0123-ПРЗ');
    });

    it('the definition reads back as SEED, not SPRAY', async () => {
        // The MIRROR of the write bug, and the one a client sees. The definition
        // read built its kind with `operationType === 'FERTILIZE' ? … : 'SPRAY'`,
        // so a sowing came back as a spraying even after the write was fixed.
        //
        // This is not cosmetic: the contract tells a client to gate «Изтегли
        // PDF» on `kind`, so a сеитба reading as SPRAY shows the button and the
        // server then answers `NOT_IN_BABH_REGISTER`. Widening the TYPE to admit
        // SEED did nothing, because a narrow producer still satisfies a wide
        // type — nothing failed while they disagreed.
        // `loadTreatmentForEdit` is the ONLY producer of a definition, and it
        // has three consumers: this read, and the correction's own BEFORE and
        // AFTER snapshots. So the collapse also wrote `SPRAY` into the
        // correction trail of a sowing — a regulated record's audit history
        // naming the wrong kind of operation.
        const d = await getDiaryTreatmentDefinition(ctx(), `${TAG}-sow`);
        expect(d.kind).toBe('SEED');
    });
});
