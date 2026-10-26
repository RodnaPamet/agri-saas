/**
 * Correcting a bare activity, end to end — #2373.
 *
 * DB-backed because every claim worth making is about rows: that the day moves
 * in BOTH places a surface reads it from, that a no-op writes nothing at all,
 * that the harvest total can be changed and CLEARED, and that the refusal order
 * does not leak whether a handle is a treatment to someone who may not edit it.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordFarmActivity } from '@/app-layer/usecases/farm-activity';
import {
    recordDiaryTreatment,
    correctDiaryTreatment,
    getDiaryTreatmentCorrections,
} from '@/app-layer/usecases/diary-treatment';
import {
    correctFarmActivity,
    getFarmActivityDefinition,
    getFarmActivityCorrections,
} from '@/app-layer/usecases/farm-activity-correction';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `fac-${randomUUID().slice(0, 8)}`;
let userId = '', otherUserId = '', tenantId = '', locA = '', parcelA1 = '', parcelA2 = '';
let rateUnitId = '', seedItemId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });
const otherCtx = () =>
    makeRequestContext('EDITOR', { userId: otherUserId, tenantId, tenantSlug: `${TAG}-t` });

const dayAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Correcting User' },
    })).id;
    const email2 = `${TAG}-other@ag.test`;
    otherUserId = (await globalPrisma.user.create({
        data: { email: email2, emailHash: hashForLookup(email2), name: 'Other User' },
    })).id;
    // `Unit.key` is globally unique and `kg` is ONE shared catalogue row, so it
    // is reused rather than created, and `afterAll` must NOT delete it.
    await globalPrisma.unit.upsert({
        where: { key: 'kg' },
        update: {},
        create: { key: 'kg', name: 'Kilogram', symbol: 'kg', measure: 'WEIGHT' },
    });
    rateUnitId = (await globalPrisma.unit.create({
        data: { key: `kg-per-ha-${TAG}`, name: 'kg per ha', symbol: 'kg/ha', measure: 'RATE' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    for (const [uid, role] of [[userId, Role.OWNER], [otherUserId, Role.EDITOR]] as const) {
        await globalPrisma.tenantMembership.create({
            data: { tenantId, userId: uid, role, status: MembershipStatus.ACTIVE },
        });
    }
    locA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    parcelA1 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `A1 ${TAG}`, areaHa: 8 },
    })).id;
    parcelA2 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `A2 ${TAG}`, areaHa: 4 },
    })).id;
    seedItemId = (await globalPrisma.item.create({
        data: { tenantId, name: `Пшеница ${TAG}`, category: 'SEED', defaultUnitId: rateUnitId },
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
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, rateUnitId);
        for (const u of [userId, otherUserId]) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, u);
        }
    } catch (e) {
        console.warn('[farm-activity-correction] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

const prune = (handle: string, parcels = [parcelA1, parcelA2]) =>
    recordFarmActivity(ctx(), { kind: 'PRUNE', occurredOn: dayAgo(3), parcelIds: parcels }, handle);

const harvest = (handle: string, kg?: number) =>
    recordFarmActivity(
        ctx(),
        { kind: 'HARVEST', occurredOn: dayAgo(3), parcelIds: [parcelA1], ...(kg != null ? { harvestKg: kg } : {}) },
        handle,
    );

describeFn('correctFarmActivity (#2373)', () => {
    it('moves the day in BOTH places a surface reads it from', async () => {
        const h = `${TAG}-day`;
        await prune(h);
        const after = await correctFarmActivity(ctx(), h, { occurredOn: dayAgo(1) });
        expect(after.occurredOn).toBe(dayAgo(1));
        expect(after.version).toBe(1);

        // The printed record reads the LINE's completedAt; the journal list
        // sorts and filters on the ENTRY's occurredAt. Moving one would leave
        // the corrected activity on the old day in the list while the document
        // showed the new one.
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, task: { treatmentGroupId: h } },
            select: { completedAt: true },
        });
        const entries = await globalPrisma.logEntry.findMany({
            where: { tenantId, treatmentGroupId: h },
            select: { occurredAt: true },
        });
        expect(lines).toHaveLength(2);
        expect(entries.length).toBeGreaterThan(0);
        for (const l of lines) {
            expect(l.completedAt?.toISOString().slice(0, 10)).toBe(dayAgo(1));
        }
        for (const e of entries) {
            expect(e.occurredAt.toISOString().slice(0, 10)).toBe(dayAgo(1));
        }
    });

    it('a correction that changes NOTHING writes nothing', async () => {
        // Re-submitting an unchanged form must not invent a correction in the
        // history of a record, nor bump the version and invalidate an `If-Match`
        // another client is holding.
        const h = `${TAG}-noop`;
        await prune(h);
        const before = await getFarmActivityDefinition(ctx(), h);
        const after = await correctFarmActivity(ctx(), h, { occurredOn: before.occurredOn! });
        expect(after.version).toBe(before.version);
        const trail = await globalPrisma.treatmentCorrection.count({ where: { tenantId, groupId: h } });
        expect(trail).toBe(0);
    });

    it('changes a harvest total, and the trail records the previous one', async () => {
        const h = `${TAG}-kg`;
        await harvest(h, 12400);
        const before = await getFarmActivityDefinition(ctx(), h);
        expect(before.harvestKg).toBe(12400);

        const after = await correctFarmActivity(ctx(), h, { harvestKg: 9800 });
        expect(after.harvestKg).toBe(9800);

        const rows = await globalPrisma.logQuantity.findMany({
            where: { tenantId, logEntry: { treatmentGroupId: h }, measure: 'WEIGHT' },
            select: { value: true, label: true },
        });
        // ONE total, changed — not a second row beside the first.
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].value)).toBe(9800);

        const trail = await globalPrisma.treatmentCorrection.findFirstOrThrow({
            where: { tenantId, groupId: h },
            select: { changedFields: true, previous: true, correctedByUserId: true },
        });
        expect(trail.changedFields).toEqual(['harvestKg']);
        expect(trail.correctedByUserId).toBe(userId);
        // The WHOLE previous definition, not a diff — the point of the record is
        // that the state it was a diff against is gone.
        expect((trail.previous as { harvestKg: number }).harvestKg).toBe(12400);
    });

    it('CLEARS a harvest total with null, because a mistake must be removable', async () => {
        const h = `${TAG}-clear`;
        await harvest(h, 500);
        const after = await correctFarmActivity(ctx(), h, { harvestKg: null });
        expect(after.harvestKg).toBeNull();
        const rows = await globalPrisma.logQuantity.count({
            where: { tenantId, logEntry: { treatmentGroupId: h }, measure: 'WEIGHT' },
        });
        expect(rows).toBe(0);
    });

    it('records a total a harvest never had', async () => {
        // The third arm: no existing row, so the correction CREATES one. Without
        // it a farmer who forgot the weight could never add it.
        const h = `${TAG}-add`;
        await harvest(h);
        expect((await getFarmActivityDefinition(ctx(), h)).harvestKg).toBeNull();
        const after = await correctFarmActivity(ctx(), h, { harvestKg: 777 });
        expect(after.harvestKg).toBe(777);
        const rows = await globalPrisma.logQuantity.findMany({
            where: { tenantId, logEntry: { treatmentGroupId: h }, measure: 'WEIGHT' },
            select: { value: true, label: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toBe('Общо за мероприятието');
    });

    it('refuses a total on something that is not a harvest', async () => {
        // Refused, not ignored: a quantity silently dropped is a farmer
        // believing they recorded a yield they did not.
        const h = `${TAG}-notharvest`;
        await prune(h);
        await expect(correctFarmActivity(ctx(), h, { harvestKg: 100 })).rejects.toMatchObject({
            code: 'HARVEST_TOTAL_NOT_APPLICABLE',
        });
    });

    it('refuses a TREATMENT handle — it has its own correction route', async () => {
        const h = `${TAG}-treatment`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SEED',
                occurredOn: dayAgo(3),
                parcelIds: [parcelA1],
                productItemId: seedItemId,
                doseValue: 200,
                doseUnitId: rateUnitId,
            },
            h,
        );
        await expect(correctFarmActivity(ctx(), h, { occurredOn: dayAgo(1) })).rejects.toMatchObject({
            code: 'NOT_AN_ACTIVITY',
        });
    });

    it('404s a handle that names nothing', async () => {
        await expect(
            correctFarmActivity(ctx(), `${TAG}-absent`, { occurredOn: dayAgo(1) }),
        ).rejects.toMatchObject({ code: 'ACTIVITY_NOT_FOUND' });
    });

    it('refuses a STALE If-Match rather than overwriting', async () => {
        const h = `${TAG}-stale`;
        await prune(h);
        // One successful correction takes the version to 1, so 0 is now stale —
        // exactly what a client holding an old prefill would send.
        await correctFarmActivity(ctx(), h, { occurredOn: dayAgo(2) }, 0);
        await expect(
            correctFarmActivity(ctx(), h, { occurredOn: dayAgo(1) }, 0),
        ).rejects.toMatchObject({ code: 'STALE_DATA' });
        // And the second day was NOT applied.
        expect((await getFarmActivityDefinition(ctx(), h)).occurredOn).toBe(dayAgo(2));
    });

    it('refuses someone who did not record it and is not an admin', async () => {
        // The treatments rule, unchanged: a correction must not be easier to
        // make than a withdrawal.
        //
        // The code is `TREATMENT_EDIT_NOT_PERMITTED` because the RULE is shared
        // — `assertCanEditTreatment`, reused rather than restated, so that the
        // two verbs cannot drift apart. The `TREATMENT_` prefix is the code's
        // NAME, not a claim about this record; its copy was reworded to be
        // kind-neutral in this change, since it was telling a farmer correcting
        // a резитба about «това третиране».
        const h = `${TAG}-perm`;
        await prune(h);
        await expect(
            correctFarmActivity(otherCtx(), h, { occurredOn: dayAgo(1) }),
        ).rejects.toMatchObject({ code: 'TREATMENT_EDIT_NOT_PERMITTED' });
    });

    it('the prefill round-trips — what it returns is re-submittable', async () => {
        // The requirement rather than a convenience: a field the prefill cannot
        // express is a field a correction would silently drop.
        const h = `${TAG}-round`;
        await harvest(h, 4200);
        const d = await getFarmActivityDefinition(ctx(), h);
        expect({ kind: d.kind, parcelCount: d.parcelCount, harvestKg: d.harvestKg }).toEqual({
            kind: 'HARVEST',
            parcelCount: 1,
            harvestKg: 4200,
        });
        expect(d.lines[0].parcelId).toBe(parcelA1);
        // Sending its own values back changes nothing and writes nothing.
        const again = await correctFarmActivity(ctx(), h, {
            occurredOn: d.occurredOn!,
            harvestKg: d.harvestKg,
        });
        expect(again.version).toBe(d.version);
    });

    it('serves the activity trail, with the whole previous definition', async () => {
        const h = `${TAG}-trail`;
        await harvest(h, 1000);
        await correctFarmActivity(ctx(), h, { harvestKg: 2000 });

        const trail = await getFarmActivityCorrections(ctx(), h);
        expect(trail.treatmentGroupId).toBe(h);
        expect(trail.version).toBe(1);
        expect(trail.corrections).toHaveLength(1);
        const [entry] = trail.corrections;
        expect(entry.changedFields).toEqual(['harvestKg']);
        // A display NAME, resolved per read — never a user id.
        expect(entry.correctedBy).toBe('Correcting User');
        expect(entry.previous?.harvestKg).toBe(1000);
        expect(entry.previous?.kind).toBe('HARVEST');
    });

    it('the TREATMENTS trail refuses a bare handle', async () => {
        // Without this gate that route answers with `previous` holding a
        // FarmActivityDefinition under a contract promising a
        // TreatmentDefinition — two shapes on one path, nothing to discriminate
        // on. Raised by agrent-ios reading the branch before building on it.
        const h = `${TAG}-xtrail`;
        await prune(h);
        await correctFarmActivity(ctx(), h, { occurredOn: dayAgo(1) });
        await expect(getDiaryTreatmentCorrections(ctx(), h)).rejects.toMatchObject({
            code: 'NOT_A_TREATMENT',
        });
    });

    it('the ACTIVITIES trail refuses a treatment handle — the exact complement', async () => {
        const h = `${TAG}-xtrail2`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SEED',
                occurredOn: dayAgo(3),
                parcelIds: [parcelA1],
                productItemId: seedItemId,
                doseValue: 200,
                doseUnitId: rateUnitId,
            },
            h,
        );
        await expect(getFarmActivityCorrections(ctx(), h)).rejects.toMatchObject({
            code: 'NOT_AN_ACTIVITY',
        });
    });

    it('404s an unknown handle without confirming anything', async () => {
        await expect(getFarmActivityCorrections(ctx(), `${TAG}-nothing`)).rejects.toMatchObject({
            code: 'ACTIVITY_NOT_FOUND',
        });
    });

    it('both trails have the IDENTICAL envelope, which agrent-ios decodes with one type', async () => {
        // The property they asked to be able to rely on, asserted rather than
        // promised. One `readCorrectionTrail` serves both, so this cannot drift
        // — and if someone splits it again, this fails.
        const act = `${TAG}-env-a`;
        await harvest(act, 10);
        await correctFarmActivity(ctx(), act, { harvestKg: 20 });

        const trt = `${TAG}-env-t`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SEED',
                occurredOn: dayAgo(3),
                parcelIds: [parcelA1],
                productItemId: seedItemId,
                doseValue: 200,
                doseUnitId: rateUnitId,
            },
            trt,
        );
        await correctDiaryTreatment(ctx(), trt, { doseValue: 210 });

        const a = await getFarmActivityCorrections(ctx(), act);
        const t = await getDiaryTreatmentCorrections(ctx(), trt);

        // The ACTUAL key names, pinned — not just "the two agree". Comparing
        // them only to each other would pass a rename that hit both, which is
        // exactly what sharing the reader makes easy: one edit changes both
        // envelopes and the symmetry assertion stays green while the phone's
        // decoder breaks. These are the names agrent-ios decodes.
        expect(Object.keys(a).sort()).toEqual(['corrections', 'treatmentGroupId', 'version']);
        expect(Object.keys(a.corrections[0]).sort()).toEqual([
            'changedFields',
            'correctedAt',
            'correctedBy',
            'previous',
        ]);
        // And then that the treatments trail is the same envelope, so the two
        // cannot diverge later.
        expect(Object.keys(a).sort()).toEqual(Object.keys(t).sort());
        expect(Object.keys(a.corrections[0]).sort()).toEqual(Object.keys(t.corrections[0]).sort());
        // `previous` is the ONE field whose shape differs, deliberately — which
        // is why there are two paths rather than one polymorphic endpoint.
        expect(a.corrections[0].previous).not.toBeNull();
        expect(t.corrections[0].previous).not.toBeNull();
    });
});
