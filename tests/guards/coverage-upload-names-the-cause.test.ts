/**
 * A missing shard coverage report must name its CAUSE, not just its absence.
 *
 * `Upload shard coverage` carries `if-no-files-found: error` and `if: always()`.
 * Both are right. The `error` is what makes a silently missing shard loud, and
 * it has to stay: istanbul's merge UNIONS the file set, so a dropped shard does
 * not depress coverage — it leaves the DENOMINATOR and the percentages RISE
 * (measured at 3 of 315 files dropped from `./src/lib/`: statements
 * 84.96 → 85.06). That is the case `--expect N` exists for.
 *
 * The problem is the pairing. `always()` runs the upload even when the shard
 * died BEFORE jest, and the upload's error is then the LAST one in the log, so
 * GitHub surfaces:
 *
 *     No files were found with the provided path: coverage-shard-1/coverage-final.json
 *
 * which reads as a coverage or artifact problem. Observed 2026-10-09 across all
 * six shards at once: the real cause was `docker pull postgres:16-trixie` being
 * refused, ~100 lines earlier and under a `##[group]`. Two agents nearly started
 * on the coverage machinery (#1546).
 *
 * ## Why this EXECUTES the step rather than asserting on its text
 *
 * The property is "a reader is sent to the right step", which is behaviour of
 * the emitted annotations. A `toContain('::warning')` on the shell source is
 * satisfied by a branch that is present and unreachable, and the whole point of
 * this step is that it fires on the path nobody exercises. So the step's own
 * `run:` block is lifted verbatim, its `${{ }}` expressions substituted, and
 * the result run under `bash -e` — GitHub's default for a `run:` step with no
 * `shell:` of its own. Same harness shape as
 * `tests/guards/ci-aggregate-upstream-failure.test.ts`.
 *
 * ## The distinction the step exists to draw
 *
 * Two causes, one symptom, and they need opposite reactions:
 *
 *   · tests did not succeed + no file  → the upload error is a CONSEQUENCE.
 *     Read the step above. A warning; retrying may well help.
 *   · tests SUCCEEDED + no file        → jest ran and wrote nothing. An error
 *     in its own right, because the merge would score a smaller denominator
 *     and read HIGHER. Retrying past it hides a real coverage hole.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

interface Step {
    name?: string;
    id?: string;
    if?: string;
    run?: string;
    with?: Record<string, unknown>;
}

const wf = yaml.load(
    fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
) as { jobs?: Record<string, { steps?: Step[] }> };

const testSteps = (): Step[] => wf.jobs?.test?.steps ?? [];
const stepNamed = (n: string): Step | undefined => testSteps().find((s) => s.name === n);

const EXPLAIN = 'Explain a missing coverage report before the upload errors on it';
const UPLOAD = 'Upload shard coverage';
const TESTS = 'Run tests: unit + integration (shard)';

interface Result {
    code: number;
    out: string;
}

/** Substitute the step's GitHub expressions and run it for real. */
function runExplain(opts: { outcome: string; writeFile: boolean }): Result {
    const script = (stepNamed(EXPLAIN)?.run ?? '').replace(
        /\$\{\{([^{}]*)\}\}/g,
        (_whole, expr: string) => {
            const e = expr.trim();
            if (e === 'matrix.shard') return '1';
            if (e === 'steps.shard_tests.outcome') return opts.outcome;
            // A harness gap, not a workflow bug. Say so rather than
            // substituting nothing and testing a script that cannot behave
            // like the real one.
            throw new Error(
                `the harness cannot substitute \${{ ${e} }} — extend the scenario model first`,
            );
        },
    );
    // An extraction that silently emptied would make every assertion below
    // pass for the wrong reason: `bash -e ''` exits 0 and emits nothing.
    expect(script.trim().length).toBeGreaterThan(0);
    expect(script).not.toContain('${{');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agri-1546-coverage-'));
    try {
        if (opts.writeFile) {
            fs.mkdirSync(path.join(dir, 'coverage-shard-1'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'coverage-shard-1/coverage-final.json'), '{}');
        }
        const file = path.join(dir, 'step.sh');
        fs.writeFileSync(file, script);
        const r = spawnSync('bash', ['-e', file], {
            encoding: 'utf8',
            cwd: dir,
            env: { ...process.env, TESTS_OUTCOME: opts.outcome },
        });
        // A spawn that never ran leaves status null; `null !== 0` would read as
        // a failing step rather than as a broken harness.
        expect(typeof r.status).toBe('number');
        return { code: r.status as number, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('a missing coverage report names its cause', () => {
    describe('the guard is reading the real job', () => {
        it('all three steps exist, in the order the explanation depends on', () => {
            const names = testSteps().map((s) => s.name);
            const iTests = names.indexOf(TESTS);
            const iExplain = names.indexOf(EXPLAIN);
            const iUpload = names.indexOf(UPLOAD);

            expect(iTests).toBeGreaterThan(-1);
            expect(iExplain).toBeGreaterThan(-1);
            expect(iUpload).toBeGreaterThan(-1);
            // The explanation must be emitted BEFORE the upload's error, or
            // GitHub still surfaces the artifact message as the last one.
            expect(iTests).toBeLessThan(iExplain);
            expect(iExplain).toBeLessThan(iUpload);
        });

        it('reads the outcome of the step that actually runs jest', () => {
            // `steps.<id>.outcome` resolves to an empty string for an
            // undeclared id, and the step would then take the "did not
            // succeed" branch on every clean run — crying wolf, which is the
            // failure mode the e2e naming step was reverted for once already.
            const referenced = JSON.stringify(stepNamed(EXPLAIN)).match(
                /steps\.([A-Za-z0-9_-]+)\.outcome/,
            )?.[1];
            expect(referenced).toBeTruthy();
            expect(stepNamed(TESTS)?.id).toBe(referenced);
        });

        it('leaves the upload error in place — it is the verdict', () => {
            // The explanation must not become a replacement for the gate. A
            // missing shard has to keep FAILING the job; this step only says
            // why.
            expect(stepNamed(UPLOAD)?.with?.['if-no-files-found']).toBe('error');
            expect(stepNamed(UPLOAD)?.if).toBe('always()');
        });

        it('runs on always(), or it is silent exactly when it is needed', () => {
            expect(stepNamed(EXPLAIN)?.if).toBe('always()');
        });
    });

    describe('what it emits', () => {
        it('says nothing when the report is there', () => {
            const r = runExplain({ outcome: 'success', writeFile: true });

            expect(r.code).toBe(0);
            expect(r.out).not.toMatch(/::warning|::error/);
        });

        it('points at the step above when the tests did not succeed', () => {
            const r = runExplain({ outcome: 'failure', writeFile: false });

            expect(r.code).toBe(0); // never fails the job — the upload owns that
            expect(r.out).toMatch(/::warning::/);
            expect(r.out).toContain('outcome=failure');
            expect(r.out).toMatch(/CONSEQUENCE, not the cause/);
            // The sentence that saves the next reader the hour it cost us.
            expect(r.out).toMatch(/Do NOT start on the coverage machinery/);
            expect(r.out).not.toMatch(/::error::/);
        });

        it('ERRORS when jest succeeded and still wrote nothing', () => {
            // The dangerous case, and the opposite reaction: a missing shard
            // RAISES merged coverage, so retrying past it hides a hole.
            const r = runExplain({ outcome: 'success', writeFile: false });

            expect(r.code).toBe(0);
            expect(r.out).toMatch(/::error::/);
            expect(r.out).toMatch(/RAISES merged coverage/);
            expect(r.out).toMatch(/do not retry past it/i);
        });

        it('SKIPPED takes the warning path — the likeliest real value', () => {
            // The test step carries no `if:`, so a failure in `Apply Prisma
            // migrations` (or any earlier step) leaves it SKIPPED rather than
            // failed. That is the most probable non-success outcome in
            // practice, and it must not fall through to the jest-succeeded
            // branch and accuse jest of writing nothing.
            const r = runExplain({ outcome: 'skipped', writeFile: false });

            expect(r.out).toMatch(/::warning::/);
            expect(r.out).toContain('outcome=skipped');
            expect(r.out).not.toMatch(/::error::/);
        });

        it('an EMPTY outcome stays on the safe path', () => {
            // `steps.<undeclared>.outcome` resolves to the empty string. A
            // structural test above pins the id, but if that ever drifts the
            // runtime behaviour must fail SAFE — a warning pointing upstream,
            // never an error accusing jest. Asserted because the comparison is
            // `= "success"`, and getting it backwards would make the empty
            // case the error case.
            const r = runExplain({ outcome: '', writeFile: false });

            expect(r.out).toMatch(/::warning::/);
            expect(r.out).not.toMatch(/::error::/);
        });

        it('cancelled behaves like any other non-success', () => {
            // A cancelled shard is the shape a timeout or an OOM takes, and it
            // must not fall through to the jest-succeeded branch.
            const r = runExplain({ outcome: 'cancelled', writeFile: false });

            expect(r.out).toMatch(/::warning::/);
            expect(r.out).toContain('outcome=cancelled');
            expect(r.out).not.toMatch(/::error::/);
        });
    });
});
