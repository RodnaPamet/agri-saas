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
 *
 * ## Why GC rides along — #2381
 *
 * Lag says the loop stalled. It cannot say WHY, and the two candidates for
 * #2381's ~200 ms ceiling are answered by the same window: a periodic
 * blocking task, or a major collection.
 *
 * The ceiling's signature is that it is load-INDEPENDENT — 202-203 ms in
 * every phase of #2321's run including idle. That is strange for a cost that
 * tracks request rate and unremarkable for one that tracks HEAP SIZE, so GC
 * is the ranked candidate. Two cheaper explanations are already ruled out
 * (2026-11-16): a bare idle Node process on the busier, smaller `agrent` host
 * showed a worst case of 18.4 ms over 60 one-second windows with nothing
 * above 50 ms, which exonerates both E2 host scheduling and this sampler's
 * own period — and a grep found no timer in the 150-250 ms band anywhere in
 * `src/`, `scripts/` or `public/` except two browser-side ones.
 *
 * So each line now carries the worst GC pause of the SAME window as the worst
 * lag. If they move together and are of a size, the ceiling is a collection
 * and the answer is heap sizing rather than a defect. If the lag window holds
 * no comparable pause, GC is out and the search narrows to Next's own
 * background work.
 *
 * The accumulator is FIXED-SIZE on purpose — counters and a max, never an
 * array of entries. A growing array allocates, allocation is what triggers
 * collection, and an instrument that causes the event it measures is worth
 * nothing. Kinds are read from `perf_hooks.constants`, not written as the
 * integers V8 happens to use today.
 *
 * `PerformanceObserver` is not a libuv handle, so unlike the sampler's timer
 * it cannot hold the process open and needs no `unref()`.
 */
'use strict';

const OUT = process.env.LOOP_LAG_OUT;

if (OUT) {
    const { monitorEventLoopDelay, PerformanceObserver, constants } = require('node:perf_hooks');
    const fs = require('node:fs');

    /*
     * Named from `constants` rather than hardcoded. V8's kind values are an
     * implementation detail, and a run that silently labelled a major
     * collection "minor" would answer #2381 backwards.
     */
    const GC_KINDS = {
        [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
        [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
        [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
        [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
    };
    /* Fixed-size: per-kind count and worst, plus a window total. No array. */
    const gc = { count: 0, totalMs: 0, worstMs: 0, worstKind: null, byKind: {} };
    const resetGc = () => {
        gc.count = 0;
        gc.totalMs = 0;
        gc.worstMs = 0;
        gc.worstKind = null;
        gc.byKind = {};
    };
    const gcObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const kind = GC_KINDS[e.detail && e.detail.kind] || 'unknown';
            gc.count += 1;
            gc.totalMs += e.duration;
            gc.byKind[kind] = (gc.byKind[kind] || 0) + 1;
            if (e.duration > gc.worstMs) {
                gc.worstMs = e.duration;
                gc.worstKind = kind;
            }
        }
    });
    gcObserver.observe({ entryTypes: ['gc'] });

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
            // The SAME window as lagMs above, which is the only reason the two
            // can be compared. `worstMs` beside `lagMs.max` is the #2381
            // reading: a ceiling explained by a collection shows both, of a
            // size; one explained by blocking work shows lag and no pause.
            gc: {
                count: gc.count,
                totalMs: Math.round(gc.totalMs * 100) / 100,
                worstMs: Math.round(gc.worstMs * 100) / 100,
                worstKind: gc.worstKind,
                byKind: gc.byKind,
            },
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
        // Both accumulators reset together or the two halves of a line would
        // describe different windows, which is worse than having only one.
        resetGc();
    };

    const timer = setInterval(tick, EVERY_MS);
    // Never hold the process open: a load test's app must exit when stopped.
    timer.unref();
}
