/**
 * The worker's heartbeat has four separable parts, and any one of them
 * silently disables it.
 *
 * ## What this protects
 *
 * `deploy/docker-compose.vm.yml` gave `worker` no healthcheck, so a wedged
 * worker — blocked event loop, dead Redis connection, every concurrency slot
 * held by a hung handler — kept its container `running` with the web tier
 * green (#809). Healthy and broken produced the same observable.
 *
 * The fix is a chain, and a chain is exactly what goes quietly wrong:
 *
 *   1. `worker.ts` calls `beat()` from BullMQ's `completed` event
 *   2. `schedules.ts` registers `health-check` frequently enough that an IDLE
 *      worker still emits that event
 *   3. `build-worker.mjs` bundles the probe into `dist/`
 *   4. the compose service runs it
 *
 * Break any link and the others still look right. Drop (2) and the probe fails
 * on a perfectly healthy idle worker; drop (1) and it fails always; drop (3)
 * and the healthcheck command is a missing file, which Docker reports as
 * unhealthy for a reason that has nothing to do with the worker; drop (4) and
 * the whole thing is inert with every other part present.
 *
 * ## The invariant worth naming
 *
 * The TTL must exceed the cron interval by a real margin. If they were equal,
 * a single slow beat would expire the key and flap the container — a
 * healthcheck that reports failure on a healthy system trains people to
 * ignore it, which is worse than not having one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import {
    WORKER_HEARTBEAT_KEY,
    WORKER_HEARTBEAT_TTL_SECONDS,
} from '../../src/app-layer/jobs/worker-heartbeat';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source with comments stripped.
 *
 * Needed because this guard's first version asserted the probe contains no
 * `enqueue` and matched the word in the probe's own DOCBLOCK, which explains
 * why it does not enqueue. Prose and code sharing one channel — a grep cannot
 * tell a mention from a use.
 */
const code = (rel: string): string =>
    read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

interface ComposeFile {
    services?: Record<string, { healthcheck?: { test?: string[]; interval?: string; start_period?: string } }>;
}

/** The `health-check` cron, parsed out of the schedule definition. */
function healthCheckCronMinutes(): number | null {
    const src = read('src/app-layer/jobs/schedules.ts');
    const block = src.slice(src.indexOf("name: 'health-check'"));
    const m = block.slice(0, 400).match(/pattern:\s*'([^']+)'/);
    if (!m) return null;
    const every = m[1].match(/^\*\/(\d+) \* \* \* \*$/);
    return every ? Number(every[1]) : null;
}

describe('the worker heartbeat is wired end to end', () => {
    describe('the guard is reading real files', () => {
        it('the compose file parses and declares the worker service', () => {
            const c = yaml.load(read('deploy/docker-compose.vm.yml')) as ComposeFile;
            expect(c.services?.worker).toBeDefined();
        });

        it('the schedule definition yields a parseable cron', () => {
            // Without this, a renamed schedule makes the TTL assertion below
            // compare against null and pass while checking nothing.
            expect(healthCheckCronMinutes()).not.toBeNull();
        });
    });

    it('1. the worker refreshes the heartbeat from a BullMQ event, not a timer', () => {
        const src = read('scripts/worker.ts');
        expect(src).toMatch(/worker\.on\('completed'/);
        expect(src).toMatch(/\bbeat\(/);
        // A setInterval keeps ticking through a severed Redis connection, so a
        // timer-driven heartbeat reports a wedged worker as healthy. That is
        // the specific mistake the issue calls out; this pins that the beat is
        // not reached that way.
        const stripped = code('scripts/worker.ts');
        // Positive control on the strip. Every assertion below is NEGATIVE, so
        // an empty or over-aggressive `code()` satisfies them while reading
        // nothing — `indexOf` returns -1, the slice is '', and `not.toMatch`
        // passes. Selector-teeth caught exactly that: gutting `code()` to
        // return '' left this guard green.
        expect(stripped).toContain("worker.on('completed'");
        expect(stripped).toContain('beat(');

        const beatSection = stripped.slice(stripped.indexOf("worker.on('completed'"));
        expect(beatSection.slice(0, 300)).not.toMatch(/setInterval/);
    });

    it('2. health-check is scheduled, so an idle worker still beats', () => {
        const src = read('src/app-layer/jobs/schedules.ts');
        expect(src).toContain("name: 'health-check'");
        expect(healthCheckCronMinutes()).toBeGreaterThan(0);
    });

    it('3. the probe is bundled into dist/ with the other entrypoints', () => {
        // The runner image ships no source tree and no devDependencies, so an
        // unbundled probe is a healthcheck command that cannot run.
        expect(read('scripts/build-worker.mjs')).toContain('scripts/worker-healthcheck.ts');
        expect(read('scripts/build-worker.mjs')).toContain('dist/worker-healthcheck.mjs');
    });

    it('4. the compose service actually runs it', () => {
        const c = yaml.load(read('deploy/docker-compose.vm.yml')) as ComposeFile;
        const hc = c.services?.worker?.healthcheck;
        expect(hc).toBeDefined();
        expect((hc?.test ?? []).join(' ')).toContain('dist/worker-healthcheck.mjs');
    });

    it('the TTL leaves room for missed beats rather than matching the interval', () => {
        const cron = healthCheckCronMinutes()!;
        const ttlMinutes = WORKER_HEARTBEAT_TTL_SECONDS / 60;
        // At least three missed beats. Equal values would expire the key
        // between beats and flap a healthy container.
        expect(ttlMinutes).toBeGreaterThanOrEqual(cron * 3);
    });

    it('the probe reads the same key the worker writes', () => {
        // Two files, one constant — imported by both rather than spelled
        // twice, and asserted here so a future inline literal is caught.
        expect(WORKER_HEARTBEAT_KEY).toMatch(/^agrent:/);
        expect(read('scripts/worker-healthcheck.ts')).toContain('WORKER_HEARTBEAT_KEY');
        expect(read('scripts/worker-healthcheck.ts')).not.toMatch(/['"]agrent:worker:heartbeat['"]/);
    });

    it('the probe only READS — it never enqueues work', () => {
        // A probe that created a job would keep passing while the worker's own
        // consumption was dead: it would be testing Redis, not the worker.
        const src = code('scripts/worker-healthcheck.ts');
        // Positive control, for the same reason: the assertion below is
        // negative, so the strip must be shown to have left the probe's CODE
        // behind. (A no-op `code()` is already caught — the docblock says the
        // word "enqueue", which is what made this guard red at baseline.)
        expect(src).toContain('WORKER_HEARTBEAT_KEY');
        expect(src.length).toBeGreaterThan(200);

        expect(src).not.toMatch(/\benqueue\b|\.add\(|new Queue\b/);
    });

    it('a missing REDIS_URL fails rather than skipping', () => {
        // Reporting healthy on a missing variable is the same silent pass this
        // whole issue is about.
        const src = read('scripts/worker-healthcheck.ts');
        const guard = src.slice(src.indexOf('REDIS_URL'), src.indexOf('REDIS_URL') + 400);
        expect(guard).toMatch(/return 1/);
    });
});
