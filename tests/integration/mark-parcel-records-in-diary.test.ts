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

let userId = '';
let unitId = '';
let tenantId = '';
let taskId = '';
let operatorLine = '';   // marked done WITHOUT the option -> entry stays hidden
let diaryLine = '';      // marked done WITH it            -> entry is visible

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
    const p1 = await globalPrisma.parcel.create({
        data: { tenantId, locationId: location.id, name: `P1 ${TAG}`, cropType: 'Wheat' },
    });
    const p2 = await globalPrisma.parcel.create({
        data: { tenantId, locationId: location.id, name: `P2 ${TAG}`, cropType: 'Wheat' },
    });
    const item = await globalPrisma.item.create({
        data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
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
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['StockTransaction', 'LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'AutomationExecution', 'TenantMembership']) {
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
        await markOperationParcel(ctx(), taskId, operatorLine, 'DONE', 'done in the field', 0);

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

    it('the DIARY path sets it, so the entry is visible despite its line', async () => {
        await markOperationParcel(ctx(), taskId, diaryLine, 'DONE', 'recorded in the diary', 0, {
            recordedInDiary: true,
        });

        const entry = await entryFor(diaryLine);
        expect(entry).not.toBeNull();
        expect(entry!.recordedInDiary).toBe(true);
        // Both halves of the #1740 case in one assertion: flagged AND linked.
        // An entry that was flagged but carried no line would prove nothing,
        // because it would be visible under the old rule too.
        expect(entry!.operationParcelId).toBe(diaryLine);
    });
});
