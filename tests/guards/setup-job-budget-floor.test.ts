/**
 * A job that installs dependencies must be able to OUTLIVE the install.
 *
 * `.github/actions/setup-node-prisma` retries `npm ci` three times with
 * `fetch-timeout` at 300s and has NO `timeout-minutes` of its own — composite
 * actions cannot carry one. So the install's effective ceiling is the JOB's
 * budget. When a slow registry uses that up, the step killed is the one AFTER
 * the install: the step the job exists to run.
 *
 * That failure reports as CANCELLED, which is the part that makes it worth a
 * guard rather than a comment. A cancelled check is neither a pass nor a
 * failure — it does not appear in a naive pass/fail summary at all, it keeps
 * no log buffer, and it names no cause. It is precisely the silent mode #778
 * was written to eliminate, in the jobs #778 did not cover.
 *
 * Measured 2026-09-04 across 24 recent Lint/Typecheck runs:
 *
 *     Setup Node + Prisma client   min 45s · median 214s · MAX 448s
 *     Run tsc --noEmit             ~47s
 *     lint/typecheck budget        480s (8 min)   ->  448 + 47 = 495s
 *
 * Four PRs were cancelled that way on the day this guard was written. The
 * floor below is the `security` job's own reasoning — "the install step
 * retries up to 3x at 150s each, so the worst case is ~8 min of install"
 * (ci.yml) — applied to every job that makes the same call.
 *
 * This is a SOURCE-SHAPE assertion and contributes no runtime coverage; it is
 * the right tool here because the claim is "this configuration value is not
 * below this floor", which is a fact about the file. What it CANNOT tell you
 * is whether a job actually completes — only a run does that.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const CI = path.join(ROOT, '.github/workflows/ci.yml');

/**
 * Minutes. Below this, a job cannot survive the install's own documented
 * worst case (~8 min) plus any work of its own.
 */
const FLOOR_MINUTES = 10;

interface Job {
    'timeout-minutes'?: number;
    steps?: Array<{ uses?: string; name?: string }>;
}

const doc = yaml.load(fs.readFileSync(CI, 'utf8')) as { jobs: Record<string, Job> };

function installingJobs(): Array<[string, Job]> {
    return Object.entries(doc.jobs).filter(([, job]) =>
        (job.steps ?? []).some((s) => (s.uses ?? '').includes('setup-node-prisma')),
    );
}

describe('jobs that install dependencies can outlive the install', () => {
    it('finds the jobs it is meant to be checking', () => {
        // Anti-vacuity. If the action were renamed or the parse shape changed,
        // every assertion below would pass over an empty list — the exact
        // failure this repo keeps finding.
        expect(installingJobs().length).toBeGreaterThanOrEqual(6);
    });

    it.each(installingJobs().map(([name, job]) => [name, job]))(
        '%s declares a budget at or above the install worst case',
        (name, job) => {
            const budget = (job as Job)['timeout-minutes'];
            // An ABSENT budget is worse than a small one: the runner default
            // is 360 minutes, so a hung install burns six hours of runner time
            // before anyone hears about it.
            expect(typeof budget).toBe('number');
            expect(budget).toBeGreaterThanOrEqual(FLOOR_MINUTES);
        },
    );
});
