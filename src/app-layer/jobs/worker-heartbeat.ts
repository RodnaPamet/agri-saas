/**
 * The worker's proof that it is CONSUMING, not merely running.
 *
 * ## Why a heartbeat and not a liveness probe
 *
 * `deploy/docker-compose.vm.yml` gave `worker` no healthcheck at all, so
 * `docker inspect` reported `health=none` against `healthy` for app, db,
 * pgbouncer and redis. A wedged worker — event loop blocked, Redis connection
 * dead, every concurrency slot held by a hung handler — keeps its container
 * `running` and its process alive, and the web tier stays green throughout.
 * Healthy and broken produce the same observable (#809).
 *
 * The issue's own bar rules out the easy fix: "a liveness probe that only
 * checks the process exists would reproduce the current gap; it needs to touch
 * the queue."
 *
 * ## Why it is written from a BullMQ event
 *
 * A `setInterval` that stamps a local timestamp keeps ticking through a
 * severed Redis connection, so it proves nothing about consumption. This is
 * written from the worker's `completed` event instead, so the key is refreshed
 * only when the worker has actually pulled a job off the queue, run it, and
 * come back. That path covers the whole chain: Redis reachable, event loop
 * responsive, a concurrency slot free, the executor registry loadable.
 *
 * ## Why an idle worker still beats
 *
 * Events need jobs. `health-check` is registered in `schedules.ts` on a
 * two-minute cron precisely so the `completed` event fires on an otherwise
 * quiet queue — the executor already existed (`executor-registry.ts`) and
 * nothing had ever dispatched it, which is why it returned 'pong' to nobody.
 * So the beat also proves the SCHEDULER's repeatables are still registered: if
 * the scheduler never ran, no health-check job is enqueued, nothing completes,
 * and the key goes stale.
 *
 * The TTL is the whole mechanism. Nothing deletes this key — it expires. A
 * worker that stops completing jobs stops refreshing it, and `EXISTS` goes to
 * 0 on its own. There is no cleanup path to forget.
 */
import type Redis from 'ioredis';

export const WORKER_HEARTBEAT_KEY = 'agrent:worker:heartbeat';

/**
 * Seconds the key survives without a refresh.
 *
 * `health-check` runs every 2 minutes, so this tolerates FOUR consecutive
 * missed beats before the key disappears. Sized for the miss, not the
 * interval: a single slow job or a scheduler restart must not flap the
 * container, and BullMQ's own stall detection works on a 30s window, so a
 * genuinely stuck handler is visible well inside this budget.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 8 * 60;

/**
 * Refresh the heartbeat. Never throws.
 *
 * A heartbeat write that breaks job completion would be a worse defect than
 * the one it reports — the job has already succeeded by the time this runs,
 * and losing that outcome to a monitoring write is not a trade worth making.
 * A failed write costs one missed beat, and four of those are needed before
 * anything reports unhealthy.
 */
export async function beat(connection: Redis, now: () => number = Date.now): Promise<void> {
    try {
        await connection.set(WORKER_HEARTBEAT_KEY, String(now()), 'EX', WORKER_HEARTBEAT_TTL_SECONDS);
    } catch {
        // Deliberately swallowed — see the docblock above.
    }
}
