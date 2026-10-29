/**
 * How many Postgres acquisitions does one request make? — #2381.
 *
 * ## Why this exists at all
 *
 * #2381's ranked hypothesis is that the SSE tail is client-side pool
 * acquisition wait: `PG_POOL_MAX` is 12, and ~1,000 concurrent stream opens
 * each acquire a connection several times in sequence. A local experiment put
 * ~2.2 s of p95 on that queueing at the production pool size, and found that
 * reducing acquisitions beats enlarging the pool.
 *
 * But the ACQUISITION COUNT is not derivable by reading the code. The open path
 * mixes sequential awaits with a `Promise.all` inside `resolveFlags`, and
 * `readFlagTable` may be cached — so the count differs between a cold and a
 * warm process, and the ramp is exactly where that lands. "Three or four
 * sequential round trips" was a reading of an issue comment, not a measurement,
 * and collapsing a number I had guessed would have been the same mistake #2321
 * made from the other side.
 *
 * Under a driver adapter every query is its own acquisition — Prisma 7 runs
 * through `@prisma/adapter-pg`, so there is no query-engine pool holding a
 * connection across statements. Counting query events therefore counts
 * acquisitions, with no access to the `pg` pool and no new dependency: `pg` is
 * only a transitive dependency here, and declaring it for an instrument would
 * mean a lockfile write for the sake of a measurement.
 *
 * ## INERT without its environment variable
 *
 * No `ACQUISITION_PROBE_OUT`, no listener, no timer, no buffer — the same
 * load-bearing property `tests/load/loop-lag.cjs` carries, and the reason the
 * default client construction in `prisma.ts` is left byte-identical.
 *
 * ## It must not become the thing it measures
 *
 * 1,000 VUs times several queries is thousands of events. An `appendFileSync`
 * per event would be synchronous disk I/O on the request path — the instrument
 * blocking the event loop it is trying to exonerate, which is the shape of
 * error that makes a measurement worthless rather than merely noisy. So events
 * accumulate in memory and a single unref'd timer flushes them.
 *
 * ## It records NO query text and NO parameters
 *
 * Prisma's query event carries `params`, which holds real column values — user
 * ids, names, anything in a WHERE clause. On a load host those are synthetic,
 * but a probe that writes them is one environment variable away from writing
 * them somewhere else. Duration and a count are the whole measurement; the SQL
 * is not needed to answer "how many acquisitions".
 */
import { appendFileSync } from 'node:fs';

import { env } from '@/env';

/**
 * Read through the validated schema, not raw `process.env`.
 *
 * `no-fallbacks` forbids raw `process.env` in `src/`, and the sibling probe
 * `tests/load/loop-lag.cjs` escapes that rule only by living outside `src/`.
 * Going through `@/env` also gives exactly the semantics wanted here: the value
 * is captured ONCE at module load, so nothing can switch the instrument on
 * mid-process.
 */
const OUT = env.ACQUISITION_PROBE_OUT;

/** Whether the probe is active. Read by `prisma.ts` to decide on `log:`. */
export const ACQUISITION_PROBE_ON = Boolean(OUT);

/** Flush cadence. Frequent enough to survive a kill, rare enough to be free. */
const FLUSH_MS = 250;

interface QueryEventLike {
    duration: number;
}

interface ClientLike {
    $on(event: 'query', cb: (e: QueryEventLike) => void): void;
}

/**
 * Attach the counter. A no-op unless `ACQUISITION_PROBE_OUT` is set.
 *
 * Returns whether it attached, so a caller — and a test — can tell "inert" from
 * "attached and silent", which are the two things an absent output file cannot
 * distinguish.
 */
export function attachAcquisitionProbe(client: ClientLike): boolean {
    if (!OUT) return false;

    let count = 0;
    let totalMs = 0;
    let maxMs = 0;

    client.$on('query', (e) => {
        count += 1;
        const ms = typeof e.duration === 'number' ? e.duration : 0;
        totalMs += ms;
        if (ms > maxMs) maxMs = ms;
    });

    const timer = setInterval(() => {
        // Snapshot and RESET, so each line is an interval rather than a running
        // total. A cumulative line cannot show where in the ramp the queries
        // arrived, and the ramp is the window this exists for.
        const line = { t: Date.now(), pid: process.pid, queries: count, totalMs, maxMs };
        count = 0;
        totalMs = 0;
        maxMs = 0;
        if (line.queries === 0) return;
        try {
            appendFileSync(OUT, `${JSON.stringify(line)}\n`);
        } catch {
            // A failed write must not take the server down. The absence of
            // lines is visible in the analysis; a crashed app under load would
            // be read as a finding about the app.
        }
    }, FLUSH_MS);

    // Never hold the process open. A probe that prevents exit turns every
    // shutdown into a timeout, which is a worse bug than no instrument.
    timer.unref();
    return true;
}
