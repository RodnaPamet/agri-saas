/**
 * Is the worker tier completing jobs? Reported on `/api/readyz` — #2825.
 *
 * ## Why this exists
 *
 * The worker tier was dead for 13–18 hours and nothing reported it. The GCP
 * uptime check probes `/api/readyz` on the APP tier, which stayed green
 * throughout; the container healthcheck DID fail, and a failing container
 * healthcheck pages nobody — it restarts the container, which is how that
 * outage ran 13 restarts deep unseen. So the deployment had a tier whose total
 * failure was invisible to every alert it has.
 *
 * ## WATCHED, not gated — and that is the whole design
 *
 * This goes in `capabilities`, never in `checks`/`failed`, so it can never
 * 503 the probe. That is the #781 treatment and it is deliberate twice over:
 *
 *   - `/api/readyz` is the GCP uptime check's target, so a bug here must not
 *     be able to page anybody. `capabilities.basemap` carries the same note.
 *   - The worker is a SEPARATE tier. A dead worker does not make the API
 *     unready — reads and writes keep working, which is exactly why the app
 *     stayed green — and 503ing the API because background jobs stopped would
 *     turn a degraded deployment into an outage.
 *
 * The owner chose this over a second uptime check that pages (#2825), on the
 * ground that there is one inbox and no rota, so a transient worker blip
 * waking somebody is a real cost. The consequence is stated plainly: this is a
 * READING, and somebody still has to look at it.
 *
 * ## The three states, and why `unknown` is one of them
 *
 * `beating` — the key is present and fresh. Because `beat()` is called from
 * BullMQ's `completed` event, this means a job was pulled, run and RETURNED,
 * not merely that a process is alive. It is the same signal the container
 * healthcheck reads, deliberately: two monitors disagreeing about whether the
 * worker is alive would be worse than one.
 *
 * `stale` — the key is absent. Nothing deletes it; it EXPIRES. So absence
 * means no job completed within `WORKER_HEARTBEAT_TTL_SECONDS`, which is four
 * consecutive missed `health-check` beats.
 *
 * `unknown` — Redis is unconfigured, unreachable, or returned something this
 * cannot interpret. Never `stale`: an unreadable Redis is a Redis problem, and
 * reporting it as a worker problem sends an operator to the wrong subsystem
 * mid-incident. `mail-canary-capability` makes the same distinction for the
 * same reason.
 */

import { logger } from '@/lib/observability/logger';
import {
    WORKER_HEARTBEAT_KEY,
    WORKER_HEARTBEAT_TTL_SECONDS,
} from './worker-heartbeat';

export type WorkerHeartbeatState = 'beating' | 'stale' | 'unknown';

export interface WorkerHeartbeatCapability {
    readonly state: WorkerHeartbeatState;
    /** ISO timestamp of the last completed job, when known. */
    readonly lastBeatAt: string | null;
    readonly ageSeconds: number | null;
    /**
     * The budget the state was judged against, so a reader does not have to
     * find it in another file to know whether 7 minutes is bad.
     */
    readonly ttlSeconds: number;
}

/** Only what this needs, so a test does not have to build an ioredis. */
export interface HeartbeatReader {
    get(key: string): Promise<string | null>;
}

const BASE = {
    state: 'unknown' as WorkerHeartbeatState,
    lastBeatAt: null,
    ageSeconds: null,
    ttlSeconds: WORKER_HEARTBEAT_TTL_SECONDS,
} as const;

/**
 * @param connection a Redis client, or `null` when Redis is unconfigured.
 *        Injected rather than imported, for `mailCanaryCapability`'s reason:
 *        `readyz` already resolves its own client, and a module-level import
 *        would widen that route's graph for nothing.
 */
export async function workerHeartbeatCapability(
    connection: HeartbeatReader | null,
    now: () => number = Date.now,
): Promise<WorkerHeartbeatCapability> {
    if (!connection) return { ...BASE, state: 'unknown' };

    let raw: string | null;
    try {
        raw = await connection.get(WORKER_HEARTBEAT_KEY);
    } catch (err) {
        logger.warn('worker_heartbeat.capability_read_failed', {
            component: 'worker-heartbeat-capability',
            error: err instanceof Error ? err.message : String(err),
        });
        return { ...BASE, state: 'unknown' };
    }

    // Absent is STALE, not unknown: the key expires and nothing deletes it, so
    // its absence is a positive statement that no job completed in the window.
    if (raw === null) return { ...BASE, state: 'stale' };

    const beatMs = Number(raw);
    if (!Number.isFinite(beatMs) || beatMs <= 0) {
        // Something wrote a value this cannot read. "Could not interpret" is
        // not "no beat" — reporting it as stale would send an operator after a
        // healthy worker.
        logger.warn('worker_heartbeat.capability_unparseable', {
            component: 'worker-heartbeat-capability',
            // The LENGTH, not the value: this key is ours, but a log line that
            // echoes whatever is at a Redis key is a habit worth not forming.
            rawLength: raw.length,
        });
        return { ...BASE, state: 'unknown' };
    }

    // A beat stamped in the future is a clock problem, not a fresh worker.
    // Clamped and allowed to read as fresh, for `mailCanaryCapability`'s
    // reason: the alternative is a worker alarm for an NTP fault.
    const ageSeconds = Math.max(0, Math.floor((now() - beatMs) / 1000));

    return {
        ...BASE,
        state: ageSeconds > WORKER_HEARTBEAT_TTL_SECONDS ? 'stale' : 'beating',
        lastBeatAt: new Date(beatMs).toISOString(),
        ageSeconds,
    };
}
