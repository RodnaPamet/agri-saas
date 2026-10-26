/**
 * The event-loop-lag preload does NOTHING unless switched on — #2321.
 *
 * `tests/load/loop-lag.cjs` is attached with `NODE_OPTIONS=--require` on a
 * throwaway load-test host to answer #2321's missing reading. It sits beside
 * the k6 scripts it instruments rather than under `infra/`, where
 * `infra-directories-are-referenced` correctly refused it: a directory nothing
 * reaches is either deployed from elsewhere or not deployed, and this is
 * neither — it is load-test tooling, and `tests/load/` is already the
 * load-test directory that `load-test.yml` drives. It lives in this
 * repo, which means the only thing standing between it and a production
 * process is that it is inert by default.
 *
 * That is a safety argument, and safety arguments expire silently: hoisting
 * the `require('node:perf_hooks')` to the top, or dropping the `if (OUT)`
 * because "the sampler is cheap", would each leave a timer and a histogram
 * running in every process that ever loaded this file. Nothing would fail.
 *
 * Asserted on the comment-stripped source, because the file's own docblock
 * explains all three properties at length and a raw scan would be satisfied by
 * the prose describing the mechanism rather than the mechanism.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const REL = 'tests/load/loop-lag.cjs';
const RAW = fs.readFileSync(path.resolve(__dirname, '../..', REL), 'utf8');
const CODE = blankNonCode(RAW, { strings: false });

describe('the loop-lag preload is inert by default (#2321)', () => {
    it('[loop-lag] the file exists and the scan read it', () => {
        console.log(`[loop-lag] ${REL}: ${RAW.length} bytes, ${CODE.split('\n').length} lines`);
        // An empty read would satisfy every negated assertion below.
        expect(RAW.length).toBeGreaterThan(500);
        expect(CODE).toContain('LOOP_LAG_OUT');
    });

    it('everything is behind the env-var check — nothing runs at import', () => {
        // The guard clause must come before any work, and `perf_hooks` must be
        // required INSIDE it: a top-level require loads the module in every
        // process that touches this file, which is the cost the preload exists
        // to avoid paying in production.
        const gate = CODE.indexOf('if (OUT)');
        const perfRequire = CODE.indexOf("require('node:perf_hooks')");
        const monitor = CODE.indexOf('monitorEventLoopDelay');
        expect({ gateFound: gate >= 0 }).toEqual({ gateFound: true });
        expect({ perfRequireFound: perfRequire >= 0 }).toEqual({ perfRequireFound: true });
        expect({ perfRequireIsInsideTheGate: perfRequire > gate })
            .toEqual({ perfRequireIsInsideTheGate: true });
        expect({ monitorIsInsideTheGate: monitor > gate })
            .toEqual({ monitorIsInsideTheGate: true });
    });

    it('the timer is unref()d, so it cannot hold a process open', () => {
        // Measured: without this the process survives its own interval. An app
        // that will not exit when stopped breaks the load harness's teardown,
        // and a load test whose teardown fails leaves VMs billing.
        expect(CODE).toMatch(/\.unref\(\)/);
    });

    it('a write failure cannot take the measured process down', () => {
        // The sampler runs INSIDE the app being measured. An exception from
        // appendFileSync — a full disk, a read-only mount, a deleted directory
        // — would crash the thing under test and destroy the run along with
        // the service.
        const appendAt = CODE.indexOf('appendFileSync');
        expect({ appendFound: appendAt >= 0 }).toEqual({ appendFound: true });
        const around = CODE.slice(Math.max(0, appendAt - 200), appendAt + 200);
        expect(around).toMatch(/try\s*\{/);
        expect(around).toMatch(/catch/);
    });

    it('each line is that interval, not a cumulative total', () => {
        // `reset()` after every emit. Without it the histogram accumulates and
        // every line reports the whole run so far, which hides WHEN the lag
        // started — and "when, relative to the hold phase" is the entire
        // question #2321 asks.
        expect(CODE).toMatch(/h\.reset\(\)/);
    });

    it('nothing in the production compose file references it', () => {
        // The preload reaches a process only through an explicit NODE_OPTIONS
        // on a throwaway host. If it ever appears here, it is being shipped.
        const compose = fs.readFileSync(
            path.resolve(__dirname, '../..', 'deploy/docker-compose.vm.yml'),
            'utf8',
        );
        expect({ referenced: /loop-lag|LOOP_LAG/.test(compose) })
            .toEqual({ referenced: false });
    });

    describe('self-test: the detector fires on the shapes that would break it', () => {
        it('a top-level perf_hooks require is detected', () => {
            const bad = blankNonCode(
                "const { monitorEventLoopDelay } = require('node:perf_hooks');\nconst OUT = process.env.LOOP_LAG_OUT;\nif (OUT) { }",
                { strings: false },
            );
            expect(bad.indexOf("require('node:perf_hooks')") > bad.indexOf('if (OUT)')).toBe(false);
        });

        it('a missing unref is detected', () => {
            expect(/\.unref\(\)/.test('const t = setInterval(tick, 1000);')).toBe(false);
        });

        it('an unguarded append is detected', () => {
            const bad = 'fs.appendFileSync(OUT, line);';
            const around = bad.slice(0, 200);
            expect(/try\s*\{/.test(around)).toBe(false);
        });
    });
});
