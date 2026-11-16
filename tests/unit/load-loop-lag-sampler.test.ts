/**
 * The loop-lag preload is EXECUTED here, not scanned — #2381.
 *
 * `tests/guards/loop-lag-preload-is-inert.test.ts` reads the source and
 * asserts the shape: the `if (OUT)` gate, `perf_hooks` required inside it,
 * the `unref()`, the try/catch, the per-interval `reset()`. That is the right
 * tool for "the pattern is present" and it contributes no runtime coverage —
 * CLAUDE.md's own four-tier rule, and the reason the coverage gate itself was
 * once 675 lines guarded only by guards.
 *
 * Two properties cannot be read off the text at all:
 *
 *   1. The sampler PRODUCES a GC reading. A `PerformanceObserver` that is
 *      constructed, observed and never fires looks identical in source to one
 *      that works, and #2381's whole question is whether the ~200 ms ceiling
 *      coincides with a collection. A `gc.worstMs` stuck at 0 would answer
 *      "no collection in that window" — the wrong answer, delivered
 *      confidently, from a working-looking instrument.
 *
 *   2. Inert MEANS inert. The guard proves the gate is written; this proves
 *      that with no `LOOP_LAG_OUT` the process writes nothing at all.
 *
 * GC is forced with `--expose-gc` rather than by allocating until V8 gives
 * in. Allocation pressure makes a MINOR collection likely and a major one a
 * coin toss, and a test that needs a coin toss is a flake this repo would
 * then have to ledger.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PRELOAD = path.resolve(__dirname, '../..', 'tests/load/loop-lag.cjs');

interface Line {
    pid: number;
    samples: number;
    lagMs: Record<string, number | null>;
    rssMb: number;
    gc: {
        count: number;
        totalMs: number;
        worstMs: number;
        worstKind: string | null;
        byKind: Record<string, number>;
    };
}

/** Run a throwaway node process under the preload; return the lines it wrote. */
function sample(opts: { out: boolean }): { lines: Line[]; fileExists: boolean } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-lag-exec-'));
    const out = path.join(dir, 'samples.ndjson');
    try {
        const env: NodeJS.ProcessEnv = { ...process.env, LOOP_LAG_INTERVAL_MS: '100' };
        if (opts.out) env.LOOP_LAG_OUT = out;
        else delete env.LOOP_LAG_OUT;
        execFileSync(
            process.execPath,
            [
                '--expose-gc',
                '--require',
                PRELOAD,
                '-e',
                // Two forced major collections, then stay alive long enough for
                // several 100 ms ticks to fire and flush.
                'global.gc(); global.gc(); setTimeout(() => {}, 600);',
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
        );
        const fileExists = fs.existsSync(out);
        const lines = fileExists
            ? fs
                  .readFileSync(out, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => JSON.parse(l) as Line)
            : [];
        return { lines, fileExists };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('the loop-lag sampler, executed (#2381)', () => {
    it('writes samples when switched on — the control for everything below', () => {
        const { lines, fileExists } = sample({ out: true });
        console.log(`[loop-lag-exec] ${lines.length} sample line(s) written`);
        expect(fileExists).toBe(true);
        expect(lines.length).toBeGreaterThan(0);
        // Each line is one interval's distribution, so it must carry samples.
        expect(lines.some((l) => l.samples > 0)).toBe(true);
        expect(lines.every((l) => l.pid === lines[0].pid)).toBe(true);
    });

    it('writes NOTHING without LOOP_LAG_OUT — inert, executed rather than read', () => {
        // The guard asserts the gate exists in source. This asserts the gate
        // WORKS, which is the property the file's docblock calls load-bearing:
        // it lives in the repo, so being inert by default is all that stands
        // between it and a production process.
        const { lines, fileExists } = sample({ out: false });
        expect(fileExists).toBe(false);
        expect(lines).toEqual([]);
    });

    it('reports the GC pauses of the window, with the kind named not numbered', () => {
        const { lines } = sample({ out: true });
        const withGc = lines.filter((l) => l.gc && l.gc.count > 0);
        console.log(
            `[loop-lag-exec] ${withGc.length}/${lines.length} window(s) saw a collection; ` +
                `kinds ${JSON.stringify(
                    withGc.reduce<Record<string, number>>((a, l) => {
                        for (const [k, v] of Object.entries(l.gc.byKind)) a[k] = (a[k] || 0) + v;
                        return a;
                    }, {}),
                )}`,
        );
        // Two forced collections, so at least one window must have seen one.
        expect(withGc.length).toBeGreaterThan(0);
        const kinds = new Set(withGc.flatMap((l) => Object.keys(l.gc.byKind)));
        // `global.gc()` is a major collection. If this reads 'unknown' the
        // constants lookup has drifted from V8's kind values, which is exactly
        // the failure that would label a major pause minor and answer #2381
        // backwards.
        expect(kinds.has('major')).toBe(true);
        expect(kinds.has('unknown')).toBe(false);
    });

    it('a pause has a real duration, and the window total is at least the worst one', () => {
        const { lines } = sample({ out: true });
        const withGc = lines.filter((l) => l.gc && l.gc.count > 0);
        expect(withGc.length).toBeGreaterThan(0);
        for (const l of withGc) {
            // A zero worst with a non-zero count is the shape that would make a
            // real ~200 ms pause invisible.
            expect(l.gc.worstMs).toBeGreaterThan(0);
            expect(l.gc.worstKind).not.toBeNull();
            expect(l.gc.totalMs).toBeGreaterThanOrEqual(l.gc.worstMs);
            expect(Object.values(l.gc.byKind).reduce((a, b) => a + b, 0)).toBe(l.gc.count);
        }
    });

    it('the accumulator RESETS per window, so a line is not cumulative', () => {
        // The lag histogram resets each interval and the GC accumulator must
        // reset with it, or the two halves of one line describe different
        // windows — which is worse than carrying only one of them. With two
        // collections at startup and ~6 windows, a cumulative counter would
        // hold its count on every later line; a reset one drops back to zero.
        const { lines } = sample({ out: true });
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.some((l) => l.gc.count === 0)).toBe(true);
    });
});
