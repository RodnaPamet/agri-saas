/**
 * Integration tests for the `task-due-notification` job.
 *
 * Proves the end-to-end path against a real database: real `Task`
 * rows, `processTaskDueNotifications` invoked directly, real
 * `Notification` rows written — and the `dedupeKey` unique index
 * enforcing idempotency when the job re-runs the same UTC day.
 *
 * BullMQ is bypassed — the job's pure function is exercised directly,
 * so no Redis connection is needed.
 */

import { randomUUID } from 'node:crypto';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenant, createUser } from '../helpers/factories';
import { processTaskDueNotifications } from '@/app-layer/jobs/task-due-notification';

// The `beforeEach` resets ~30 tables via `resetDatabase` + a raw
// TRUNCATE. Under a loaded CI run that reset can transiently block
// on lock contention past Jest's 5 s hook default — raise the
// per-file budget so a slow reset doesn't flake the suite.
jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('task-due-notification (integration)', () => {
    const prisma = prismaTestClient() as PrismaClient;

    /** Anchor — 08:00 UTC, the cron firing time. */
    const NOW = new Date('2026-05-20T08:00:00.000Z');

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await resetDatabase(prisma);
        // `Notification` is not in resetDatabase's table list — clear
        // it so the dedupeKey idempotency test starts from zero rows.
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "Notification" CASCADE');
    });

    /** A tenant + user pair with collision-proof identifiers. */
    async function seedTenant() {
        const tenant = await createTenant(prisma, {
            id: randomUUID(),
            slug: `inflect-ltd-${randomUUID().slice(0, 8)}`,
        });
        const user = await createUser(prisma, {
            id: randomUUID(),
            email: `${randomUUID()}@test.local`,
        });
        return { tenant, user };
    }

    /** `dueAt` at midday on the calendar day `offset` days from NOW. */
    function dueInDays(offset: number): Date {
        return new Date(NOW.getTime() + offset * 86_400_000 + 6 * 3_600_000);
    }

    function createTask(input: {
        tenantId: string;
        userId: string;
        dueAt: Date;
        title: string;
        status?: string;
        assigned?: boolean;
    }) {
        return prisma.task.create({
            data: {
                tenantId: input.tenantId,
                title: input.title,
                createdByUserId: input.userId,
                assigneeUserId: input.assigned === false ? null : input.userId,
                dueAt: input.dueAt,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...(input.status ? { status: input.status as any } : {}),
            },
        });
    }

    test('creates a TASK_DUE notification for a task due today', async () => {
        const { tenant, user } = await seedTenant();
        const task = await createTask({
            tenantId: tenant.id,
            userId: user.id,
            dueAt: dueInDays(0),
            title: 'Submit SOC 2 evidence',
        });

        const result = await processTaskDueNotifications(prisma, {
            tenantId: tenant.id,
            now: NOW,
        });

        expect(result.created).toBe(1);

        const notifs = await prisma.notification.findMany({
            where: { tenantId: tenant.id },
        });
        expect(notifs).toHaveLength(1);
        expect(notifs[0]).toMatchObject({
            userId: user.id,
            type: 'TASK_DUE',
            title: 'Task due today',
            linkUrl: `/t/${tenant.slug}/farm-tasks/${task.id}`,
            read: false,
        });
        expect(notifs[0].dedupeKey).toContain(':TASK_DUE:today:');
    });

    test('fires the one-week, one-day and due-day windows; ignores other days', async () => {
        const { tenant, user } = await seedTenant();
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(7), title: 'week task' });
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(1), title: 'day task' });
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(0), title: 'today task' });
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(3), title: 'day-3 task' });

        const result = await processTaskDueNotifications(prisma, {
            tenantId: tenant.id,
            now: NOW,
        });

        expect(result.created).toBe(3);
        expect(result.byWindow).toEqual({ week: 1, day: 1, today: 1 });
        const notifs = await prisma.notification.findMany({
            where: { tenantId: tenant.id },
        });
        expect(notifs).toHaveLength(3);
    });

    test('re-running the same UTC day is idempotent — the dedupeKey index absorbs the repeat', async () => {
        const { tenant, user } = await seedTenant();
        await createTask({
            tenantId: tenant.id,
            userId: user.id,
            dueAt: dueInDays(0),
            title: 'idempotent task',
        });

        const first = await processTaskDueNotifications(prisma, { tenantId: tenant.id, now: NOW });
        const second = await processTaskDueNotifications(prisma, { tenantId: tenant.id, now: NOW });

        expect(first.created).toBe(1);
        expect(second.created).toBe(0);
        expect(second.skippedDuplicate).toBe(1);

        const notifs = await prisma.notification.findMany({
            where: { tenantId: tenant.id },
        });
        expect(notifs).toHaveLength(1);
    });

    test('skips terminal-status and unassigned tasks', async () => {
        const { tenant, user } = await seedTenant();
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(0), title: 'open task' });
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(0), title: 'closed task', status: 'CLOSED' });
        await createTask({ tenantId: tenant.id, userId: user.id, dueAt: dueInDays(0), title: 'unassigned task', assigned: false });

        const result = await processTaskDueNotifications(prisma, {
            tenantId: tenant.id,
            now: NOW,
        });

        expect(result.created).toBe(1);
        const notifs = await prisma.notification.findMany({
            where: { tenantId: tenant.id },
        });
        expect(notifs).toHaveLength(1);
        expect(notifs[0].message).toContain('open task');
    });

    test('system-wide scan notifies across multiple tenants', async () => {
        const a = await seedTenant();
        const b = await seedTenant();
        await createTask({ tenantId: a.tenant.id, userId: a.user.id, dueAt: dueInDays(0), title: 'tenant A task' });
        await createTask({ tenantId: b.tenant.id, userId: b.user.id, dueAt: dueInDays(1), title: 'tenant B task' });

        const result = await processTaskDueNotifications(prisma, { now: NOW });

        expect(result.created).toBe(2);
        const aNotifs = await prisma.notification.findMany({ where: { tenantId: a.tenant.id } });
        const bNotifs = await prisma.notification.findMany({ where: { tenantId: b.tenant.id } });
        expect(aNotifs).toHaveLength(1);
        expect(bNotifs).toHaveLength(1);
        expect(aNotifs[0].tenantId).toBe(a.tenant.id);
        expect(bNotifs[0].tenantId).toBe(b.tenant.id);
    });
});
