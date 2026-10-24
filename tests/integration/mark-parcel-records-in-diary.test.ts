/**
 * The `recordedInDiary` thread, end to end (DB-backed) — #1740.
 *
 * Marking an operation line DONE is what emits its INPUT_APPLICATION journal
 * entry, via `recordInputApplication`. The two-step treatment record needs
 * that entry flagged as diary-recorded so the manual-only journal list shows
 * it; the operator path — a line completed from a task in Zadachi — must stay
 * unflagged and therefore hidden, which is the 2026-10-10 ruling.
 *
 * The flag travels
 *   `markOperationParcel(opts)` -> `recordInputApplication(line)`
 *   -> `createLogEntryWithAudit` -> `JournalRepository.create` -> the column
 *
 * which is four hand-offs, any one of which could drop it while every type
 * still checks. So both directions are asserted here rather than only the new
 * one: a thread that silently defaults to `true` would un-hide every
 * operator-completed spray in the farm, which is the worse failure and the
 * one no type would catch.
 *
 * Set at WRITE time rather than UPDATEd after: a second write would leave a
 * window in which the entries exist and are invisible.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { markOperationParcel } from '@/app-layer/usecases/field-operation';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `diaryflag-${randomUUID().slice(0, 8)}`;
/**
 * A day firmly in the past, for the backdating case. Fixed rather than
 * computed from `now`, so the assertion cannot drift into passing because the
 * difference happens to be small.
 */
const TREATMENT_DAY = new Date('2026-03-04T00:00:00.000Z');

let userId = '';
let unitId = '';
let tenantId = '';
let taskId = '';
let operatorLine = '';   // marked done WITHOUT the option -> entry stays hidden
let diaryLine = '';      // marked done WITH it            -> entry is visible
let backdatedLine = ''; // marked done for a PAST day      -> dates follow the treatment

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Diary Flag User' },
    })).id;
    unitId = (await globalPrisma.unit.create({
        data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
    })).id;
    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const location = await globalPrisma.location.create({ data: { tenantId, name: `Block ${TAG}` } });
    // areaHa is REQUIRED for this fixture to be able to deduct at all.
    // `recordInputApplication` computes `consumed` as dose x the TREATED area
    // (`treatedAreaHa ?? areaHa` since #2284), and reads a
    // null area as 0 — so with no area the operator control deducted nothing
    // and the "diary does not deduct" assertion passed for the wrong reason.
    // Measured: the control failed with `consumed: 0` until this was set.
    const p1 = await globalPrisma.parcel.create({
        data: { tenantId, locationId: location.id, name: `P1 ${TAG}`, cropType: 'Wheat', areaHa: 10 },
    });
    const p2 = await globalPrisma.parcel.create({
        data: { tenantId, locationId: location.id, name: `P2 ${TAG}`, cropType: 'Wheat', areaHa: 10 },
    });
    const p3 = await globalPrisma.parcel.create({
        data: { tenantId, locationId: location.id, name: `P3 ${TAG}`, cropType: 'Wheat', areaHa: 10 },
    });
    const item = await globalPrisma.item.create({
        data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    });
    // A lot on the product, so `getFefoLot` finds one and a deduction is
    // POSSIBLE. Without it, "the diary did not deduct" would be
    // indistinguishable from "there was nothing to deduct from".
    //
    // `quantityOnHand` is set here only to clear `getFefoLot`'s `> 0` filter.
    // It is NOT a meaningful balance: the column is a denormalised ledger sum
    // "refreshed only by the ledger writer" (InventoryRepository), so setting
    // it without a matching RECEIPT transaction leaves it inconsistent with
    // the ledger, and the first consumption recomputes it from a ledger this
    // fixture never populated.
    //
    // Measured, after briefly mistaking it for a product bug: with an opening
    // 500 and one 20-unit consumption the row read -20, not 480 — the
    // recompute is correct and the fixture was wrong. Hence the assertions
    // below are on the TRANSACTIONS, which are the direct evidence, rather
    // than on a balance this fixture is not entitled to.
    await globalPrisma.inventoryLot.create({
        data: {
            tenantId, itemId: item.id, quantityOnHand: 500, unitId,
            lotCode: `LOT-${TAG}`, receivedAt: new Date('2026-01-01'),
        },
    });
    const task = await globalPrisma.task.create({
        data: {
            tenantId, title: `Spray ${TAG}`, type: 'FIELD_OPERATION',
            createdByUserId: userId, assigneeUserId: userId,
        },
    });
    taskId = task.id;
    const mkLine = async (parcelId: string) =>
        (await globalPrisma.operationParcel.create({
            data: {
                tenantId, taskId, parcelId, productItemId: item.id,
                doseValue: 2, doseUnitId: unitId, status: 'PENDING',
            },
        })).id;
    operatorLine = await mkLine(p1.id);
    diaryLine = await mkLine(p2.id);
    backdatedLine = await mkLine(p3.id);

    // BOTH MARKS HAPPEN HERE, AND THE DIARY ONE GOES FIRST. Order is
    // load-bearing, which it should not have to be and does.
    //
    // `quantityOnHand` is a denormalised ledger sum, so the operator's
    // draw-down recomputes this lot to a NEGATIVE balance (the fixture never
    // posted a receipt). `getFefoLot` requires `> 0`, so after that draw-down
    // there is no lot to deduct from at all — and a diary mark running second
    // would appear suppressed whether or not the suppression exists.
    //
    // Measured, not reasoned: with the operator first, REMOVING the
    // suppression entirely left all four cases green. The diary mark has to
    // run while stock is still available for its assertion to mean anything.
    await markOperationParcel(ctx(), taskId, diaryLine, 'DONE', 'recorded in the diary', 0, {
        recordedInDiary: true,
    });
    await markOperationParcel(ctx(), taskId, operatorLine, 'DONE', 'done in the field', 0);
    await markOperationParcel(ctx(), taskId, backdatedLine, 'DONE', 'recorded later', 0, {
        recordedInDiary: true,
        occurredAt: TREATMENT_DAY,
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['StockTransaction', 'InventoryLot', 'LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'AutomationExecution', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

const entryFor = async (lineId: string) =>
    globalPrisma.logEntry.findFirst({
        where: { tenantId, operationParcelId: lineId, type: 'INPUT_APPLICATION' },
        select: { id: true, recordedInDiary: true, operationParcelId: true },
    });

describeFn('recordedInDiary reaches the journal entry a mark emits (DB-backed)', () => {
    it('the OPERATOR path leaves it false, so the entry stays hidden', async () => {
        const entry = await entryFor(operatorLine);
        expect(entry).not.toBeNull();
        // The direction that matters most. A thread defaulting to true would
        // un-hide every operator-completed spray on the farm — a silent
        // widening, and the kind of regression a type cannot catch.
        expect(entry!.recordedInDiary).toBe(false);
        // It really does carry a line, so `false` here is a decision and not
        // an artefact of there being nothing to hide.
        expect(entry!.operationParcelId).toBe(operatorLine);
    });

    it('the OPERATOR path DOES deduct, which is the control for the next case', async () => {
        // Asserted so that the diary case below proves a suppression rather
        // than an absence. Without this, a farm where nothing ever deducts
        // would satisfy both.
        const tx = await globalPrisma.stockTransaction.findMany({
            where: { tenantId, type: 'CONSUMPTION', logEntry: { operationParcelId: operatorLine } },
            select: { id: true, quantityDelta: true },
        });
        // Exactly one draw-down, for the operator's line. 2 L/ha over 10 ha.
        expect(tx).toHaveLength(1);
        expect(Number(tx[0].quantityDelta)).toBeLessThan(0);
    });

    it('the DIARY path sets it, so the entry is visible despite its line', async () => {
        const entry = await entryFor(diaryLine);
        expect(entry).not.toBeNull();
        expect(entry!.recordedInDiary).toBe(true);
        // Both halves of the #1740 case in one assertion: flagged AND linked.
        // An entry that was flagged but carried no line would prove nothing,
        // because it would be visible under the old rule too.
        expect(entry!.operationParcelId).toBe(diaryLine);
    });

    it('a backdated treatment dates BOTH the entry and the line by its own day', async () => {
        // agrent-ios's flag, and the reason it matters: `JournalRepository`
        // defaults `occurredAt` to now and `markOperationParcel` stamped
        // `completedAt` with now, so a treatment recorded for a past day
        // would sort as today's and fall OUTSIDE a period filter — silently
        // absent from the register for the period it happened in.
        const entry = await entryFor(backdatedLine);
        expect(entry).not.toBeNull();

        const full = await globalPrisma.logEntry.findUniqueOrThrow({
            where: { id: entry!.id },
            select: { occurredAt: true },
        });
        expect(full.occurredAt.toISOString()).toBe(TREATMENT_DAY.toISOString());

        // And the LINE agrees with it. The register joins the two, so a line
        // stamped today against an entry dated March would disagree inside
        // one document.
        const line = await globalPrisma.operationParcel.findUniqueOrThrow({
            where: { id: backdatedLine },
            select: { completedAt: true },
        });
        expect(line.completedAt?.toISOString()).toBe(TREATMENT_DAY.toISOString());
    });

    it('an operator mark still uses NOW, not a backdate', async () => {
        // The control. Without it, defaulting everything to a fixed past date
        // would satisfy the case above.
        const line = await globalPrisma.operationParcel.findUniqueOrThrow({
            where: { id: operatorLine },
            select: { completedAt: true },
        });
        expect(line.completedAt).not.toBeNull();
        expect(line.completedAt!.getTime()).toBeGreaterThan(TREATMENT_DAY.getTime());
    });

    it('the DIARY path does NOT deduct stock — owner ruling 2026-10-13', async () => {
        // The Дневник is a compliance record; stock stays managed through
        // Задачи and adjustments. The product HAS a 500-unit lot, so this is
        // a suppression and not an empty-shelf artefact — the operator case
        // above deducted from the same lot.
        const txForDiary = await globalPrisma.stockTransaction.findMany({
            where: { tenantId, type: 'CONSUMPTION', logEntry: { operationParcelId: diaryLine } },
            select: { id: true },
        });
        expect(txForDiary).toEqual([]);

        // And the farm has exactly ONE consumption in total — the operator's.
        // Asserted as a total rather than only as an absence on the diary
        // line, so a second draw-down appearing anywhere else would fail here
        // too.
        const all = await globalPrisma.stockTransaction.findMany({
            where: { tenantId, type: 'CONSUMPTION' },
            select: { id: true },
        });
        expect(all).toHaveLength(1);
    });
});

describeFn('the recorded quantity follows the TREATED area (DB-backed, #2284)', () => {
    /**
     * A fresh parcel and line per case, rather than the shared fixture's.
     *
     * The marks in `beforeAll` happen in a load-bearing ORDER — the diary mark
     * has to run while stock is still available, or its suppression assertion
     * proves nothing — so adding a case to that sequence would put a second
     * constraint on an order that already barely holds.
     *
     * Note which branch this exercises. The fixture's unit key is `l-ha-<tag>`,
     * which is NOT in the conversion catalogue, so `isRateUnit` is false and the
     * computation takes the LEGACY `dose * area` fallback. That is deliberate
     * here: the fallback is the arm an unregistered unit lands in, it is the one
     * most likely to be left behind by a fix to the typed arms, and it is what
     * this farm's own units would hit.
     */
    const freshLine = async (name: string, dose = 2) => {
        const src = await globalPrisma.operationParcel.findUnique({
            where: { id: operatorLine },
            select: { productItemId: true, parcel: { select: { locationId: true } } },
        });
        const parcel = await globalPrisma.parcel.create({
            data: {
                tenantId,
                locationId: src!.parcel.locationId!,
                name: `${name} ${TAG}`,
                cropType: 'Wheat',
                areaHa: 10,
            },
        });
        return (await globalPrisma.operationParcel.create({
            data: {
                tenantId,
                taskId,
                parcelId: parcel.id,
                productItemId: src!.productItemId,
                doseValue: dose,
                doseUnitId: unitId,
                status: 'PENDING',
            },
        })).id;
    };

    const quantityOn = async (lineId: string) => {
        const entry = await globalPrisma.logEntry.findFirst({
            where: { tenantId, operationParcelId: lineId, type: 'INPUT_APPLICATION' },
            select: { quantities: { select: { value: true } } },
        });
        expect(entry).not.toBeNull();
        expect(entry!.quantities).toHaveLength(1);
        return Number(entry!.quantities[0].value);
    };

    it('a PARTIAL treated area records the PARTIAL quantity', async () => {
        // The whole of #2284. 2 L/ha over 2 of a 10 ha block is 4 L; before the
        // fix this entry said 20 — the quantity of a treatment of the whole
        // block, on a line whose own column says 2 ha, in a record an inspector
        // reads. Reachable from the phone since 20 October.
        const line = await freshLine('P-partial');
        await markOperationParcel(ctx(), taskId, line, 'DONE', 'partly treated', 0, {
            recordedInDiary: true,
            treatedAreaHa: 2,
        });
        expect(await quantityOn(line)).toBe(4);
    });

    it('a WHOLE-parcel line still records the whole parcel — the control', async () => {
        // Without this, a fix that read zero, or the line's area, or nothing at
        // all would satisfy the case above. This is the operator path through
        // Задачи, where `treatedAreaHa` is always null and the parcel area is
        // the right answer.
        const line = await freshLine('P-whole');
        await markOperationParcel(ctx(), taskId, line, 'DONE', 'treated whole', 0, {
            recordedInDiary: true,
        });
        expect(await quantityOn(line)).toBe(20);
    });

    it('the TREATED area is read from the ROW, not from the mark options', async () => {
        // The third arm of the caller's three-way branch: `treatedAreaHa` was
        // set on an EARLIER write and this mark does not mention it, so the
        // column keeps its value and the quantity must still honour it.
        //
        // Reconstructing the area from `opts` would pass both cases above and
        // fail this one — which is why the computation re-reads the row inside
        // the same transaction instead of trusting the caller's literal.
        const line = await freshLine('P-preset');
        await globalPrisma.operationParcel.update({
            where: { id: line },
            data: { treatedAreaHa: 3 },
        });
        await markOperationParcel(ctx(), taskId, line, 'DONE', 'area set earlier', 0, {
            recordedInDiary: true,
        });
        expect(await quantityOn(line)).toBe(6);
    });
});
