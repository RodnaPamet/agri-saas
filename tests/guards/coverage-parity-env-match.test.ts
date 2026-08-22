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

const coverageJob = ci.jobs.coverage;
const referenceJob = ref.jobs.reference;

/** The step that actually invokes jest, in either workflow. */
function jestStep(job: Job): string {
    const step = (job.steps ?? []).find((s) => (s.run ?? '').includes('jest.js'));
    if (!step) throw new Error('no step invoking jest.js was found');
    return step.run as string;
}

describe('coverage parity: the reference run must match the sharded job', () => {
    it('both jobs exist — the guard fails loudly if either is renamed', () => {
        expect(coverageJob).toBeDefined();
        expect(referenceJob).toBeDefined();
    });

    it('declares an IDENTICAL job-level env', () => {
        // Deep equality both ways: a var added to either side trips this.
        expect(referenceJob.env).toEqual(coverageJob.env);
    });

    it('declares IDENTICAL services — postgres only, no redis on either side', () => {
        expect(referenceJob.services).toEqual(coverageJob.services);

        // Stated explicitly as well as structurally, because "no redis" is the
        // specific trap and a future reader should see it named.
        expect(Object.keys(referenceJob.services ?? {})).toEqual(['postgres']);
        expect(Object.keys(coverageJob.services ?? {})).toEqual(['postgres']);
    });

    it('runs the same jest flags, differing ONLY by --shard', () => {
        const shardedFlags = jestStep(coverageJob);
        const referenceFlags = jestStep(referenceJob);

        for (const flag of ['--coverage', '--forceExit', '--runInBand', '--coverageReporters=json']) {
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

    // ── Mutation proof ──────────────────────────────────────────────────
    // The assertions above are only meaningful if they can FAIL. A guard that
    // compares two things which happen to be equal for an unrelated reason is
    // the exact failure mode this repo keeps finding.
    it('detects an env drift (proof the comparison is live)', () => {
        const drifted = {
            ...(referenceJob.env as Record<string, unknown>),
            REDIS_URL_TEST: 'redis://localhost:6379',
        };
        expect(drifted).not.toEqual(coverageJob.env);
    });

    it('detects a service drift (proof the comparison is live)', () => {
        const drifted = {
            ...(referenceJob.services as Record<string, unknown>),
            redis: { image: 'redis:7-alpine' },
        };
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
