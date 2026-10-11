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

/**
 * `REDIS_URL_TEST` is checked FIRST and is what CI sets — deliberately not
 * `REDIS_URL`.
 *
 * `getRedisClient()` in `src/lib/redis.ts` returns `null` when `REDIS_URL` is
 * unset, and the entire suite leans on that graceful-degradation path. The
 * first version of this change set `REDIS_URL` job-wide; every Redis-aware
 * code path in every suite switched to opening real connections and shard
 * runtime went from ~500s to the 35-minute job timeout. Two shards were
 * cancelled, which surfaces as a red check with no failing test.
 *
 * So: this test gets its own variable, read here and nowhere else in the repo.
 * `REDIS_URL` is still honoured as a fallback for a local run where it happens
 * to be set, but CI must never set it for the jest job.
 */
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

    describe('failure-code stamping (#1447)', () => {
        let queue: Queue | undefined;
        let worker: Worker | undefined;

        afterAll(async () => {
            await worker?.close().catch(() => undefined);
            await queue?.close().catch(() => undefined);
        });

        it('updateData round-trips a failure stamp and PRESERVES the payload', async () => {
            if (!redisAvailable) return;

            // `job.updateData` is a BullMQ verb `scripts/worker.ts` now calls,
            // so by this file's own rule it belongs here. It is also the only
            // transport a failure CODE has: BullMQ persists `err.message` as
            // `failedReason` and has no second field, so the worker writes the
            // code into `job.data` and the poll route reads it back out.
            //
            // Two things have to hold and neither is ours to assume. The stamp
            // must survive the write, and the PAYLOAD must survive it too —
            // the poll routes read `job.data.tenantId` to prove the job is
            // yours, so a clobbered payload would turn every subsequent poll
            // into a 404 and look exactly like a tenant-isolation bug.
            const { withFailureStamp } = await import('../../src/app-layer/jobs/failure-stamp');
            const { readFailureStamp } = await import('../../src/app-layer/jobs/failure-stamp');

            const QN = `${QUEUE}-stamp`;
            queue = new Queue(QN, { connection: conn() });

            // Shape copied from `processJob` in scripts/worker.ts: stamp, then
            // throw — the throw is what makes BullMQ record `failedReason`.
            worker = new Worker(
                QN,
                async (job) => {
                    await job.updateData(
                        withFailureStamp(job.data, {
                            code: 'SPATIAL_IMPORT_TOO_COMPLEX',
                            params: { vertices: 812_340, limit: 500_000 },
                        }),
                    );
                    throw new Error('Import is too complex (812340 vertices; limit is 500000).');
                },
                { connection: conn(), concurrency: 1 },
            );

            const failed = new Promise<void>((resolve, reject) => {
                worker!.on('failed', () => resolve());
                worker!.on('completed', () => reject(new Error('job completed; it was meant to fail')));
            });

            const added = await queue.add(
                'smoke-stamp',
                { tenantId: 'tenant-1', locationId: 'loc-1', filename: 'parcels.zip' },
                { attempts: 1 },
            );
            await failed;

            // Re-read through the queue, the way the poll route does.
            const reread = await queue.getJob(String(added.id));
            expect(reread).toBeDefined();

            const data = reread!.data as Record<string, unknown>;
            // The payload survived — this is the tenant pin.
            expect(data.tenantId).toBe('tenant-1');
            expect(data.locationId).toBe('loc-1');
            expect(data.filename).toBe('parcels.zip');

            // And the code came back out, gated on the real BullMQ state.
            const state = await reread!.getState();
            expect(state).toBe('failed');
            expect(readFailureStamp(data, state)).toEqual({
                failedCode: 'SPATIAL_IMPORT_TOO_COMPLEX',
                failedParams: { vertices: 812_340, limit: 500_000 },
            });

            // `failedReason` still carries the English, as the fallback.
            expect(reread!.failedReason).toContain('too complex');

            // Positive control: the SAME data read in a non-failed state
            // publishes nothing — so the assertion above is testing the stamp
            // and not merely that the fields exist.
            expect(readFailureStamp(data, 'completed')).toEqual({
                failedCode: null,
                failedParams: null,
            });
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

    /**
     * The worker heartbeat (#809), end to end against a real Redis.
     *
     * The wiring guard (`tests/guards/worker-heartbeat-wiring.test.ts`) pins
     * all four links as SOURCE TEXT and executes none of them. That is the
     * right tool for "the link is present" and no proof at all that a
     * `health-check` job actually reaches `completed` — and if it does not,
     * nothing ever beats and the container is unhealthy forever while every
     * static check stays green.
     *
     * The specific doubt worth settling: the schedule enqueues
     * `health-check` with an EMPTY payload, so a dispatch path that needed a
     * `tenantId` would throw, emit `failed` instead of `completed`, and break
     * the chain at the one link a regex cannot see.
     */
    describe('worker heartbeat', () => {
        let queue: Queue | undefined;
        let worker: Worker | undefined;

        afterAll(async () => {
            await worker?.close().catch(() => undefined);
            await queue?.close().catch(() => undefined);
        });

        it('the REAL health-check executor succeeds on the REAL schedule payload', async () => {
            if (!redisAvailable) return;

            const { executorRegistry } = await import('../../src/app-layer/jobs/executor-registry');
            const { ALL_SCHEDULES } = await import('../../src/app-layer/jobs/schedules');

            const schedule = ALL_SCHEDULES.find((s) => s.name === 'health-check');
            // Positive control: without this, a renamed schedule makes the
            // assertion below run on `undefined` and prove nothing.
            expect(schedule).toBeDefined();

            // Pin what the scheduler actually enqueues, then execute exactly
            // that — so this test cannot drift from production's payload.
            expect(schedule!.defaultPayload).toEqual({});

            const result = await executorRegistry.execute(
                'health-check',
                {},
                { updateProgress: async () => undefined },
            );

            // `processJob` throws when `success` is false, which is what turns
            // a job into `failed` rather than `completed`.
            expect(result.success).toBe(true);
        }, 30_000);

        it('a completed job writes the heartbeat key the probe reads, with a TTL', async () => {
            if (!redisAvailable) return;

            const { beat, WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } = await import(
                '../../src/app-layer/jobs/worker-heartbeat'
            );

            const client = conn();
            await client.del(WORKER_HEARTBEAT_KEY);
            // Positive control: prove the key is absent BEFORE the job, so a
            // leftover key from another run cannot pass this for us.
            expect(await client.get(WORKER_HEARTBEAT_KEY)).toBeNull();

            queue = new Queue(QUEUE + '-hb', { connection: conn() });
            const beatConnection = conn();

            worker = new Worker(QUEUE + '-hb', async () => ({ ok: true }), {
                connection: conn(),
                concurrency: 5,
            });

            // The wiring under test, copied from scripts/worker.ts.
            const beaten = new Promise<void>((resolve, reject) => {
                worker!.on('completed', () => {
                    void beat(beatConnection).then(resolve, reject);
                });
                worker!.on('failed', (_j, err) => reject(err ?? new Error('job failed')));
            });

            await queue.add('health-check', {});
            await beaten;

            const value = await client.get(WORKER_HEARTBEAT_KEY);
            expect(value).not.toBeNull();
            expect(Number(value)).toBeGreaterThan(0);

            // A key with no expiry would report healthy forever after the
            // worker died — ioredis returns -1 for "no TTL".
            const ttl = await client.ttl(WORKER_HEARTBEAT_KEY);
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThanOrEqual(WORKER_HEARTBEAT_TTL_SECONDS);

            await client.del(WORKER_HEARTBEAT_KEY);
        }, 30_000);
    });
});
