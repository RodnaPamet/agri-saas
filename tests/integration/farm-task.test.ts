/**
 * Farm tasks — DB-backed integration tests.
 *
 * Coverage
 * --------
 *   1. createFarmTask reuses the IC Task module: it writes a FARM_TASK
 *      Task with the LiteFarm-catalog type/category in metadataJson, and
 *      TaskLink rows to Location / Parcel / Equipment (the freshly-widened
 *      enum values).
 *   2. The task surfaces in the existing compliance calendar (loadTaskEvents
 *      already sweeps every Task with a dueAt — no farm-specific change).
 *   3. listMyFarmTasks returns the operator's farm queue.
 *   4. An invalid (foreign-tenant) link is rejected BEFORE any task is
 *      created — no orphan.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createFarmTask, listMyFarmTasks } from '@/app-layer/usecases/farm-task';
import { getCalendarEvents } from '@/app-layer/usecases/calendar';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `ftask-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const OTHER_TENANT_ID = `t-${TAG}-2`;

let ownerId = '';
let operatorId = '';
let locationId = '';
let parcelId = '';
let equipmentId = '';
let foreignEquipmentId = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    return u.id;
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    for (const [id, slug] of [[TENANT_ID, TAG], [OTHER_TENANT_ID, `${TAG}-2`]] as const) {
        await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug } });
    }
    ownerId = await makeUser('owner');
    operatorId = await makeUser('operator');
    await prisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: operatorId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
        ],
    });

    const location = await prisma.location.create({ data: { tenantId: TENANT_ID, name: `Field ${TAG}` } });
    locationId = location.id;
    const parcel = await prisma.parcel.create({ data: { tenantId: TENANT_ID, locationId, name: `P-${TAG}`, areaHa: 3 } });
    parcelId = parcel.id;
    // Machines live in `Asset` since the Equipment merge.
    const equip = await prisma.asset.create({ data: { tenantId: TENANT_ID, name: `Tractor ${TAG}`, type: 'TRACTOR' } });
    equipmentId = equip.id;
    // An equipment row in ANOTHER tenant — must be rejected as a link target.
    const foreign = await prisma.asset.create({ data: { tenantId: OTHER_TENANT_ID, name: `Foreign ${TAG}`, type: 'TRACTOR' } });
    foreignEquipmentId = foreign.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            for (const t of [TENANT_ID, OTHER_TENANT_ID]) {
                await tx.$executeRawUnsafe(`DELETE FROM "TaskLink" WHERE "tenantId" = $1`, t);
                await tx.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" = $1`, t);
            }
        });
    } catch {
        /* globalSetup handles reset */
    }
    await prisma.$disconnect();
});

const ownerCtx = () => makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });
const operatorCtx = () => makeRequestContext('EDITOR', { userId: operatorId, tenantId: TENANT_ID, tenantSlug: TAG });

describeFn('farm tasks (DB)', () => {
    let taskId = '';

    test('createFarmTask writes a FARM_TASK + metadata + Location/Parcel/Equipment links', async () => {
        const ctx = ownerCtx();
        const task = await createFarmTask(ctx, {
            title: `Irrigate ${TAG}`,
            farmTaskType: 'IRRIGATION',
            priority: 'P1',
            dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
            assigneeUserId: operatorId,
            locationIds: [locationId],
            parcelIds: [parcelId],
            equipmentIds: [equipmentId],
        });
        taskId = task.id;

        const row = await prisma.task.findUnique({
            where: { id: task.id },
            select: { type: true, assigneeUserId: true, metadataJson: true },
        });
        expect(row!.type).toBe('FARM_TASK');
        expect(row!.assigneeUserId).toBe(operatorId);
        expect(row!.metadataJson).toMatchObject({ farmTaskType: 'IRRIGATION', farmTaskCategory: 'IRRIGATION' });

        const links = await prisma.taskLink.findMany({
            where: { tenantId: TENANT_ID, taskId: task.id },
            select: { entityType: true, entityId: true },
        });
        const byType = new Map(links.map((l) => [l.entityType, l.entityId]));
        expect(byType.get('LOCATION')).toBe(locationId);
        expect(byType.get('PARCEL')).toBe(parcelId);
        expect(byType.get('EQUIPMENT')).toBe(equipmentId);
    });

    test('the farm task surfaces in the compliance calendar (dueAt in range)', async () => {
        const ctx = ownerCtx();
        const from = new Date(Date.now() - 86_400_000);
        const to = new Date(Date.now() + 30 * 86_400_000);
        const res = await getCalendarEvents(ctx, { from, to });
        const hit = res.events.find((e) => e.entityType === 'TASK' && e.entityId === taskId);
        expect(hit).toBeDefined();
        // A FARM_TASK now carries its own event type and category rather than
        // impersonating a compliance task — that distinction is the point of
        // the farm-work vocabulary change, so assert the new value.
        expect(hit!.type).toBe('farm-task-due');
        expect(hit!.category).toBe('farm-task');
    });

    test('listMyFarmTasks returns the operator’s queue', async () => {
        const queue = await listMyFarmTasks(operatorCtx());
        expect(queue.map((t) => t.id)).toContain(taskId);
    });

    test('an invalid (foreign-tenant) equipment link is rejected with no orphan task', async () => {
        const ctx = ownerCtx();
        const before = await prisma.task.count({ where: { tenantId: TENANT_ID } });
        await expect(
            createFarmTask(ctx, {
                title: `Bad link ${TAG}`,
                farmTaskType: 'SCOUTING',
                equipmentIds: [foreignEquipmentId],
            }),
        ).rejects.toThrow(/INVALID_LINK|Equipment not found/);
        const after = await prisma.task.count({ where: { tenantId: TENANT_ID } });
        expect(after).toBe(before); // no orphan task created
    });

    test('an unknown farm task type is rejected', async () => {
        await expect(
            createFarmTask(ownerCtx(), { title: 'x', farmTaskType: 'NOT_A_REAL_TYPE' }),
        ).rejects.toThrow(/INVALID_FARM_TASK_TYPE|Unknown farm task type/);
    });
});
