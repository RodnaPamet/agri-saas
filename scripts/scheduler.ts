#!/usr/bin/env tsx
/**
 * BullMQ Scheduler — Register Repeatable Jobs
 *
 * Reads the schedule definitions from `src/app-layer/jobs/schedules.ts`
 * and registers them as BullMQ repeatable jobs. Idempotent: BullMQ
 * deduplicates repeatables by job name + cron pattern.
 *
 * Usage:
 *   npx tsx scripts/scheduler.ts                # register all schedules
 *   npx tsx scripts/scheduler.ts --list         # list current repeatables
 *   npx tsx scripts/scheduler.ts --clean        # remove all repeatables
 *
 * This script runs once and exits — it is NOT a long-running process.
 * The worker (`scripts/worker.ts`) is the long-running process that
 * picks up and processes the scheduled jobs.
 *
 * Typical deployment:
 *   1. npx tsx scripts/scheduler.ts     ← run once on deploy
 *   2. npx tsx scripts/worker.ts        ← run as daemon
 *
 * @module scripts/scheduler
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { QUEUE_NAME } from '../src/app-layer/jobs/types';
import { SCHEDULED_JOBS } from '../src/app-layer/jobs/schedules';
import { assertProductionEncryptionReady } from '../src/lib/security/startup-gate';

// ─── Logger ───

const log = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' } }
        : undefined,
});

// ─── Redis ───

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    log.fatal('REDIS_URL is not set. Cannot register schedules.');
    process.exit(1);
}

async function main() {
    // ─── GAP-03: production encryption-key fail-fast ───────────────
    //
    // The scheduler is short-lived (runs once on deploy, exits) and does
    // not itself decrypt any column — it only registers BullMQ repeatable
    // jobs. But it shares the prod-deploy pipeline with the long-running
    // worker, so a missing or bad key here is a strong signal that the
    // worker will fail too. Refusing to register schedules in that state
    // surfaces the misconfiguration on the deploy that introduces it, not
    // three jobs later.
    //
    // AWAITED, and that is the fix (#698). This ran in a non-awaited async
    // IIFE at module scope, so `main()` had already logged "registering
    // repeatable jobs" before the refusal printed.
    await assertProductionEncryptionReady(log, process.env);

    const args = process.argv.slice(2);
    const listOnly = args.includes('--list');
    const cleanAll = args.includes('--clean');

    const connection = new Redis(REDIS_URL!, {
        maxRetriesPerRequest: null,
        connectTimeout: 10000,
    });

    const queue = new Queue(QUEUE_NAME, { connection });

    try {
        if (listOnly) {
            await listRepeatables(queue);
            return;
        }

        if (cleanAll) {
            await removeAll(queue);
            return;
        }

        await registerAll(queue);
    } finally {
        await queue.close();
        await connection.quit();
    }
}

async function registerAll(queue: Queue): Promise<void> {
    log.info({ count: SCHEDULED_JOBS.length }, 'registering repeatable jobs');

    for (const schedule of SCHEDULED_JOBS) {
        // BullMQ upserts repeatables — if the same name+pattern exists, it's a no-op
        // An entry's `tz` (or the legacy `options.tz`) is passed into
        // the BullMQ repeat options so the cron `pattern` is evaluated
        // in that zone — task-due-notification fires at 08:00 local.
        const tz = schedule.tz ?? schedule.options?.tz;
        await queue.upsertJobScheduler(
            schedule.name,
            {
                pattern: schedule.pattern,
                ...(tz ? { tz } : {}),
                ...(schedule.options?.limit ? { limit: schedule.options.limit } : {}),
            },
            {
                name: schedule.name,
                data: schedule.defaultPayload,
            },
        );

        log.info({
            jobName: schedule.name,
            pattern: schedule.pattern,
            ...(tz ? { tz } : {}),
            description: schedule.description,
        }, 'repeatable registered');
    }

    log.info('all schedules registered ✓');
}

async function listRepeatables(queue: Queue): Promise<void> {
    const schedulers = await queue.getJobSchedulers();
    if (schedulers.length === 0) {
        log.info('no repeatable jobs registered');
        return;
    }

    log.info({ count: schedulers.length }, 'current repeatable jobs:');
    for (const s of schedulers) {
        log.info({
            name: s.name,
            pattern: s.pattern,
            next: s.next ? new Date(s.next).toISOString() : 'not set',
        }, 'repeatable');
    }
}

async function removeAll(queue: Queue): Promise<void> {
    const schedulers = await queue.getJobSchedulers();
    log.info({ count: schedulers.length }, 'removing all repeatable jobs');

    for (const s of schedulers) {
        await queue.removeJobScheduler(s.name ?? '');
        log.info({ name: s.name }, 'removed');
    }

    log.info('all repeatables removed ✓');
}

main().catch(err => {
    log.fatal({ err }, 'scheduler failed');
    process.exit(1);
});
