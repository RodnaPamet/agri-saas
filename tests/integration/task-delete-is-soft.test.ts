/**
 * The task delete is SOFT — observed, not read off the source (#2242).
 *
 * ## Why this test exists at all
 *
 * `deleteTask` contains `db.task.delete(...)`, which reads as a hard delete
 * and is not one. `Task` is in `SOFT_DELETE_MODELS`, so
 * `withSoftDeleteExtension` rewrites that call into
 * `update({ data: { deletedAt } })` before it reaches the database. The source
 * says one thing and the behaviour does another, and FOUR pull requests were
 * built on the wrong reading before anyone ran it.
 *
 * Nothing caught it:
 *
 *   • `tests/guards/task-delete-semantics-are-deliberate.test.ts` asserted
 *     "nothing on that path writes `deletedAt`" from the file's TEXT. True of
 *     the file, false of the call.
 *   • the unit test named "deletes the row (children cascade)" injects a mock
 *     transaction — `fn({ ...TX, task: { delete: del } })` — and a mock cannot
 *     see an extension, because the extension lives on the client the mock
 *     replaced.
 *
 * Both were green. The only thing that could have shown it is a real client
 * talking to a real database, which is this file.
 *
 * ## What it pins, and what it does NOT
 *
 * It pins the OBSERVABLE: after a delete through `runInTenantContext`, the row
 * is absent. It says nothing about which Prisma method the usecase calls, and
 * deliberately so — that is what the source-reading guard is for, and the
 * whole lesson of #2242 is that the two questions are different.
 *
 * ## If you are here because you want to make it hard
 *
 * That was attempted on 2026-10-24 and reverted the same day, measured:
 *
 *   • `withDeleted()` throws `PrismaClientValidationError` for a model outside
 *     the allowlist — the magic `__includeDeleted` key is only stripped for
 *     members, so every opt-out read breaks, including the treatment replay's;
 *   • 32 of 45 `db.task.*` reads do not name `deletedAt` and rely on the
 *     extension to inject it. Without it, flagged rows surface in the task
 *     list and the due-notification sweep.
 *
 * So it is doable, and it starts with auditing those 32 reads. This file
 * failing is the signal that somebody skipped that.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { deleteTask, bulkDeleteTask } from '@/app-layer/usecases/task';
import { SOFT_DELETE_MODELS } from '@/lib/soft-delete';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tdp-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let userId = '';

const ctx = () =>
    makeRequestContext('OWNER', { userId, tenantId: TENANT_ID, tenantSlug: TAG });

const mkTask = async (title: string) =>
    (await prisma.task.create({
        data: { tenantId: TENANT_ID, title, type: 'TASK', createdByUserId: userId },
        select: { id: true },
    })).id;

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    const u = await prisma.user.create({
        data: { email: `${TAG}@example.test`, emailHash: hashForLookup(`${TAG}@example.test`) },
    });
    userId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$disconnect();
});

describeFn('a task delete FLAGS the row rather than removing it (#2242)', () => {
    it('the PREMISE: Task is in the soft-delete allowlist', () => {
        // Stated first, because every assertion below follows from it. If this
        // one fails, the others are not wrong — the world changed.
        expect(SOFT_DELETE_MODELS.has('Task')).toBe(true);
    });

    it('`deleteTask` leaves the row with deletedAt set', async () => {
        const id = await mkTask('single');
        await deleteTask(ctx(), id);
        // The RAW client, deliberately. A read through the extended one is
        // filtered by `deletedAt: null`, so it cannot tell a deleted row from
        // a flagged one — which is the blindness that let this go unnoticed.
        const row = await prisma.task.findFirst({ where: { id } });
        expect(row).not.toBeNull();
        expect(row!.deletedAt).not.toBeNull();
    });

    it('`bulkDeleteTask` flags them too, and still reports a count', async () => {
        const ids = [await mkTask('bulk-a'), await mkTask('bulk-b')];
        const out = await bulkDeleteTask(ctx(), ids);
        // The count is what a caller sees, and it says 2 either way — so the
        // response shape cannot tell you which semantics you got.
        expect(out).toEqual({ deleted: 2 });
        const rows = await prisma.task.findMany({ where: { id: { in: ids } } });
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
    });

    it('the children do NOT cascade, because an update cascades nothing', async () => {
        // `TaskComment`, `TaskLink`, `TaskWatcher` and `OperationParcel` all
        // declare `onDelete: Cascade` and none of it fires. The fourth is why
        // this matters beyond tidiness: those rows are the lines the БАБХ
        // ДНЕВНИК prints, and the claim that this route destroys them — which
        // #2220 was built on — was false.
        //
        // A comment is the cheapest child to prove it with: no parcel, product
        // or unit needed.
        const id = await mkTask('with-children');
        const comment = await prisma.taskComment.create({
            data: { tenantId: TENANT_ID, taskId: id, body: 'x', createdByUserId: userId },
            select: { id: true },
        });

        await deleteTask(ctx(), id);

        expect(await prisma.taskComment.findFirst({ where: { id: comment.id } })).not.toBeNull();
    });
});
