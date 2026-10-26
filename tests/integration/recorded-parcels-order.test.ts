/**
 * The refusal ORDER of a resumable treatment write, pinned (#2351).
 *
 * `recorded-parcels.ts` now owns the four pre-write steps, and
 * `recordDiaryTreatment` calls them INDIVIDUALLY rather than through
 * `resolveRecordedParcels`, because two of them sit on the far side of its
 * replay lookup:
 *
 *     parse day → future refusal → empty-list refusal
 *       → replay lookup, which RETURNS for a complete treatment
 *       → parcel fetch + tenant refusal → area bound → block grouping
 *
 * Routing it through the composition would move the parcel fetch ahead of that
 * return. A client retrying a treatment it had already recorded, with one parcel
 * since archived, would stop getting its idempotent success and start getting
 * `REFERENCE_NOT_IN_TENANT`.
 *
 * That is a behaviour change on a resumable write to a regulated document, which
 * is why the owner chose "split to preserve the order exactly" over "accept the
 * new order". Nothing in the suite pinned that order before, so the next person
 * to tidy this into one call would have had nothing object.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordDiaryTreatment } from '@/app-layer/usecases/diary-treatment';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `ord-${randomUUID().slice(0, 8)}`;
let userId = '', tenantId = '', locA = '', parcelA1 = '', parcelA2 = '';
let rateUnitId = '', itemId = '', foreignTenantId = '', foreignParcelId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });
const dayAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
};
const inFuture = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 3);
    return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Order User' },
    })).id;
    rateUnitId = (await globalPrisma.unit.create({
        data: { key: `l-per-ha-${TAG}`, name: 'L per ha', symbol: 'L/ha', measure: 'RATE' },
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
        data: { tenantId, locationId: locA, name: `A2 ${TAG}`, areaHa: 5 },
    })).id;
    itemId = (await globalPrisma.item.create({
        data: { tenantId, name: `Карате ${TAG}`, category: 'PESTICIDE', defaultUnitId: rateUnitId },
    })).id;
    foreignTenantId = (await globalPrisma.tenant.create({
        data: { name: `Other ${TAG}`, slug: `${TAG}-other` },
    })).id;
    const fl = await globalPrisma.location.create({
        data: { tenantId: foreignTenantId, name: `F ${TAG}` },
    });
    foreignParcelId = (await globalPrisma.parcel.create({
        data: { tenantId: foreignTenantId, locationId: fl.id, name: `F1 ${TAG}`, areaHa: 2 },
    })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'TreatmentCorrection', 'TreatmentGroup', 'Item', 'Parcel', 'Location', 'TenantMembership']) {
            for (const tid of [tenantId, foreignTenantId]) {
                await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tid).catch(() => {});
            }
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        for (const tid of [tenantId, foreignTenantId]) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tid).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, rateUnitId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
    } catch (e) {
        console.warn('[recorded-parcels-order] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

const spray = (handle: string, parcelIds: string[], occurredOn = dayAgo(2)) =>
    recordDiaryTreatment(
        ctx(),
        { kind: 'SPRAY', occurredOn, parcelIds, productItemId: itemId, doseValue: 2, doseUnitId: rateUnitId },
        handle,
    );

describeFn('the resumable write keeps its refusal order (#2351)', () => {
    it('a COMPLETE replay still wins over a bad parcel — the order this split exists to preserve', async () => {
        // THE test. Record, then resend the same handle with a parcel from
        // another farm. The replay lookup sits BEFORE the parcel fetch, so the
        // request must come back as an idempotent success.
        //
        // If someone routes this path through `resolveRecordedParcels`, the
        // fetch moves ahead of the replay and this becomes
        // REFERENCE_NOT_IN_TENANT — a client that had already recorded its
        // treatment suddenly being told its request is invalid.
        const h = `${TAG}-replay`;
        const first = await spray(h, [parcelA1, parcelA2]);
        expect({ replayed: first.replayed, parcelCount: first.parcelCount }).toEqual({
            replayed: false,
            parcelCount: 2,
        });

        const again = await spray(h, [parcelA1, foreignParcelId]);
        expect(again.replayed).toBe(true);
        // And replay-STABLE: the saved screen stays truthful.
        expect(again.parcelCount).toBe(2);
        expect(again.treatmentGroupId).toBe(h);
    });

    it('a future day is refused BEFORE the parcel list is even looked at', async () => {
        // Order within the first two steps: the day check precedes the
        // empty-list check, and both precede any query. An empty list AND a
        // future day must yield the DATE refusal.
        await expect(spray(`${TAG}-future`, [], inFuture())).rejects.toMatchObject({
            code: 'TREATMENT_DATE_IN_FUTURE',
        });
    });

    it('an empty list is refused BEFORE the parcel fetch', async () => {
        // With a valid day, the empty-list refusal comes next — not a tenant
        // refusal, and not a successful write of nothing.
        await expect(spray(`${TAG}-empty`, [])).rejects.toMatchObject({
            code: 'TREATMENT_NO_PARCELS',
        });
    });

    it("a FIRST write with another farm's parcel is still refused", async () => {
        // The control for the replay test above: without a prior recording there
        // is nothing to replay, so the fetch is reached and the refusal stands.
        // Without this, the replay test alone could be satisfied by a route that
        // never checks tenancy at all.
        await expect(spray(`${TAG}-first`, [parcelA1, foreignParcelId])).rejects.toMatchObject({
            code: 'REFERENCE_NOT_IN_TENANT',
        });
    });

    it('an over-large treated area is still bounded by the parcel', async () => {
        // Step 4 still runs where it did. `parcelA2` is 5 ha.
        await expect(
            recordDiaryTreatment(
                ctx(),
                {
                    kind: 'SPRAY',
                    occurredOn: dayAgo(2),
                    parcelIds: [parcelA2],
                    parcels: [{ parcelId: parcelA2, treatedAreaHa: 9 }],
                    productItemId: itemId,
                    doseValue: 2,
                    doseUnitId: rateUnitId,
                },
                `${TAG}-area`,
            ),
        ).rejects.toMatchObject({ code: 'TREATMENT_AREA_EXCEEDS_PARCEL' });
    });
});
