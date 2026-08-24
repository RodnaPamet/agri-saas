/**
 * The coverage PARITY proof is only as good as its environment match.
 *
 * `.github/workflows/coverage-reference.yml` runs the whole suite in one
 * unsharded process and diffs its coverage map against the sharded merge that
 * `ci.yml`'s `coverage` + `coverage-gate` jobs produce for the same commit. A
 * clean diff is the evidence for dropping `--report-only` and letting the gate
 * enforce again.
 *
 * That evidence is worthless if the two runs did not execute the same tests.
 *
 * The concrete hazard, already documented in ci.yml and load-bearing enough to
 * guard: `tests/integration/bullmq-real-api.test.ts` gates on `REDIS_URL_TEST`
 * and SKIPS without it. The coverage job deliberately runs postgres ONLY. Add a
 * redis service to one side and not the other and the parity diff reports a
 * genuine difference that says nothing whatsoever about sharding — or, worse,
 * add it to BOTH later and silently move `./src/lib/`, which is a re-flooring
 * event hiding inside a diff that reads as pure infrastructure.
 *
 * Neither failure announces itself. A mismatched env does not error; it just
 * makes the verdict mean something other than what it claims. Hence a guard.
 *
 * This asserts SHAPE, not coverage levels — it never needs updating when
 * numbers move, only when the two jobs genuinely diverge.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

type Job = {
    env?: Record<string, unknown>;
    services?: Record<string, unknown>;
    steps?: Array<{ name?: string; run?: string; uses?: string }>;
    'timeout-minutes'?: number;
};
type Workflow = { jobs: Record<string, Job> };

function load(rel: string): Workflow {
    return yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as Workflow;
}

const ci = load('.github/workflows/ci.yml');
const ref = load('.github/workflows/coverage-reference.yml');

const coverageJob = ci.jobs.test; // coverage is collected by the `test` job
const referenceJob = ref.jobs.reference;

/** The step that actually invokes jest, in either workflow. */
function jestStep(job: Job): string {
    const step = (job.steps ?? []).find((s) => (s.run ?? '').includes('jest.js'));
    if (!step) throw new Error('no step invoking jest.js was found');
    return step.run as string;
}

describe('coverage parity: the reference run must match the sharded job', () => {
    it('both jobs exist — the guard fails loudly if either is renamed', () => {
        // `coverageJob` is ci.yml's `test` job: coverage was folded into it so
        // the gate could run on PULL REQUESTS and therefore actually block a
        // merge. While it lived in its own job it was main-push only, and a
        // required check that reports SKIPPED counts as PASSING — theatre.
        expect(coverageJob).toBeDefined();
        expect(referenceJob).toBeDefined();
    });

    it('declares an IDENTICAL job-level env', () => {
        // Deep equality both ways: a var added to either side trips this.
        expect(referenceJob.env).toEqual(coverageJob.env);
    });

    it('declares IDENTICAL services — redis on BOTH sides or neither', () => {
        expect(referenceJob.services).toEqual(coverageJob.services);

        // Named explicitly because redis is the specific trap, in both
        // directions. `tests/integration/bullmq-real-api.test.ts` gates on
        // REDIS_URL_TEST: without redis it SKIPS and its code never enters the
        // denominator; with redis it runs. A side that has redis while the
        // other does not is comparing two different populations, and the diff
        // reports a real difference that says nothing about sharding.
        //
        // This is not hypothetical — folding coverage into `test` (which has
        // redis) while this file still matched the old postgres-only coverage
        // job is exactly the drift this assertion caught.
        const services = Object.keys(coverageJob.services ?? {}).sort();
        expect(Object.keys(referenceJob.services ?? {}).sort()).toEqual(services);
        expect(services).toContain('postgres');
    });

    it('runs the same jest flags, differing ONLY by --shard', () => {
        const shardedFlags = jestStep(coverageJob);
        const referenceFlags = jestStep(referenceJob);

        // Only flags that can change the MEASURED POPULATION are required to
        // match. `--forceExit` is deliberately NOT in this list: it governs what
        // jest does after the tests have finished (exit despite open handles),
        // not which tests run or what gets instrumented, so it cannot move a
        // coverage number. The reference run keeps it because it is a single
        // ~90-minute process where a hang is expensive; the sharded side omits
        // it so a handle leak still surfaces as a failure rather than being
        // silently swallowed. That divergence is intentional — anything on this
        // list is not.
        for (const flag of ['--coverage', '--runInBand', '--coverageReporters=json']) {
            expect(shardedFlags).toContain(flag);
            expect(referenceFlags).toContain(flag);
        }

        // The sharded side shards; the reference side must not.
        expect(shardedFlags).toContain('--shard=');
        expect(referenceFlags).not.toContain('--shard=');

        // Same heap ceiling — an OOM on one side only would look like a
        // coverage difference.
        expect(shardedFlags).toContain('--max-old-space-size=8192');
        expect(referenceFlags).toContain('--max-old-space-size=8192');
    });

    it('bootstraps the database identically (RLS roles, pgvector, migrations)', () => {
        // A missing migration step changes which integration tests pass, and
        // therefore which lines are covered.
        const names = (job: Job) => (job.steps ?? []).map((s) => s.uses ?? s.name ?? '');
        for (const marker of ['./.github/actions/setup-node-prisma', './.github/actions/enable-pgvector']) {
            expect(names(coverageJob)).toContain(marker);
            expect(names(referenceJob)).toContain(marker);
        }
        const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? '').join('\n');
        expect(runs(coverageJob)).toContain('prisma migrate deploy');
        expect(runs(referenceJob)).toContain('prisma migrate deploy');
        expect(runs(coverageJob)).toContain('CREATE ROLE app_user');
        expect(runs(referenceJob)).toContain('CREATE ROLE app_user');
    });

    it('gives the unsharded run a budget larger than one shard', () => {
        // It measures the whole suite in one process — the thing sharding
        // exists to avoid — so it must not fail for the reason it is testing.
        expect(referenceJob['timeout-minutes']).toBeGreaterThan(
            coverageJob['timeout-minutes'] as number,
        );
    });

    it('resolves the dispatch ref ITSELF instead of handing it to actions/checkout', () => {
        // `actions/checkout` does not accept a SHORT sha. Given `ref: fd221856`
        // it treats the value as a ref-NAME pattern and runs
        //   git fetch --depth=1 origin +refs/heads/fd221856*:... +refs/tags/fd221856*:...
        // which matches nothing and fails with a bare
        //   The process '/usr/bin/git' failed with exit code 1
        // that never names the ref. Measured on this workflow's first real
        // dispatch (2026-08-22).
        //
        // This matters more than it looks: every `git log --oneline` and
        // `gh run list` in this repo prints the SHORT form, and the input asks
        // for "a commit sha" — so the short form is exactly what an operator
        // will paste. Resolving it ourselves accepts short, full, branch and tag.
        const steps = referenceJob.steps ?? [];
        const checkout = steps.find((s) => (s.uses ?? '').startsWith('actions/checkout')) as
            | { with?: Record<string, unknown> }
            | undefined;

        expect(checkout).toBeDefined();
        expect(checkout?.with?.ref).toBeUndefined();
        // Full history, or a short sha still will not resolve locally.
        expect(checkout?.with?.['fetch-depth']).toBe(0);

        const runs = steps.map((s) => s.run ?? '').join('\n');
        expect(runs).toContain('rev-parse --verify');
        expect(runs).toContain('git checkout --detach');
    });

    it('is dispatch-only — a long single-process run must never gate a push', () => {
        const raw = fs.readFileSync(
            path.join(ROOT, '.github/workflows/coverage-reference.yml'),
            'utf8',
        );
        const on = (yaml.load(raw) as { on: Record<string, unknown> }).on;
        expect(Object.keys(on)).toEqual(['workflow_dispatch']);
    });

    it('sets `pipefail` in every step that pipes — a pipeline hides its own failure', () => {
        // Measured 2026-08-22, run 32584730983: the parity step ended
        //   node scripts/diff-coverage.mjs ... | tee parity.txt
        // with no `set -o pipefail`. A pipeline's exit status is its LAST
        // command's, so `tee` returned 0 and swallowed diff-coverage's exit 1 —
        // the comparison reported COVERAGE PARITY FAILED for 53 files and the
        // JOB WENT GREEN. The step summary said FAILED simultaneously, so the
        // two signals disagreed, which is worse than a clean failure: the job
        // badge is what anyone reads first.
        //
        // Asserted as a RULE over every piped step rather than pinned to the
        // parity step, because the next pipeline someone adds has the same
        // problem and will not be this one.
        // Backslash CONTINUATIONS must be joined first. The real offender was
        // `| tee parity.txt` sitting on its own continuation line, where nothing
        // precedes the pipe — a naive per-line scan finds no token before `|`
        // and passes vacuously. That is precisely how the first version of this
        // very guard reported green against the bug it was written for.
        const logicalLines = (run: string): string[] => {
            const out: string[] = [];
            let acc = '';
            for (const raw of run.split('\n')) {
                const line = raw.trim();
                if (!acc && (line === '' || line.startsWith('#'))) continue;
                acc += (acc ? ' ' : '') + line.replace(/\\$/, '');
                if (!line.endsWith('\\')) {
                    out.push(acc);
                    acc = '';
                }
            }
            if (acc) out.push(acc);
            return out;
        };

        const offenders: string[] = [];
        for (const step of referenceJob.steps ?? []) {
            const run = step.run;
            if (!run) continue;
            const lines = logicalLines(run);
            // `run.includes('pipefail')` is WRONG and was the first version of
            // this check: the step's own explanatory COMMENT about pipefail
            // contains the word, so the step was skipped and the guard passed
            // vacuously against the very bug it was written for. Match an actual
            // `set` command on a comment-stripped line instead.
            if (lines.some((l) => /^set\b[^|]*\bpipefail\b/.test(l))) continue;
            for (const line of lines) {
                if (line.includes('||')) continue;
                if (/[\w"')\]]\s*\|\s*[\w$/]/.test(line)) {
                    offenders.push(`${step.name ?? '(unnamed)'}: ${line.slice(0, 90)}`);
                    break;
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    // ── Mutation proof ──────────────────────────────────────────────────
    // The assertions above are only meaningful if they can FAIL. A guard that
    // compares two things which happen to be equal for an unrelated reason is
    // the exact failure mode this repo keeps finding.
    it('detects an env drift (proof the comparison is live)', () => {
        const drifted = { ...(referenceJob.env as Record<string, unknown>) };
        delete drifted.REDIS_URL_TEST;
        expect(drifted).not.toEqual(coverageJob.env);
    });

    it('detects a service drift (proof the comparison is live)', () => {
        const drifted = { ...(referenceJob.services as Record<string, unknown>) };
        delete drifted.redis;
        expect(drifted).not.toEqual(coverageJob.services);
    });
});

describe('coverage parity: one copy of jest grouping, not two', () => {
    // The differ must group files exactly as the checker does, or it certifies
    // a population jest would never have scored. Both import the same module;
    // this keeps it that way.
    const shared = 'scripts/lib/coverage-groups.mjs';

    it.each([
        'scripts/check-coverage-thresholds.mjs',
        'scripts/diff-coverage.mjs',
    ])('%s imports the shared grouping module', (rel) => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        expect(src).toContain("from './lib/coverage-groups.mjs'");
    });

    it('the shared module exists and exports the grouping entry points', () => {
        const src = fs.readFileSync(path.join(ROOT, shared), 'utf8');
        for (const sym of ['assignGroups', 'combineCoverage', 'filesScoredForGroup']) {
            expect(src).toContain(`export function ${sym}`);
        }
    });

    it('neither script re-implements the group-assignment loop inline', () => {
        // The tell is jest's own distinctive prefix-match line. If it reappears
        // outside the shared module, the algorithm has been forked.
        const needle = 'groupTypeByThresholdGroup[group] = PATH';
        for (const rel of ['scripts/check-coverage-thresholds.mjs', 'scripts/diff-coverage.mjs']) {
            expect(fs.readFileSync(path.join(ROOT, rel), 'utf8')).not.toContain(needle);
        }
        expect(fs.readFileSync(path.join(ROOT, shared), 'utf8')).toContain(needle);
    });
});
