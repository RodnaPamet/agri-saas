/**
 * The key-rotation drill is WIRED, not merely present.
 *
 * `tests/drills/key-rotation-drill.test.ts` runs only when
 * `KEY_ROTATION_DRILL=1`, because the sweeps it drives re-encrypt every row in
 * the database and the sharded test matrix runs against ONE shared database.
 * That gate is necessary and it is also a liability: a suite that disables
 * itself on a missing environment variable exits 0 with nothing run, and every
 * aggregate above it scores that as success. This repo has already recorded
 * that shape — "a check that never RAN is ABSENT, not red".
 *
 * So the pairing between the gate and the job that satisfies it is enforced
 * here rather than remembered. Each case below fails for a DIFFERENT way the
 * drill could stop running while the suite stayed green:
 *
 *   · the job is deleted or renamed              → nothing sets the flag
 *   · the flag is removed from the job            → the suite skips
 *   · the job stops pointing at `tests/drills`    → it runs the wrong thing
 *   · the job is path-gated on `changes`          → it is SKIPPED on most
 *                                                   merges, and a skipped
 *                                                   required check passes
 *   · the passing-count floor is removed          → a skip exits 0
 *   · a new drill file forgets the gate           → it runs in the shards and
 *                                                   corrupts the shared DB
 *
 * P1.10's exit criterion is "the key-rotation drill is green on 3 consecutive
 * main runs". That sentence is only answerable if the drill is a NAMED check
 * that runs on every main push, which is what the first and fourth cases are
 * about.
 */
import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const CI_PATH = path.join(ROOT, '.github/workflows/ci.yml');


/** The job's id in ci.yml. The NAME is asserted separately — both matter. */
const JOB_ID = 'key-rotation-drill';
const JOB_NAME = 'Key rotation drill';
const FLAG = 'KEY_ROTATION_DRILL';

interface Job {
    name?: string;
    needs?: string | string[];
    if?: string;
    env?: Record<string, unknown>;
    steps?: Array<{ name?: string; run?: string; uses?: string }>;
}

const ci = yaml.load(fs.readFileSync(CI_PATH, 'utf8')) as { jobs?: Record<string, Job> };
const job: Job | undefined = ci.jobs?.[JOB_ID];

describe('the key-rotation drill is wired into CI', () => {
    it('the job exists, under the name P1.10 refers to', () => {
        expect(job).toBeDefined();
        // The NAME is what appears as a check and what a "green on 3
        // consecutive main runs" query is written against, so renaming it
        // silently breaks the exit criterion rather than the build.
        expect(job?.name).toBe(JOB_NAME);
    });

    it('the job sets the flag that enables the suite', () => {
        // Without this the suite's `describe.skip` branch is taken and the job
        // is green over zero drill tests.
        expect(String(job?.env?.[FLAG])).toBe('1');
    });

    it('the job runs the drill DIRECTORY, so a second drill file is picked up', () => {
        const runs = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');
        expect(runs).toContain('tests/drills');
        // And it must not have been narrowed to the one file that exists
        // today — a path that names a single suite silently excludes the next.
        expect(runs).not.toContain('tests/drills/key-rotation-drill.test.ts');
    });

    it('the job is NOT gated on the `changes` path filter', () => {
        // ci.yml's own banner: "a skipped required check counts as passing
        // under branch protection". A drill that skips on a docs-only merge
        // cannot answer "green on 3 consecutive main runs".
        const needs = Array.isArray(job?.needs) ? job?.needs : job?.needs ? [job.needs] : [];
        expect(needs).not.toContain('changes');
        expect(job?.if ?? '').not.toContain('changes');
    });

    it('the job FAILS a run that reports too few passing tests', () => {
        // The positive control for the flag. `jest --ci` over a skipped suite
        // exits 0, so the exit code alone cannot tell a passing drill from an
        // absent one; the step reads `numPassedTests` and refuses a low count.
        const runs = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');
        expect(runs).toContain('numPassedTests');
        expect(runs).toMatch(/-lt\s+\d+/);
    });

    it('the job declares its OWN database service', () => {
        // Sharing the sharded matrix's database is the thing the flag exists
        // to prevent; a job without its own service would be sharing one.
        const raw = fs.readFileSync(CI_PATH, 'utf8');
        const start = raw.indexOf(`  ${JOB_ID}:`);
        expect(start).toBeGreaterThan(-1);
        // Bounded by the next top-level job key rather than a fixed number of
        // lines, so the window cannot drift as the job grows.
        const rest = raw.slice(start + 1);
        const nextJob = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
        const block = nextJob === -1 ? rest : rest.slice(0, nextJob);
        expect(block).toContain('services:');
        expect(block).toContain('postgres:');
    });
});

describe('every drill suite is gated, or it runs in the sharded matrix', () => {
    /**
     * `collectSourceFiles`, not a hand-rolled `readdirSync`.
     *
     * The first version of this block walked the directory itself and carried
     * its own `length >= 1` positive control — which works, and
     * `tests/guards/file-collection-is-not-silently-empty.test.ts` failed it
     * anyway. That guard's reason is better than mine: a hand-rolled collector
     * can be gutted to return `[]` with every assertion built on it still
     * green, measured at 81 percent of the guards an automated sweep could
     * audit. A control I remembered to write is not the same as a collector
     * that cannot return empty, and `floor` makes it the latter.
     */
    const files = collectSourceFiles({ roots: ['tests/drills'], floor: 1 }).filter((f) =>
        f.endsWith('.test.ts'),
    );

    it('there is at least one drill — an empty set would pass every case below', () => {
        expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it.each(files.map((f) => [path.basename(f), f]))(
        '%s reads the gate, so it is inert in the shards',
        (_name, file) => {
            const src = fs.readFileSync(file as string, 'utf8');
            expect(src).toContain(`process.env.${FLAG}`);
            // And it must actually BRANCH on it. A file that read the variable
            // and ignored it would satisfy the line above while still sweeping
            // the shared database.
            expect(src).toMatch(/describe\.skip/);
        },
    );
});
