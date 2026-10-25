/**
 * A non-chemical activity is a line like any other — #2316, DB-backed.
 *
 * `OperationParcel.productItemId`, `doseValue` and `doseUnitId` were all NOT
 * NULL, so pruning, cultivation and harvest could not be recorded at all. The
 * model relaxed them with an all-or-nothing CHECK; this proves the WRITE path
 * actually produces such a row and that Postgres accepts it.
 *
 * Against real Postgres on purpose. The CHECK and the partial unique index live
 * in the migration and not in the Prisma schema, so a mocked test cannot see
 * either of them — and they are the two things most worth proving.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createFieldOperation } from '@/app-layer/usecases/field-operation';
import { appliesAProduct } from '@/lib/operations/line-kind';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `bare-${randomUUID().slice(0, 8)}`;

let userId = '';
let unitId = '';
let tenantId = '';
let locationId = '';
let parcelIds: string[] = [];
let itemId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    const user = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Bare Activity User' },
    });
    userId = user.id;
    const unit = await globalPrisma.unit.create({
        data: { key: `l-per-ha-${TAG}`, name: 'Litres per hectare', symbol: 'L/ha', measure: 'RATE' },
    });
    unitId = unit.id;
    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const location = await globalPrisma.location.create({ data: { tenantId, name: `Loc ${TAG}` } });
    locationId = location.id;
    const p1 = await globalPrisma.parcel.create({ data: { tenantId, locationId, name: `P1 ${TAG}` } });
    const p2 = await globalPrisma.parcel.create({ data: { tenantId, locationId, name: `P2 ${TAG}` } });
    parcelIds = [p1.id, p2.id];
    const item = await globalPrisma.item.create({
        data: { tenantId, name: `Product ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    });
    itemId = item.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "OperationParcel" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "TaskLink" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Item" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Parcel" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Location" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
    } catch (e) {
        console.warn('[bare-activity-lines] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

describeFn('a bare activity is a line like any other (#2316)', () => {
    it('writes lines with all three dose columns NULL, and Postgres accepts them', async () => {
        const created = await createFieldOperation(
            ctx(),
            locationId,
            { assigneeUserId: userId, parcelIds, operationType: 'PRUNE', title: `Prune ${TAG}` },
            `${TAG}-prune`,
        );
        expect(created.parcelCount).toBe(2);

        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, taskId: created.taskId },
            select: { productItemId: true, doseValue: true, doseUnitId: true, parcelId: true },
        });
        expect(lines).toHaveLength(2);
        for (const l of lines) {
            expect({
                productItemId: l.productItemId,
                doseValue: l.doseValue,
                doseUnitId: l.doseUnitId,
            }).toEqual({ productItemId: null, doseValue: null, doseUnitId: null });
            // The shared predicate must agree, since every reader keys on it.
            expect(appliesAProduct(l)).toBe(false);
        }

        const task = await globalPrisma.task.findUnique({
            where: { id: created.taskId },
            select: { operationType: true },
        });
        expect(task?.operationType).toBe('PRUNE');
    });

    it('a chemical line still writes all three, so the CHECK is not being dodged', async () => {
        // The other half of all-or-nothing. Without this, a bug that nulled
        // every dose column would pass the test above and look like a feature.
        const created = await createFieldOperation(
            ctx(),
            locationId,
            {
                assigneeUserId: userId,
                parcelIds: [parcelIds[0]],
                productItemId: itemId,
                doseValue: 2,
                doseUnitId: unitId,
            },
            `${TAG}-spray`,
        );
        const line = await globalPrisma.operationParcel.findFirstOrThrow({
            where: { tenantId, taskId: created.taskId },
            select: { productItemId: true, doseValue: true, doseUnitId: true },
        });
        expect(line.productItemId).toBe(itemId);
        expect(line.doseValue).not.toBeNull();
        expect(line.doseUnitId).toBe(unitId);
        expect(appliesAProduct(line)).toBe(true);
    });

    it('refuses a product on a bare kind rather than dropping it', async () => {
        // Silently ignoring the product would file a spraying as a pruning in a
        // regulated record, with the operator believing they had recorded one.
        await expect(
            createFieldOperation(
                ctx(),
                locationId,
                {
                    assigneeUserId: userId,
                    parcelIds,
                    operationType: 'HARVEST',
                    productItemId: itemId,
                    doseValue: 2,
                    doseUnitId: unitId,
                },
                `${TAG}-bad`,
            ),
        ).rejects.toThrow(/ACTIVITY_APPLIES_NO_INPUT|applies no product/i);
    });

    it('a CHEMICAL kind with no input is still refused — the old rule survives', async () => {
        // The discriminator is the KIND, never the absence of the fields. If it
        // were absence, this call would silently record a spraying that applied
        // nothing.
        await expect(
            createFieldOperation(
                ctx(),
                locationId,
                { assigneeUserId: userId, parcelIds, operationType: 'SPRAY' },
                `${TAG}-empty`,
            ),
        ).rejects.toThrow(/OPERATION_INPUT_AMBIGUOUS|exactly one input/i);
    });

    it('the partial unique index stops a second bare line on the same parcel', async () => {
        // Postgres treats NULLs as DISTINCT, so the per-product unique
        // constraint does NOT constrain these rows — the partial index does.
        // Asserted by a raw insert, because the usecase would never attempt it.
        const created = await createFieldOperation(
            ctx(),
            locationId,
            { assigneeUserId: userId, parcelIds: [parcelIds[1]], operationType: 'CULTIVATE' },
            `${TAG}-cult`,
        );
        await expect(
            globalPrisma.$executeRawUnsafe(
                `INSERT INTO "OperationParcel" ("id","tenantId","taskId","parcelId","status","createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,'PENDING',now(),now())`,
                randomUUID(),
                tenantId,
                created.taskId,
                parcelIds[1],
            ),
        ).rejects.toThrow(/bare_activity_key|duplicate key/i);
    });
});
