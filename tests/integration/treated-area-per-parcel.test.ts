/**
 * Treated area per parcel (DB-backed) — #2072 part B.
 *
 * The register prints «Третирани площи (дка)» per parcel, and until now it
 * printed the PARCEL's area — correct only when the whole parcel was treated.
 * On a document a farmer submits to БАБХ, that overstates what was sprayed.
 *
 * What is asserted, each a decision:
 *
 *   1. The area lands on the LINE for its own parcel, and only that one. A
 *      treatment over three parcels can carry a different area for each,
 *      because the register prints one row per parcel.
 *   2. Exceeding the parcel's own area is REFUSED with a coded error, not
 *      clamped. Clamping would silently record a different number from the one
 *      the farmer typed, on a regulated document.
 *   3. EQUAL to the parcel's area is allowed — the boundary is inclusive, and
 *      `Decimal(12,4)` on both sides means equality is representable rather
 *      than a rounding coin-flip.
 *   4. A parcel whose own `areaHa` is NULL accepts any positive value. There
 *      is nothing to bound against, and refusing would block a legitimate
 *      register entry over missing cadastral data.
 *   5. The folded ДНЕВНИК row sums TREATED areas. The list and the PDF must
 *      not disagree about the same number.
 *   6. A revert to PENDING clears it, so the line reverts to meaning the whole
 *      parcel rather than keeping an area from an undone completion.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    recordDiaryTreatment,
    correctDiaryTreatment,
} from '@/app-layer/usecases/diary-treatment';
import { markOperationParcel } from '@/app-layer/usecases/field-operation';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `area-${randomUUID().slice(0, 8)}`;
const DAY = '2026-03-04';

let userId = '';
let unitId = '';
let tenantId = '';
let parcelA = '';   // 10 ha
let parcelB = '';   // 4 ha
let parcelNoArea = '';
let parcelOtherBlock = '';
let parcelOdd = ''; // areaHa NULL
let itemId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await prisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Area User' },
    })).id;
    unitId = (await prisma.unit.create({
        data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
    })).id;
    tenantId = (await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await prisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const block = (await prisma.location.create({ data: { tenantId, name: `Block ${TAG}` } })).id;
    const mk = async (name: string, areaHa: number | null) =>
        (await prisma.parcel.create({
            data: { tenantId, locationId: block, name, cropType: 'Wheat', areaHa },
        })).id;
    parcelA = await mk(`A ${TAG}`, 10);
    parcelB = await mk(`B ${TAG}`, 4);
    // An area that does NOT round cleanly to дка: 3.2478 ha prints as 32,48
    // дка, so typing the displayed figure back yields 3.248 ha — greater than
    // the parcel, and the case #2308 is about.
    parcelOdd = await mk(`O ${TAG}`, 3.2478);
    // A parcel in a SECOND block. Everything above sits in one block, so
    // without this nothing here exercises the fan-out: a treatment writes one
    // `Task` per block and applies the areas in a loop over each task's lines.
    const blockTwo = (await prisma.location.create({
        data: { tenantId, name: `Block two ${TAG}` },
    })).id;
    parcelOtherBlock = (await prisma.parcel.create({
        data: { tenantId, locationId: blockTwo, name: `C ${TAG}`, cropType: 'Wheat', areaHa: 8 },
    })).id;
    // A real possibility: a parcel with no measured area.
    parcelNoArea = await mk(`N ${TAG}`, null);
    itemId = (await prisma.item.create({
        data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    })).id;
    await prisma.inventoryLot.create({
        data: { tenantId, itemId, quantityOnHand: 500, unitId, lotCode: `LOT-${TAG}` },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['StockTransaction', 'InventoryLot', 'LogQuantity', 'LogEntry', 'Notification', 'EmailOutbox', 'OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'AutomationExecution', 'TenantMembership']) {
            await prisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await prisma.$disconnect();
});

const base = (parcelIds: string[]) => ({
    kind: 'SPRAY' as const,
    occurredOn: DAY,
    parcelIds,
    productItemId: itemId,
    doseValue: 2,
    doseUnitId: unitId,
    targetNote: 'Septoria',
});

const linesOf = (taskIds: string[]) =>
    prisma.operationParcel.findMany({
        where: { taskId: { in: taskIds } },
        select: { id: true, taskId: true, parcelId: true, treatedAreaHa: true, version: true },
    });

describeFn('treated area per parcel', () => {
    it('stores a different area per parcel, and leaves the untouched one whole', async () => {
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelA, parcelB]),
            parcels: [{ parcelId: parcelA, treatedAreaHa: 6.25 }],
        });
        const lines = await linesOf(res.taskIds);
        expect(lines).toHaveLength(2);

        const byParcel = new Map(lines.map((l) => [l.parcelId, l.treatedAreaHa]));
        expect(Number(byParcel.get(parcelA))).toBe(6.25);
        // NULL, not the parcel's 4 ha: absent means "the whole parcel", and
        // writing 4 here would make a later change to the parcel's area
        // silently disagree with the document.
        expect(byParcel.get(parcelB)).toBeNull();
    });

    it('REFUSES an area the register can express as larger', async () => {
        // 4.01 ha on a 4 ha parcel: 40,1 дка against 40 дка, a difference the
        // document can print. Refused rather than clamped — clamping would
        // silently record a smaller treatment than the farmer entered.
        //
        // This case used 4.0001 ha until #2308. That is 0,001 дка over, which
        // the register cannot express at all: `haToDca` then `trimNumber`
        // rounds to two places, so both sides print 40 дка. The bound now
        // compares at that resolution, so 4.0001 is ACCEPTED and the case below
        // is what the refusal needs to be made of.
        await expect(
            recordDiaryTreatment(ctx(), {
                ...base([parcelB]),
                parcels: [{ parcelId: parcelB, treatedAreaHa: 4.01 }],
            }),
        ).rejects.toMatchObject({ code: 'TREATMENT_AREA_EXCEEDS_PARCEL' });
    });

    it('ACCEPTS the displayed figure typed back, to 0,01 дка (#2308)', async () => {
        // The case the exact bound refused for a rounding the farmer did not
        // make. `parcelOdd` is 3.2478 ha, which the review screen and the
        // register both show as 32,48 дка. A farmer who means "all of it" types
        // that figure; it parses to 3.248 ha, which IS greater than 3.2478.
        //
        // Both sides round to 32,48 дка, so this is not larger in the units the
        // document is written in, and it is accepted. The value is stored as
        // SENT — owner ruling 2026-10-25: a whole-parcel treatment keeps the
        // real number so a later re-measure cannot change an old ДНЕВНИК row.
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelOdd]),
            parcels: [{ parcelId: parcelOdd, treatedAreaHa: 3.248 }],
        });
        const [line] = await linesOf(res.taskIds);
        expect(Number(line.treatedAreaHa)).toBe(3.248);
    });

    it('still refuses what is larger at that resolution, just over the line', async () => {
        // The discriminator for the case above. 3.2478 ha prints as 32,48 дка;
        // 3.2530 ha prints as 32,53 дка. One step of the register's own
        // resolution beyond, and refused — so the tolerance is the display
        // step and not an open-ended epsilon.
        await expect(
            recordDiaryTreatment(ctx(), {
                ...base([parcelOdd]),
                parcels: [{ parcelId: parcelOdd, treatedAreaHa: 3.253 }],
            }),
        ).rejects.toMatchObject({ code: 'TREATMENT_AREA_EXCEEDS_PARCEL' });
    });

    it('allows exactly the parcel area — the bound is inclusive', async () => {
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelB]),
            parcels: [{ parcelId: parcelB, treatedAreaHa: 4 }],
        });
        const [line] = await linesOf(res.taskIds);
        expect(Number(line.treatedAreaHa)).toBe(4);
    });

    it('accepts any positive area for a parcel with no recorded area', async () => {
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelNoArea]),
            parcels: [{ parcelId: parcelNoArea, treatedAreaHa: 999 }],
        });
        const [line] = await linesOf(res.taskIds);
        // Nothing to bound against. Refusing here would block a register entry
        // over missing cadastral data, which is not the farmer's fault.
        expect(Number(line.treatedAreaHa)).toBe(999);
    });

    it('sums TREATED areas on the folded row, so the list agrees with the PDF', async () => {
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelA, parcelB]),
            parcels: [
                { parcelId: parcelA, treatedAreaHa: 2 },
                { parcelId: parcelB, treatedAreaHa: 1 },
            ],
        });
        const page = (await listLogEntriesPaginated(ctx(), { limit: 50 })) as {
            items: Array<{ treatment?: { treatmentGroupId: string; totalAreaHa: number } | null }>;
        };
        const row = page.items
            .map((i) => i.treatment)
            .find((t) => t?.treatmentGroupId === res.treatmentGroupId);
        // 3, not 14. The parcels are 10 + 4 ha; summing those would report
        // more than four times what was actually treated.
        expect(row?.totalAreaHa).toBe(3);
    });

    it('lands on a parcel in a DIFFERENT block', async () => {
        // The fan-out. Every other case here is within one block, so a map
        // consumed by the first task — or keyed per task rather than per parcel
        // — would store the first area and silently leave the second block's
        // line whole. The register prints per block, so that line would claim
        // the whole field was treated.
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelA, parcelOtherBlock]),
            parcels: [
                { parcelId: parcelA, treatedAreaHa: 1.5 },
                { parcelId: parcelOtherBlock, treatedAreaHa: 4.25 },
            ],
        });
        const lines = await linesOf(res.taskIds);
        const area = new Map(lines.map((l) => [l.parcelId, l.treatedAreaHa]));
        expect(Number(area.get(parcelA))).toBe(1.5);
        expect(Number(area.get(parcelOtherBlock))).toBe(4.25);
        // Two TASKS, or "a different block" is not what this measured.
        expect(new Set(lines.map((l) => l.taskId)).size).toBe(2);
    });

    it('clears the area when a line is reverted to PENDING', async () => {
        const res = await recordDiaryTreatment(ctx(), {
            ...base([parcelA]),
            parcels: [{ parcelId: parcelA, treatedAreaHa: 5 }],
        });
        const [line] = await linesOf(res.taskIds);
        expect(Number(line.treatedAreaHa)).toBe(5);

        await markOperationParcel(ctx(), line.taskId, line.id, 'PENDING', undefined, line.version);

        const after = await prisma.operationParcel.findUnique({
            where: { id: line.id },
            select: { treatedAreaHa: true, status: true },
        });
        expect(after?.status).toBe('PENDING');
        expect(after?.treatedAreaHa).toBeNull();
    });

    it('a CORRECTION re-sending the displayed figure is a no-op (#2388)', async () => {
        // #2308's ruling applied to EQUALITY instead of to the bound, which is
        // what #2388 was. `parcelOdd` is 3.2478 ha and shows as 32,48 дка; a
        // form that re-sends what it displays returns 3.248 ha.
        //
        // Compared exactly, that read as a change on a parcel nobody touched:
        // the correction wrote a `TreatmentCorrection` row naming
        // `treatedAreaHa`, and bumped the group version — invalidating any
        // `If-Match` another client held, on a record a farmer signs.
        const handle = `${TAG}-noop-area`;
        await recordDiaryTreatment(
            ctx(),
            { ...base([parcelOdd]), parcels: [{ parcelId: parcelOdd, treatedAreaHa: 3.2478 }] },
            handle,
        );
        const before = await prisma.treatmentGroup.findUniqueOrThrow({
            where: { tenantId_id: { tenantId, id: handle } },
            select: { version: true },
        });

        // The displayed figure, typed back — a difference the register cannot
        // print.
        await correctDiaryTreatment(ctx(), handle, {
            parcels: [{ parcelId: parcelOdd, treatedAreaHa: 3.248 }],
        });

        const after = await prisma.treatmentGroup.findUniqueOrThrow({
            where: { tenantId_id: { tenantId, id: handle } },
            select: { version: true },
        });
        expect(after.version).toBe(before.version);
        const trail = await prisma.treatmentCorrection.count({
            where: { tenantId, groupId: handle },
        });
        expect(trail).toBe(0);
    });

    it('but a correction the register CAN print still lands', async () => {
        // The control. One дка hundredth is 32,48 vs 32,47 on the document, so
        // it is a real correction and must stay one — otherwise the fix above
        // would be a tolerance that swallows edits.
        const handle = `${TAG}-real-area`;
        await recordDiaryTreatment(
            ctx(),
            { ...base([parcelOdd]), parcels: [{ parcelId: parcelOdd, treatedAreaHa: 3.2478 }] },
            handle,
        );
        await correctDiaryTreatment(ctx(), handle, {
            parcels: [{ parcelId: parcelOdd, treatedAreaHa: 3.247 }],
        });
        const trail = await prisma.treatmentCorrection.findMany({
            where: { tenantId, groupId: handle },
            select: { changedFields: true },
        });
        expect(trail).toHaveLength(1);
        expect(trail[0].changedFields).toContain('treatedAreaHa');
    });
});
