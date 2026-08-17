/**
 * BullMQ real-API smoke test — the ONLY place the queue library is executed.
 *
 * Why this exists. `tests/integration/bullmq-queue.test.ts` and
 * `bullmq-scheduler.test.ts` both open with `jest.mock('bullmq', …)`, and
 * `redis-connection.test.ts` maps `ioredis` to `ioredis-mock`. They are good
 * tests of OUR wiring and they never execute one line of BullMQ. Nothing else
 * does either: `scripts/worker.ts` and `scripts/scheduler.ts` — the two files
 * that actually construct a `Worker` and register schedulers — sit outside
 * `tsconfig.json`, so even `tsc` never looks at them.
 *
 * The cost of that showed up on the 5 → 6 major bump (PR #576). Every one of
 * the 19 checks passed, and the pass meant nothing: a rewritten `Queue`
 * constructor, a renamed scheduler verb, or a changed `getJobSchedulers()`
 * return shape would all have sailed through green and surfaced as a worker
 * that will not start behind a perfectly healthy web tier. The bump was
 * verified by hand against a real Redis before merging. This file is that
 * check, made repeatable.
 *
 * Scope is deliberately narrow: the API surface `src/app-layer/jobs/queue.ts`,
 * `scripts/worker.ts` and `scripts/scheduler.ts` actually call, in the call
 * SHAPES they use. It is not a test of BullMQ's semantics — upstream owns
 * those — it is a tripwire for the contract we depend on. When you add a new
 * BullMQ verb to any of those three files, add it here too.
 *
 * NO MOCKS. A `jest.mock('bullmq')` in this file would defeat its entire
 * purpose; the guard below asserts the real module is loaded.
 */
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL_TEST || process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/**
 * Escalation flag, mirroring `RLS_GUARDRAIL_REQUIRE_DB` in
 * `tests/guardrails/rls-coverage.test.ts`. CI runs a `redis:7-alpine`
 * service, so there a skip is a BUG, not an environment fact — set this and
 * the suite fails loudly instead of quietly reporting green.
 */
const REQUIRE_REDIS = process.env.BULLMQ_SMOKE_REQUIRE_REDIS === '1';

/** Probe Redis once, with a short timeout — a missing local Redis must not hang the suite. */
async function probeRedis(): Promise<boolean> {
    const client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
        retryStrategy: () => null,
    });
    try {
        await client.connect();
        await client.ping();
        return true;
    } catch {
        return false;
    } finally {
        client.disconnect();
    }
}

let redisAvailable = false;
beforeAll(async () => {
    redisAvailable = await probeRedis();
});

// Unique per run so a crashed previous run cannot poison this one, and so two
// concurrent runs (local + CI, or two jest workers) never share queue state.
const QUEUE = `bullmq-smoke-${process.pid}-${process.env.JEST_WORKER_ID ?? '1'}`;

/**
 * BullMQ does NOT own a connection you hand it — `Queue.close()` /
 * `Worker.close()` leave an externally-supplied ioredis client open. Left
 * alone that produces "A worker process has failed to exit gracefully", which
 * this repo has already been bitten by once: a leaked handle killed a jest
 * WORKER while the tests themselves passed, so CI showed a flaky shard with no
 * failure summary (see the `@/lib/storage` note in CLAUDE.md). Track every
 * client and quit them explicitly.
 */
const openConnections: IORedis[] = [];
const conn = () => {
    const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    openConnections.push(c);
    return c;
};

afterAll(async () => {
    await Promise.all(openConnections.map((c) => c.quit().catch(() => c.disconnect())));
    openConnections.length = 0;
});

describe('bullmq real-API smoke', () => {
    /**
     * Always runs. A skipped suite and a passing suite are indistinguishable in
     * a CI summary, so the non-execution is made visible here rather than
     * inferred from an absence.
     */
    it('reports whether the real-API checks executed', async () => {
        if (!redisAvailable) {
            const banner =
                `\n${'='.repeat(72)}\n` +
                `BULLMQ SMOKE DID NOT RUN — no Redis at ${REDIS_URL}\n` +
                `The real-API checks below are SKIPPED. A green run here is NOT\n` +
                `evidence that bullmq works. Start one with:\n` +
                `  docker run -d --rm -p 6379:6379 redis:7-alpine\n` +
                `or set BULLMQ_SMOKE_REQUIRE_REDIS=1 to make this a failure.\n` +
                `${'='.repeat(72)}\n`;
            // eslint-disable-next-line no-console
            console.warn(banner);
            if (REQUIRE_REDIS) {
                throw new Error(
                    `BULLMQ_SMOKE_REQUIRE_REDIS=1 but no Redis reachable at ${REDIS_URL}. ` +
                        `CI declares a redis service — if this fires there, the service is ` +
                        `missing or misconfigured, not absent by design.`,
                );
            }
        }
        expect(typeof redisAvailable).toBe('boolean');
    });

    it('loads the REAL bullmq module, not a mock', () => {
        // If someone adds `jest.mock('bullmq')` to this file, every assertion
        // below becomes a tautology. Catch that directly.
        expect(jest.isMockFunction(Queue)).toBe(false);
        expect(jest.isMockFunction(Worker)).toBe(false);
        expect(Queue.name).toBe('Queue');
        expect(Worker.name).toBe('Worker');
    });

    describe('queue + worker round trip', () => {
        let queue: Queue | undefined;
        let worker: Worker | undefined;

        afterAll(async () => {
            await worker?.close().catch(() => undefined);
            await queue?.close().catch(() => undefined);
        });

        it('constructs a Queue with the options queue.ts passes, enqueues, and a Worker processes it', async () => {
            if (!redisAvailable) return;

            // Shape copied from `getQueue()` in src/app-layer/jobs/queue.ts.
            queue = new Queue(QUEUE, {
                connection: conn(),
                defaultJobOptions: {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 },
                    removeOnComplete: 500,
                    removeOnFail: 1000,
                },
            });

            let seen: unknown = null;
            // Shape copied from `new Worker(...)` in scripts/worker.ts.
            worker = new Worker(
                QUEUE,
                async (job) => {
                    seen = job.data;
                    return { ok: true };
                },
                { connection: conn(), concurrency: 5, limiter: { max: 50, duration: 60_000 } },
            );

            const completed = new Promise<void>((resolve, reject) => {
                worker!.on('completed', () => resolve());
                worker!.on('failed', (_j, err) => reject(err ?? new Error('job failed')));
            });

            await queue.add('smoke', { hello: 'world' });
            await completed;

            expect(seen).toEqual({ hello: 'world' });
        }, 30_000);
    });

    describe('job scheduler API', () => {
        let queue: Queue | undefined;
        afterAll(async () => {
            await queue?.removeJobScheduler('smoke-nightly').catch(() => undefined);
            await queue?.close().catch(() => undefined);
        });

        it('upserts, lists and removes a scheduler in the shape scheduler.ts uses', async () => {
            if (!redisAvailable) return;
            queue = new Queue(`${QUEUE}-sched`, { connection: conn() });

            // Shape copied from scripts/scheduler.ts.
            await queue.upsertJobScheduler(
                'smoke-nightly',
                { pattern: '0 2 * * *', tz: 'Europe/Sofia', limit: 10 },
                { name: 'smoke-nightly', data: { kind: 'smoke' } },
            );

            const schedulers = await queue.getJobSchedulers();
            const found = schedulers.find((s) => s.name === 'smoke-nightly');
            expect(found).toBeDefined();

            // scheduler.ts reads exactly these three fields, and does
            // `new Date(s.next)` — so `next` being a number is load-bearing,
            // not incidental.
            expect(found?.pattern).toBe('0 2 * * *');
            expect(typeof found?.next).toBe('number');

            await queue.removeJobScheduler('smoke-nightly');
            const after = await queue.getJobSchedulers();
            expect(after.some((s) => s.name === 'smoke-nightly')).toBe(false);
        }, 30_000);
    });
});
