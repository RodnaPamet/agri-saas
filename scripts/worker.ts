/**
 * BullMQ Worker — Standalone Process Entrypoint
 *
 * Processes async jobs from the `inflect-jobs` queue.
 * Runs independently of the Next.js web server.
 *
 * Usage:
 *   npx tsx scripts/worker.ts
 *   # or in production:
 *   node --import tsx scripts/worker.ts
 *
 * Architecture:
 *   - Creates its own Redis connection (not the app singleton)
 *   - Registers processors for each typed job name
 *   - Delegates to existing business logic functions (preserving observability)
 *   - Graceful shutdown on SIGTERM/SIGINT
 *   - Structured logging via Pino
 *
 * @module scripts/worker
 */
import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import {
    QUEUE_NAME,
    SOIL_QUEUE_NAME,
    type JobName,
} from '../src/app-layer/jobs/types';
import { assertProductionEncryptionReady } from '../src/lib/security/startup-gate';

// ─── Standalone logger ───

const log = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' } }
        : undefined,
});

// ─── Redis connection ───

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    log.fatal('REDIS_URL is not set. Cannot start worker.');
    process.exit(1);
}

function createWorkerConnection(): Redis {
    return new Redis(REDIS_URL!, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 10000,
        connectionName: 'inflect-worker',
    });
}

// ═══════════════════════════════════════════════════════════════════
// Job Processing — Executor Registry Delegation
//
// All job dispatch is handled by the executor registry in the
// app-layer. The worker simply delegates to it. Adding a new job
// only requires registering it in executor-registry.ts — no
// worker changes needed.
//
// The registry is imported lazily (dynamic import) so that Prisma
// and other heavy modules are only loaded when the first job runs.
// ═══════════════════════════════════════════════════════════════════

// ─── Worker Bootstrap ───

/**
 * Wire the automation bus to BullMQ so any domain event emitted from inside a
 * job (e.g. a usecase running inside a scheduled sweep) fans back into the
 * dispatch queue, and swap the mailer to SMTP.
 *
 * AWAITED before any Worker is constructed (#698). This was a non-awaited
 * async IIFE, so a job could be claimed before it finished — and both halves
 * matter for correctness, not just tidiness:
 *
 *   · without `installAutomationBusDispatcher`, an automation event emitted by
 *     that job has nowhere to go and is silently dropped;
 *   · without `initMailerFromEnv`, the worker is still on the console sink, and
 *     the notification outbox + digests it runs "send" mail that never leaves.
 *
 * (`installRlsTripwire` is a documented no-op kept for call-site compatibility,
 * so nothing isolation-critical was ever in this race — checked, not assumed.)
 */
async function bootstrapWorkerRuntime(): Promise<void> {
    const { installAutomationBusDispatcher } = await import(
        '../src/app-layer/automation/bus-bootstrap'
    );
    const { installRlsTripwire } = await import(
        '../src/lib/db/rls-middleware'
    );
    const { prisma } = await import('../src/lib/prisma');
    installAutomationBusDispatcher();
    installRlsTripwire(prisma);
    const { initMailerFromEnv } = await import('../src/lib/mailer');
    initMailerFromEnv();
    log.info('automation bus dispatcher + RLS tripwire + mailer installed');
}

let connection: Redis;

// Shared processor — dispatches to the executor registry. Reused by both the
// main worker and the dedicated soil worker (they differ only in the queue
// they drain and their rate limiter).
async function processJob(job: Job) {
    const jobName = job.name as JobName;

    // Lazy-import the executor registry on first job
    const { executorRegistry } = await import('../src/app-layer/jobs/executor-registry');

    if (!executorRegistry.has(jobName)) {
        log.warn({ jobName, jobId: job.id }, 'no executor registered for job — skipping');
        return { skipped: true, reason: `no executor for "${jobName}"` };
    }

    const startTime = performance.now();

    log.info({ jobName, jobId: job.id, payload: job.data }, 'processing job');

    // GAP-22: forward the BullMQ Job's progress channel so
    // executors that report mid-run progress (currently
    // tenant-dek-rotation) surface it via `GET .../?jobId=…`
    // without depending on bullmq from the executor side.
    const result = await executorRegistry.execute(jobName, job.data, {
        updateProgress: (p) => job.updateProgress(p as object | number),
    });
    const durationMs = Math.round(performance.now() - startTime);

    if (!result.success) {
        log.error({
            jobName,
            jobId: job.id,
            attemptsMade: job.attemptsMade,
            durationMs,
            errorMessage: result.errorMessage,
        }, 'job processing failed');

        throw new Error(result.errorMessage || `Job "${jobName}" failed`);
    }

    log.info({
        jobName,
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        durationMs,
        itemsScanned: result.itemsScanned,
        itemsActioned: result.itemsActioned,
    }, 'job processed successfully');

    return result;
}

let worker: Worker;
let soilWorker: Worker;

/**
 * Construct both workers and attach their event handlers.
 *
 * Called only from `main()`, only AFTER the startup gate and the runtime
 * bootstrap have resolved. Constructing a `Worker` is what subscribes to the
 * queue, so this is the exact line that must not run early (#698).
 */
function startWorkers(): void {
    worker = new Worker(
        QUEUE_NAME,
        processJob,
        {
            connection,
            concurrency: 5,
            limiter: {
                max: 50,
                duration: 60000,
            },
        },
    );

    // Dedicated soil-fetch worker — its own queue + a 5/min limiter so we
    // honour the SoilGrids beta REST fair-use budget without throttling
    // other jobs.
    soilWorker = new Worker(
        SOIL_QUEUE_NAME,
        processJob,
        {
            connection: createWorkerConnection(),
            concurrency: 2,
            limiter: {
                max: 5,
                duration: 60000,
            },
        },
    );

    attachWorkerEvents();
}

// ─── Worker Events ───

function attachWorkerEvents(): void {

worker.on('ready', () => {
    log.info({
        queueName: QUEUE_NAME,
        note: 'Dispatch via executor-registry (lazy-loaded on first job)',
    }, 'worker ready — listening for jobs');
});

soilWorker.on('ready', () => {
    log.info({ queueName: SOIL_QUEUE_NAME, note: 'rate-limited 5/min' }, 'soil worker ready');
});
soilWorker.on('failed', (job, error) => {
    log.error({ jobName: job?.name, jobId: job?.id, err: error }, 'soil job failed');
});
soilWorker.on('error', (error) => {
    log.error({ err: error }, 'soil worker error');
});

worker.on('failed', (job, error) => {
    log.error({
        jobName: job?.name,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }, 'job failed (BullMQ event)');
});

worker.on('stalled', (jobId) => {
    log.warn({ jobId }, 'job stalled — will be retried');
});

worker.on('error', (error) => {
    log.error({
        err: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }, 'worker error');
});

}

// ─── Graceful Shutdown ───

async function shutdown(signal: string) {
    log.info({ signal }, 'shutdown signal received — closing worker');

    try {
        // Optional-chained: a SIGTERM can arrive while `main()` is still in
        // the startup gate, before either worker exists. Before #698 these
        // were constructed at module scope so they were always defined by the
        // time a handler could fire; now they are not, and a shutdown that
        // threw here would exit 1 on an orderly stop.
        await Promise.all([worker?.close(), soilWorker?.close()]);
        await connection?.quit();
        log.info('worker shut down gracefully');
        process.exit(0);
    } catch (error) {
        log.error({ err: error }, 'error during shutdown');
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Startup, in the order the checks are meant to happen (#698).
 *
 * Nothing below the gate runs on a process that cannot encrypt at rest, and
 * nothing subscribes to a queue before the runtime is wired. Previously all
 * three of these raced: two non-awaited async IIFEs against a module body that
 * constructed both Workers synchronously.
 */
async function main(): Promise<void> {
    await assertProductionEncryptionReady(log, process.env);
    log.info(
        { queueName: QUEUE_NAME, redisUrl: REDIS_URL!.replace(/\/\/.*@/, '//***@') },
        'starting worker',
    );
    await bootstrapWorkerRuntime();
    connection = createWorkerConnection();
    startWorkers();
    log.info('worker process started — press Ctrl+C to stop');
}

main().catch((err) => {
    log.fatal({ err }, 'worker failed to start');
    process.exit(1);
});
