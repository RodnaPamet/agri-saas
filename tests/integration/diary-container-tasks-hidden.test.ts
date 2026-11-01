/**
 * A recorded activity is a Дневник entry, not three rows in Задачи (#2696).
 *
 * Owner, 2026-11-01, on «Обработка на почвата — 20688.13»: *"This can not be
 * printed and also is in tasks and in journal as well — does the journal page
 * only contain journals or not?"* It was in both because `recordFarmActivity`
 * creates one `FIELD_OPERATION` task per block as the container the register's
 * lines hang off, and those containers were listed as work.
 *
 * DB-backed, because the thing worth proving is not the where-clause's text —
 * `tests/guards/diary-container-visibility.test.ts` already reads that — but
 * that a recorded activity is absent from the lists a person sees WHILE the
 * record and the deep link survive. Three of those four facts are invisible to
 * a source scan.
 *
 * ## Every absence here is paired with a presence
 *
 * A filter that returned nothing would satisfy "the containers are absent"
 * perfectly. So an ordinary farm task is created alongside and asserted
 * PRESENT in the same reads, in every case. That control is the half that can
 * fail if the clause is wrong rather than merely strict.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordFarmActivity } from '@/app-layer/usecases/farm-activity';
import { listTasks, listTasksForParcel } from '@/app-layer/usecases/task';
import { createFarmTask, listMyFarmTasks } from '@/app-layer/usecases/farm-task';
import { listLogEntries } from '@/app-layer/usecases/journal';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `dct-${randomUUID().slice(0, 8)}`;
let userId = '';
let tenantId = '';
let locA = '';
let parcelA1 = '';
let parcelB1 = '';
let handle = '';
let ordinaryTaskId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Diary User' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    locA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    const locB = (await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } })).id;
    parcelA1 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `A1 ${TAG}`, areaHa: 8 },
    })).id;
    parcelB1 = (await globalPrisma.parcel.create({
        data: { tenantId, locationId: locB, name: `B1 ${TAG}`, areaHa: 5 },
    })).id;

    // The record: one activity, two blocks, so TWO containers.
    const rec = await recordFarmActivity(
        ctx(),
        { kind: 'CULTIVATE', occurredOn: yesterday(), parcelIds: [parcelA1, parcelB1] },
        `${TAG}-cultivate`,
    );
    handle = rec.treatmentGroupId;

    // The control: a real task, on the SAME parcel as one container, so a
    // parcel-scoped read cannot pass by returning nothing.
    ordinaryTaskId = (await createFarmTask(ctx(), {
        title: `Ordinary ${TAG}`,
        farmTaskType: 'IRRIGATION',
        parcelIds: [parcelA1],
        // ASSIGNED to the same person, and that is the point rather than
        // setup detail. `listMyFarmTasks({ scope: 'mine' })` filters to the
        // caller's own work, so an unassigned control asserted over an empty
        // list — which this test caught by failing `toContain` before it ever
        // reached the absence. More importantly it makes the queue the
        // sharpest of the four reads: a container is ALSO assigned to the
        // recorder, so «mine» holds two kinds of row assigned to one person
        // and only the marker separates them.
        assigneeUserId: userId,
    })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['LogQuantity', 'LogEntry', 'OperationParcel', 'TaskLink', 'Task', 'TreatmentGroup', 'Parcel', 'Location', 'Notification', 'AuditLog']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        // The membership and the tenant CANNOT be removed from here, and that
        // is by design rather than a gap in this teardown: Epic 1's
        // `LAST_OWNER_GUARD` trigger raises P0001 on any DELETE or UPDATE
        // leaving a tenant with zero active OWNERs, and this tenant has
        // exactly one member. The FK then restricts the `Tenant` delete.
        //
        // So the rows are left, deliberately and narrowly. Only that one
        // trigger is tolerated — anything else propagates, because the
        // neighbouring suites wrap their whole teardown in a bare catch, and a
        // swallowed teardown is how this failure first presented as
        // `TenantMembership_tenantId_fkey` with no mention of the real cause.
        try {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
        } catch (err) {
            if (!String((err as { message?: string }).message ?? err).includes('LAST_OWNER_GUARD')) throw err;
        }
    } finally {
        await globalPrisma.$disconnect();
    }
});

describeFn('#2696 — a diary record stays in Дневник and out of Задачи', () => {
    it('wrote two containers, so the absences below have something to be absent', async () => {
        // Without this the whole file could pass against a record that was
        // never created — the shape of green that means nothing.
        const containers = await globalPrisma.task.findMany({
            where: { tenantId, treatmentGroupId: handle },
            select: { id: true, assigneeUserId: true, dueAt: true, type: true },
        });
        expect(containers).toHaveLength(2);
        // Both facts the hiding rule leans on, asserted rather than trusted:
        // the container is assigned to the RECORDER (so hiding it takes nobody's
        // job away) and carries NO dueAt (which is why the calendar and the two
        // notification jobs could not have reached it even before this change).
        expect(containers.every((t) => t.assigneeUserId === userId)).toBe(true);
        expect(containers.every((t) => t.dueAt === null)).toBe(true);
        expect(containers.every((t) => t.type === 'FIELD_OPERATION')).toBe(true);
    });

    it('GET /tasks shows the ordinary task and neither container', async () => {
        const rows = (await listTasks(ctx(), {}, { take: 100 })) as Array<{ id: string }>;
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(ordinaryTaskId);
        expect(ids).toHaveLength(1);
    });

    it("the mechanisator queue and the manager queue both omit them", async () => {
        for (const scope of ['mine', 'all'] as const) {
            const rows = (await listMyFarmTasks(ctx(), { scope })) as Array<{ id: string }>;
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(ordinaryTaskId);
            expect(ids).toHaveLength(1);
        }
    });

    it("a parcel's tasks omit the container that touches that very parcel", async () => {
        // `parcelA1` carries BOTH the ordinary task and one container, which is
        // what makes this read the sharpest of the four: a rule keyed on
        // anything but the group marker would take the ordinary task with it.
        const { rows } = await listTasksForParcel(ctx(), parcelA1);
        const ids = (rows as Array<{ id: string }>).map((r) => r.id);
        expect(ids).toContain(ordinaryTaskId);
        expect(ids).toHaveLength(1);
    });

    it('the Дневник entries survive — the record itself is untouched', async () => {
        // The other half of the owner's question. Hiding the bookkeeping must
        // not touch the thing being booked.
        const entries = (await listLogEntries(ctx(), {})) as unknown as Array<{ id: string }>;
        expect(entries.length).toBeGreaterThanOrEqual(2);
    });

    it('a container still resolves BY ID, so a deep link is not dead', async () => {
        const one = await globalPrisma.task.findFirst({
            where: { tenantId, treatmentGroupId: handle },
            select: { id: true },
        });
        // Read through the same privileged client a single-task route would
        // reach: the rule is about LISTS, and #2220's 409 is what explains the
        // row once it opens.
        const direct = await globalPrisma.task.findUnique({
            where: { id: one!.id },
            select: { id: true, treatmentGroupId: true },
        });
        expect(direct?.treatmentGroupId).toBe(handle);
    });

    describe('mutation proof — each assertion can fail', () => {
        it('a container given a dueAt is STILL absent from the lists', async () => {
            // The calendar and both notification jobs filter on a clause that
            // excludes nothing today, because a container has no dueAt. This
            // stamps one, which is the only way to tell a live clause from a
            // decorative one: before the filters existed, this row would have
            // appeared as work due tomorrow.
            const one = await globalPrisma.task.findFirst({
                where: { tenantId, treatmentGroupId: handle },
                select: { id: true },
            });
            await globalPrisma.task.update({
                where: { id: one!.id },
                data: { dueAt: new Date(Date.now() + 86_400_000) },
            });
            try {
                const rows = (await listTasks(ctx(), { due: 'next7d' }, { take: 100 })) as Array<{ id: string }>;
                expect(rows.map((r) => r.id)).not.toContain(one!.id);
            } finally {
                await globalPrisma.task.update({ where: { id: one!.id }, data: { dueAt: null } });
            }
        });

        it('clearing the marker makes a container visible again', async () => {
            // Proves the LISTS are keyed on `treatmentGroupId` and nothing
            // else — a rule that happened to hide these rows for another
            // reason (their type, their status, their assignee) would keep
            // hiding this one.
            const one = await globalPrisma.task.findFirst({
                where: { tenantId, treatmentGroupId: handle },
                select: { id: true },
            });
            await globalPrisma.task.update({
                where: { id: one!.id },
                data: { treatmentGroupId: null },
            });
            try {
                const rows = (await listTasks(ctx(), {}, { take: 100 })) as Array<{ id: string }>;
                expect(rows.map((r) => r.id)).toContain(one!.id);
            } finally {
                await globalPrisma.task.update({
                    where: { id: one!.id },
                    data: { treatmentGroupId: handle },
                });
            }
        });
    });
});
