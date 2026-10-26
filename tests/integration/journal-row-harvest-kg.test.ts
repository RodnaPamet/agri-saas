/**
 * The harvest total on a journal row (agrent-ios #446).
 *
 * A saved harvest's «Продукция» was readable NOWHERE. The figure lives on a
 * `LogQuantity`, and the only read that returned it —
 * `GET …/activities/{handle}/definition` — is write-gated by design, because its
 * body exists to be edited. So the farmer who recorded a yield could not see it
 * again on the row they recorded it from.
 *
 * ## The case this file exists for
 *
 * `measure = 'WEIGHT'` does NOT mean "a harvest". Both `recordInputApplication`
 * and `correctDiaryTreatment` write a quantity with the PRODUCT's own measure,
 * which is `WEIGHT` for anything sold by the kilogram. So a fertilisation of a
 * kg-based product carries a WEIGHT quantity that is an APPLIED amount.
 *
 * Reading that as produce would print a fertiliser's kilograms as a yield on the
 * row a farmer checks their harvest on — the same misreading that once put
 * «Общо за мероприятието» in a column headed «Вид» (#2364). The last test is the
 * one that catches it; the others would pass against the naive filter.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordFarmActivity } from '@/app-layer/usecases/farm-activity';
import { recordDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `hkg-${randomUUID().slice(0, 8)}`;
let userId = '', tenantId = '', locA = '', parcelA1 = '', parcelA2 = '';
let kgPerDaId = '', kgItemId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });
const dayAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
};

interface Row {
    treatmentGroupId: string;
    treatment?: { harvestKg?: number | null; kind?: string | null } | null;
}

async function rows(): Promise<Row[]> {
    const res = (await listLogEntriesPaginated(ctx(), { limit: 50 })) as { items: Row[] };
    return res.items;
}
const rowFor = (all: Row[], handle: string) => all.find((r) => r.treatmentGroupId === handle);

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Harvest Reader' },
    })).id;
    // `kg` is ONE shared catalogue row — upserted, and never deleted in cleanup.
    await globalPrisma.unit.upsert({
        where: { key: 'kg' },
        update: {},
        create: { key: 'kg', name: 'Kilogram', symbol: 'kg', measure: 'WEIGHT' },
    });
    const kg = await globalPrisma.unit.findFirstOrThrow({ where: { key: 'kg' }, select: { id: true } });
    kgPerDaId = (await globalPrisma.unit.create({
        data: { key: `kg-per-ha-${TAG}`, name: 'kg per ha', symbol: 'kg/ha', measure: 'RATE' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    locA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    parcelA1 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `A1 ${TAG}`, areaHa: 10 },
    })).id;
    parcelA2 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `A2 ${TAG}`, areaHa: 4 },
    })).id;
    // A FERTILIZER whose stock unit is kg, so its applied quantity is written
    // with `measure: WEIGHT` — the row that must not be read as produce.
    kgItemId = (await globalPrisma.item.create({
        data: { tenantId, name: `Амониев нитрат ${TAG}`, category: 'FERTILIZER', defaultUnitId: kg.id },
    })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'TreatmentCorrection', 'TreatmentGroup', 'Item', 'Parcel', 'Location', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, kgPerDaId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
    } catch (e) {
        console.warn('[journal-row-harvest-kg] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

describeFn('the journal row carries a harvest total (agrent-ios #446)', () => {
    it('a HARVEST with a recorded total shows it', async () => {
        const h = `${TAG}-harvest`;
        await recordFarmActivity(
            ctx(),
            { kind: 'HARVEST', occurredOn: dayAgo(2), parcelIds: [parcelA1, parcelA2], harvestKg: 12400 },
            h,
        );
        const r = rowFor(await rows(), h);
        expect(r?.treatment?.harvestKg).toBe(12400);
        // ONE total for the activity, not one per parcel — two lines, one figure.
        expect(r?.treatment?.kind).toBe('HARVEST');
    });

    it('a HARVEST with NO total reads null, not zero', async () => {
        // `null` and `0` are different statements: 0 kg is a measured harvest of
        // nothing, and reporting it for an unrecorded one would invent a fact.
        const h = `${TAG}-noKg`;
        await recordFarmActivity(
            ctx(),
            { kind: 'HARVEST', occurredOn: dayAgo(3), parcelIds: [parcelA1] },
            h,
        );
        expect(rowFor(await rows(), h)?.treatment?.harvestKg).toBeNull();
    });

    it('a bare activity that is not a harvest reads null', async () => {
        const h = `${TAG}-prune`;
        await recordFarmActivity(
            ctx(),
            { kind: 'PRUNE', occurredOn: dayAgo(4), parcelIds: [parcelA1] },
            h,
        );
        expect(rowFor(await rows(), h)?.treatment?.harvestKg).toBeNull();
    });

    it('a FERTILISATION of a kg product is NOT reported as a yield', async () => {
        // THE test. Its applied quantity is written with the product's own
        // measure — WEIGHT, because the product is stocked in kilograms — so a
        // filter keyed on the measure would print the fertiliser's applied
        // kilograms as this row's harvest.
        const h = `${TAG}-fert`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'FERTILIZE',
                occurredOn: dayAgo(5),
                parcelIds: [parcelA1],
                fertilizerItemId: kgItemId,
                doseValue: 20,
                doseUnitId: kgPerDaId,
            },
            h,
        );

        // The premise: there IS a WEIGHT quantity under this handle. Without
        // this the test could pass because nothing was written at all.
        const weights = await globalPrisma.logQuantity.count({
            where: { tenantId, measure: 'WEIGHT', logEntry: { treatmentGroupId: h } },
        });
        expect(weights).toBeGreaterThan(0);

        // And it is not produce.
        expect(rowFor(await rows(), h)?.treatment?.harvestKg).toBeNull();
    });
});
