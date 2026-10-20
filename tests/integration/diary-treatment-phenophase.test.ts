/**
 * Фенофаза/BBCH on a recorded treatment (DB-backed) — #2072 part A.
 *
 * The field is stored PER LINE, following `quarantinePeriodDays` (#1775) on
 * the same table and for the same reason: it is an observation made on a day,
 * not a property of the product or the task.
 *
 * What is worth asserting, each a decision rather than a mechanism:
 *
 *   1. One request writes the stage to EVERY line it marks, across blocks —
 *      the register prints one row per parcel, so a value reaching only the
 *      first line would print on one row and be blank on the others.
 *   2. Omitted means NULL, never a guess. This is a regulated document; a
 *      plausible stage nobody observed is worse than an empty cell.
 *   3. The read-by-handle returns it, so reopening an entry shows what was
 *      saved rather than an empty field.
 *   4. The folded ДНЕВНИК row carries it, beside the period it sits next to
 *      on the paper form.
 *   5. A revert to PENDING CLEARS it — a line put back into play must not
 *      carry a stage observed for a completion that was undone.
 *
 * Not asserted here, because it does not exist: a printed cell. The 12-column
 * ХИМИЧНИ ОБРАБОТКИ table is fixed by заповед РД 11-3194/31.12.2021 and has no
 * phenophase column; «Фенофаза/BBCH» is column 2 of the separate scouting
 * table, whose derivation from treatments (#1740 Q2) is its own change.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordDiaryTreatment, getDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { markOperationParcel } from '@/app-layer/usecases/field-operation';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `pheno-${randomUUID().slice(0, 8)}`;
const DAY = '2026-03-04';
/** A Bulgarian stage NAME, not a bare code — the column admits both. */
const STAGE = 'Начало на цъфтеж (BBCH 61)';

let userId = '';
let unitId = '';
let tenantId = '';
let parcelA1 = '';
let parcelA2 = '';
let parcelB1 = '';
let itemId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Pheno User' },
    })).id;
    unitId = (await globalPrisma.unit.create({
        data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    // TWO blocks, because the write makes one task per block and property (1)
    // is about the value reaching every line of every task.
    const blockA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    const blockB = (await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } })).id;
    const mkParcel = async (locationId: string, name: string) =>
        (await globalPrisma.parcel.create({
            data: { tenantId, locationId, name, cropType: 'Wheat', areaHa: 10 },
        })).id;
    parcelA1 = await mkParcel(blockA, `A1 ${TAG}`);
    parcelA2 = await mkParcel(blockA, `A2 ${TAG}`);
    parcelB1 = await mkParcel(blockB, `B1 ${TAG}`);
    itemId = (await globalPrisma.item.create({
        data: {
            tenantId,
            name: `Prod ${TAG}`,
            category: 'PESTICIDE',
            defaultUnitId: unitId,
            // A product period, so the phenophase's ABSENCE of a product
            // fallback is visible against a field that HAS one.
            quarantinePeriodDays: 21,
        },
    })).id;
    await globalPrisma.inventoryLot.create({
        data: { tenantId, itemId, quantityOnHand: 500, unitId, lotCode: `LOT-${TAG}` },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['StockTransaction', 'InventoryLot', 'LogQuantity', 'LogEntry', 'Notification', 'EmailOutbox', 'OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'AutomationExecution', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

const baseInput = () => ({
    kind: 'SPRAY' as const,
    occurredOn: DAY,
    parcelIds: [parcelA1, parcelA2, parcelB1],
    productItemId: itemId,
    doseValue: 2,
    doseUnitId: unitId,
    targetNote: 'Septoria',
});

const linesOf = (taskIds: string[]) =>
    globalPrisma.operationParcel.findMany({
        where: { taskId: { in: taskIds } },
        select: { id: true, taskId: true, phenophase: true, status: true, version: true },
        orderBy: { id: 'asc' },
    });

describeFn('Фенофаза/BBCH on a recorded treatment', () => {
    it('writes the stage to EVERY line, across both blocks', async () => {
        const res = await recordDiaryTreatment(ctx(), { ...baseInput(), phenophase: STAGE });

        // The denominator: 3 parcels over 2 blocks, so 2 tasks and 3 lines.
        // Without this the next assertion would pass on a single line.
        expect(res.taskIds).toHaveLength(2);
        const lines = await linesOf(res.taskIds);
        expect(lines).toHaveLength(3);

        expect(lines.map((l) => l.phenophase)).toEqual([STAGE, STAGE, STAGE]);
        // And on lines belonging to DIFFERENT tasks, which is the property
        // a per-task field would satisfy only by accident.
        expect(new Set(lines.map((l) => l.taskId)).size).toBe(2);
    });

    it('stores NULL when omitted, rather than guessing a stage', async () => {
        const res = await recordDiaryTreatment(ctx(), baseInput());
        const lines = await linesOf(res.taskIds);
        expect(lines).toHaveLength(3);
        expect(lines.every((l) => l.phenophase === null)).toBe(true);
    });

    it('returns it from the read-by-handle', async () => {
        const res = await recordDiaryTreatment(ctx(), { ...baseInput(), phenophase: STAGE });
        const got = await getDiaryTreatment(ctx(), res.treatmentGroupId);
        expect(got?.phenophase).toBe(STAGE);

        const none = await recordDiaryTreatment(ctx(), baseInput());
        expect((await getDiaryTreatment(ctx(), none.treatmentGroupId))?.phenophase).toBeNull();
    });

    it('carries it on the folded ДНЕВНИК row, and does NOT fall back to the product', async () => {
        const res = await recordDiaryTreatment(ctx(), { ...baseInput(), phenophase: STAGE });
        const bare = await recordDiaryTreatment(ctx(), baseInput());

        const page = (await listLogEntriesPaginated(ctx(), { limit: 50 })) as {
            items: Array<{ treatment?: { treatmentGroupId: string; phenophase: string | null; quarantinePeriodDays: number | null } | null }>;
        };
        const rowOf = (handle: string) =>
            page.items.map((i) => i.treatment).find((t) => t?.treatmentGroupId === handle);

        expect(rowOf(res.treatmentGroupId)?.phenophase).toBe(STAGE);

        const bareRow = rowOf(bare.treatmentGroupId);
        expect(bareRow?.phenophase).toBeNull();
        // The positive control for "no fallback": on the SAME row the period
        // DOES fall back to the product's 21 days. So a null phenophase is
        // the absence of a fallback, not a read that returned nothing.
        expect(bareRow?.quarantinePeriodDays).toBe(21);
    });

    it('clears the stage when a line is reverted to PENDING', async () => {
        const res = await recordDiaryTreatment(ctx(), { ...baseInput(), phenophase: STAGE });
        const [line] = await linesOf(res.taskIds);
        expect(line.phenophase).toBe(STAGE);

        await markOperationParcel(ctx(), line.taskId, line.id, 'PENDING', undefined, line.version);

        const after = await globalPrisma.operationParcel.findUnique({
            where: { id: line.id },
            select: { phenophase: true, status: true },
        });
        expect(after?.status).toBe('PENDING');
        // A stage observed for a completion that was undone must not survive
        // it — the same rule #1775 applies to the quarantine period.
        expect(after?.phenophase).toBeNull();
    });
});
