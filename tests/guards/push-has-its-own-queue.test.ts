/**
 * Push delivery runs on its OWN queue and its own worker — P7.4 (#1993).
 *
 * ## What goes wrong without this
 *
 * The main worker is `concurrency: 5` with `limiter: { max: 50, duration:
 * 60000 }`. A push fan-out sharing that budget would starve every other job
 * type for the rest of the minute, and the jobs it would starve include
 * `process-outbox` — which is how a notification reaches email. So the failure
 * is not "push was slow", it is "push was slow AND the email never went".
 *
 * ## Why a guard rather than only a unit test
 *
 * The queue exists in three places that have to agree and are edited
 * separately: the name and the job-name set in `types.ts`, the `Queue` factory
 * plus the routing in `queue.ts`, and the `Worker` in `scripts/worker.ts`.
 * Wiring two of the three leaves a job enqueued onto a queue nothing consumes
 * — which does not fail, it just never delivers, and the symptom is a
 * notification that silently never arrives. `worker-deployment` and
 * `worker-heartbeat-wiring` exist for the same class of three-file agreement.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT as ROOT } from '../helpers/collect-files';
import { PUSH_QUEUE_NAME, PUSH_QUEUE_JOBS, SOIL_QUEUE_JOBS, JOB_DEFAULTS } from '@/app-layer/jobs/types';

const code = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('push delivery has its own queue', () => {
    it('reports what it covers', () => {
        console.log(
            `[push-queue] ${PUSH_QUEUE_NAME}: ${[...PUSH_QUEUE_JOBS].join(', ')} ` +
                `(soil queue: ${[...SOIL_QUEUE_JOBS].join(', ')})`,
        );
        expect(PUSH_QUEUE_JOBS.size).toBeGreaterThanOrEqual(1);
    });

    it('the push queue name is distinct from the main and soil queues', () => {
        const t = code('src/app-layer/jobs/types.ts');
        const names = [...t.matchAll(/QUEUE_NAME\s*=\s*'([^']+)'/g)].map((m) => m[1]);

        expect(names.length).toBeGreaterThanOrEqual(3);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toContain(PUSH_QUEUE_NAME);
    });

    it('no job name is routed to two queues', () => {
        // Overlap would make the destination depend on the order of the checks
        // in `enqueue`, which is the kind of thing that works until somebody
        // reorders two ternaries for readability.
        const both = [...PUSH_QUEUE_JOBS].filter((n) => SOIL_QUEUE_JOBS.has(n));
        expect(both).toEqual([]);
    });

    it('enqueue ROUTES push jobs to the push queue', () => {
        const q = code('src/app-layer/jobs/queue.ts');

        expect(q).toMatch(/PUSH_QUEUE_JOBS\.has\(name\)/);
        expect(q).toMatch(/getPushQueue\(\)/);
        // And the factory exists, rather than the routing pointing at nothing.
        expect(q).toMatch(/export function getPushQueue\(\)/);
    });

    it('a Worker CONSUMES the push queue', () => {
        // The half that makes the rest real: a queue with no worker accepts
        // jobs and delivers none.
        const w = code('scripts/worker.ts');

        expect(w).toMatch(/new Worker\(\s*PUSH_QUEUE_NAME/);
    });

    it('the push worker carries its OWN limiter, not the main budget', () => {
        const w = code('scripts/worker.ts');
        const at = w.indexOf('new Worker(');
        const pushAt = w.indexOf('PUSH_QUEUE_NAME', at);
        expect(pushAt).toBeGreaterThan(-1);

        // The limiter block belonging to this worker — bounded by the next
        // `new Worker(` or the end, so it cannot borrow a sibling's.
        const nextWorker = w.indexOf('new Worker(', pushAt);
        const block = w.slice(pushAt, nextWorker === -1 ? undefined : nextWorker);

        expect(block).toMatch(/limiter:\s*\{/);
        expect(block).toMatch(/concurrency:\s*\d+/);
    });

    it('the push worker is CLOSED on shutdown', () => {
        // Otherwise SIGTERM leaves it consuming while the process is told to
        // stop, and a job claimed at that moment is retried after the restart.
        const w = code('scripts/worker.ts');

        expect(w).toMatch(/pushWorker\?\.close\(\)/);
    });

    it('push-send declares retry defaults, and they are SHORT', () => {
        const d = JOB_DEFAULTS['push-send'];

        expect(d.attempts).toBeGreaterThan(1);
        // A notification that arrives long after the event has been overtaken
        // by the person opening the app, so the backoff is bounded on purpose.
        const delay = (d.backoff as { delay?: number } | undefined)?.delay ?? 0;
        expect(delay).toBeLessThanOrEqual(10_000);
    });

    it('the executor for push-send is registered', () => {
        const r = code('src/app-layer/jobs/executor-registry.ts');

        expect(r).toMatch(/executorRegistry\.register\('push-send'/);
    });

    it('the task usecase ENQUEUES rather than awaiting the transports', () => {
        // The point of the change: a task assignment must not pay for the
        // latency of two third-party HTTP calls.
        const t = code('src/app-layer/usecases/task.ts');

        expect(t).toMatch(/enqueue\('push-send'/);
        expect(t).not.toMatch(/await sendWebPushToUser\(/);
        expect(t).not.toMatch(/await sendApnsToUser\(/);
    });
});
