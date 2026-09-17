/**
 * Container healthcheck for the `worker` service (#809).
 *
 * Exits 0 if the worker has completed a job recently, 1 otherwise. Reads the
 * key `worker.ts` refreshes from BullMQ's `completed` event, so a pass means
 * the worker pulled a job off the queue, ran it and came back — not merely
 * that a process is alive.
 *
 * WHY THIS SHAPE. Docker healthchecks run a COMMAND inside the container, and
 * the worker serves no HTTP, so there is nothing to curl. This bundles to
 * `dist/worker-healthcheck.mjs` alongside worker.mjs and scheduler.mjs, which
 * is why it can `import` from `src/` — esbuild inlines it, and the runner
 * image carries no source tree.
 *
 * WHAT A FAILURE MEANS. The key is TTL'd, never deleted, so `EXISTS` going to
 * 0 is the whole signal: four consecutive missed beats. Causes are all worth
 * knowing about — a blocked event loop, a severed Redis connection, every
 * concurrency slot held by a hung handler, or a scheduler that never
 * registered the `health-check` repeatable that drives the beat.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not enqueue anything. A probe that
 * creates work would add load proportional to how often it runs and, worse,
 * would go on passing while the worker's own consumption was dead — it would
 * be testing Redis, not the worker. It only READS.
 */
import Redis from 'ioredis';

import {
    WORKER_HEARTBEAT_KEY,
    WORKER_HEARTBEAT_TTL_SECONDS,
} from '../src/app-layer/jobs/worker-heartbeat';

const CONNECT_TIMEOUT_MS = 5_000;

async function main(): Promise<number> {
    const url = process.env.REDIS_URL;
    if (!url) {
        // Fail, do not skip. A missing REDIS_URL in the worker container is
        // itself a broken worker, and reporting healthy on a missing variable
        // is the same silent pass this whole issue is about.
        process.stderr.write('worker-healthcheck: REDIS_URL is not set\n');
        return 1;
    }

    const redis = new Redis(url, {
        connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // one attempt; the healthcheck itself retries
        lazyConnect: true,
    });

    // ioredis emits 'error' on a failed connect, and an unhandled error event
    // prints its own stack over ours — and on some Node versions is fatal.
    // Swallowed so the diagnosis below is what an operator reads; `connect()`
    // still rejects, which is what decides the exit code.
    redis.on('error', () => {});

    try {
        await redis.connect();
        const raw = await redis.get(WORKER_HEARTBEAT_KEY);
        if (raw === null) {
            process.stderr.write(
                `worker-healthcheck: no heartbeat — ${WORKER_HEARTBEAT_KEY} is absent or expired ` +
                    `(TTL ${WORKER_HEARTBEAT_TTL_SECONDS}s). The worker has not completed a job ` +
                    `in that window: check a blocked event loop, a dead Redis connection, hung ` +
                    `handlers holding every concurrency slot, or a scheduler that never ` +
                    `registered the health-check repeatable.\n`,
            );
            return 1;
        }
        const ageMs = Date.now() - Number(raw);
        process.stdout.write(`worker-healthcheck: ok, last completion ${Math.round(ageMs / 1000)}s ago\n`);
        return 0;
    } catch (err) {
        process.stderr.write(
            `worker-healthcheck: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
    } finally {
        redis.disconnect();
    }
}

main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
