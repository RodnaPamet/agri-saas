/**
 * A background job can create a `Task` — #2729.
 *
 * `Task.createdByUserId` is `String` NOT NULL with an FK to `User` via
 * `TaskCreator`, and `retention-notifications` omitted it behind an
 * any-cast. So the write typechecked and would have failed at RUNTIME, which
 * is the one state no unit test in this repo could observe: every suite over
 * that job mocks Prisma, so a double accepted the incomplete payload and the
 * FK was never consulted.
 *
 * #2729 recorded that honestly — "Measured, in this repo today: Prisma rejects
 * a create missing a NOT NULL column with no default... Inferred, not yet
 * measured on this call site." This file is what turns the inference into a
 * measurement: a real database, the real job, and a row that either appears or
 * does not.
 *
 * ## The positive control is the whole point
 *
 * "No task was created" and "the job found no expiring evidence" are the same
 * observation, so every case below asserts a task EXISTS before asserting
 * anything about its creator. A suite that only checked `createdByUserId`
 * would pass just as happily against a job that did nothing at all.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { runEvidenceRetentionNotifications } from '@/app-layer/jobs/retention-notifications';
import {
    systemUserEmail,
    isSystemUserEmail,
    __resetSystemUserCache,
} from '@/lib/auth/system-user';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `sysusr-${randomUUID().slice(0, 8)}`;

let tenantA = '';
let tenantB = '';
const evidenceIds: string[] = [];
const taskIds: string[] = [];
const createdUserIds: string[] = [];

/** Expiring inside the job's 30-day default window. */
function inTenDays(): Date {
    return new Date(Date.now() + 10 * 86_400_000);
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    __resetSystemUserCache();
    for (const slug of [`${TAG}-a`, `${TAG}-b`]) {
        const t = await prisma.tenant.create({
            data: { name: slug, slug },
            select: { id: true },
        });
        if (!tenantA) tenantA = t.id;
        else tenantB = t.id;
    }
    for (const [tid, label] of [[tenantA, 'A'], [tenantB, 'B']] as const) {
        const ev = await prisma.evidence.create({
            data: {
                tenantId: tid,
                type: 'FILE',
                title: `${TAG} expiring ${label}`,
                retentionUntil: inTenDays(),
            },
            select: { id: true },
        });
        evidenceIds.push(ev.id);
    }
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    // Links first (FK), then tasks, then evidence, then the system users, then tenants.
    await prisma.taskLink.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } }).catch(() => {});
    await prisma.evidence.deleteMany({ where: { id: { in: evidenceIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }).catch(() => {});
});

describeFn('a background job authors a Task through the system user', () => {
    it('creates the task at all — the write that used to be impossible', async () => {
        const out = await runEvidenceRetentionNotifications({ tenantId: tenantA });

        // POSITIVE CONTROL first: without this, every assertion below is
        // satisfied by a job that selected nothing.
        expect(out.tasksCreated).toBe(1);

        const task = await prisma.task.findFirst({
            where: { tenantId: tenantA, links: { some: { entityId: evidenceIds[0] } } },
            select: { id: true, createdByUserId: true },
        });
        expect(task).not.toBeNull();
        taskIds.push(task!.id);

        // The FK is satisfied by a row that actually exists.
        const creator = await prisma.user.findUnique({
            where: { id: task!.createdByUserId },
            select: { id: true, email: true, passwordHash: true, emailVerified: true },
        });
        expect(creator).not.toBeNull();
        createdUserIds.push(creator!.id);

        expect(creator!.email).toBe(systemUserEmail(tenantA));
        expect(isSystemUserEmail(creator!.email)).toBe(true);
    });

    it('the system user cannot sign in — no password, no verified address', async () => {
        /*
         * `passwordHash: null` refuses the credentials provider, and the
         * address is under an RFC 2606 `.invalid` domain so it can never
         * resolve — which is what stops an OAuth sign-in matching it by email.
         * Both halves, because either alone leaves a way in.
         */
        const creator = await prisma.user.findFirst({
            where: { emailHash: hashForLookup(systemUserEmail(tenantA)) },
            select: { passwordHash: true, emailVerified: true, email: true },
        });
        expect(creator).not.toBeNull();
        expect(creator!.passwordHash).toBeNull();
        expect(creator!.emailVerified).toBeNull();
        expect(creator!.email.endsWith('@jobs.invalid')).toBe(true);
    });

    it('is PER TENANT — two farms get two different actors', async () => {
        /*
         * One farm proves nothing: a single shared actor would satisfy a
         * one-tenant assertion. Two farms is the arrangement the per-tenant
         * decision exists for, and it is also what keeps "which farm's job
         * wrote this" answerable in the audit trail.
         */
        const out = await runEvidenceRetentionNotifications({ tenantId: tenantB });
        expect(out.tasksCreated).toBe(1);

        const taskB = await prisma.task.findFirst({
            where: { tenantId: tenantB, links: { some: { entityId: evidenceIds[1] } } },
            select: { id: true, createdByUserId: true },
        });
        expect(taskB).not.toBeNull();
        taskIds.push(taskB!.id);

        const taskA = await prisma.task.findFirst({
            where: { tenantId: tenantA, links: { some: { entityId: evidenceIds[0] } } },
            select: { createdByUserId: true },
        });
        expect(taskA).not.toBeNull();
        expect(taskB!.createdByUserId).not.toBe(taskA!.createdByUserId);

        const userB = await prisma.user.findUnique({
            where: { id: taskB!.createdByUserId },
            select: { id: true, email: true },
        });
        createdUserIds.push(userB!.id);
        expect(userB!.email).toBe(systemUserEmail(tenantB));
    });

    it('is idempotent across runs — the row is reused, not minted again', async () => {
        // The memo is per process; the DB lookup is what makes a cold process
        // reuse rather than fail on the unique `emailHash`.
        __resetSystemUserCache();
        const before = await prisma.user.count({
            where: { emailHash: hashForLookup(systemUserEmail(tenantA)) },
        });
        expect(before).toBe(1);

        await runEvidenceRetentionNotifications({ tenantId: tenantA });

        const after = await prisma.user.count({
            where: { emailHash: hashForLookup(systemUserEmail(tenantA)) },
        });
        expect(after).toBe(1);
    });
});
