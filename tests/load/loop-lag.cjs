/**
 * Event-loop lag sampler, loaded with `--require` — #2321.
 *
 * ## Why a preload and not app code
 *
 * #2321 needs event-loop lag inside the app process during a 1,000-stream
 * hold. The app has no such instrumentation and must not gain any: a metric
 * that samples a histogram on a timer is a permanent cost paid in production
 * for a question asked once.
 *
 * `NODE_OPTIONS=--require …` attaches this to the SAME process without the
 * repo's runtime containing it. On the throwaway host it is mounted into the
 * container; nothing in `deploy/docker-compose.vm.yml` references it.
 *
 * It lives beside the k6 scripts it instruments. It is not under `infra/`
 * because nothing in this repo DEPLOYS it — it is handed to a throwaway
 * process by hand — and `infra-directories-are-referenced` is right to treat
 * an unreachable `infra/` directory as a defect.
 *
 * ## It is INERT unless switched on
 *
 * No `LOOP_LAG_OUT`, no sampler. That is the load-bearing safety property,
 * not a convenience: this file lives in the repo, so the only thing standing
 * between it and a production process is that it does nothing by default.
 * Failing closed also means a typo in the variable name produces an empty
 * output file rather than a silently unmeasured run — see the caller, which
 * refuses to report on a file with no samples.
 *
 * ## What it measures, and what that is worth
 *
 * `monitorEventLoopDelay` is libuv-level: it records how late each timer tick
 * actually fired versus when it was due. A loop blocked by synchronous work,
 * or simply oversubscribed, shows up here and nowhere else — which is exactly
 * the reading #2321 lacked. It is NOT a proxy like "latency of a cheap
 * endpoint": `/api/health` touches Postgres and Redis, so its latency
 * conflates the loop with the two things the issue is trying to rule out.
 */
'use strict';

const OUT = process.env.LOOP_LAG_OUT;

if (OUT) {
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const fs = require('node:fs');

    const EVERY_MS = Number(process.env.LOOP_LAG_INTERVAL_MS || 1000);
    // 10 ms resolution: the tail being chased is seconds, and a finer
    // resolution costs more samples for no extra meaning at that scale.
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();

    const started = Date.now();

    const tick = () => {
        // Nanoseconds from the histogram; milliseconds in the output, because
        // every figure in #2321 is in milliseconds and a unit change between
        // the issue and its answer is how comparisons go wrong.
        const ns = (v) => (Number.isFinite(v) ? Math.round(v / 1e4) / 100 : null);
        const line = JSON.stringify({
            t: new Date().toISOString(),
            elapsedS: Math.round((Date.now() - started) / 1000),
            pid: process.pid,
            samples: h.count,
            lagMs: {
                min: ns(h.min),
                mean: ns(h.mean),
                p50: ns(h.percentile(50)),
                p90: ns(h.percentile(90)),
                p95: ns(h.percentile(95)),
                p99: ns(h.percentile(99)),
                max: ns(h.max),
            },
            // Resident set, so a loop that is slow because the process is
            // thrashing is distinguishable from one that is merely busy.
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
        });
        try {
            fs.appendFileSync(OUT, line + '\n');
        } catch {
            // Deliberately silent. A sampler that crashes the process it is
            // measuring has destroyed the measurement and the service with it;
            // the caller detects an absent or empty file instead.
        }
        // RESET each interval, so every line is that interval's distribution
        // rather than a cumulative one. A cumulative histogram hides when the
        // lag started, and "when" is the whole question during a hold phase.
        h.reset();
    };

    const timer = setInterval(tick, EVERY_MS);
    // Never hold the process open: a load test's app must exit when stopped.
    timer.unref();
}
