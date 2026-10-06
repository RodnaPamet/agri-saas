/**
 * A required aggregate must not pass because its children never RAN.
 *
 * #1301, observed: a GitHub API 503 inside `dorny/paths-filter` failed the
 * `Detect changes` job. Both `e2e-shard` matrix jobs are gated on its
 * outputs, so both were SKIPPED. The required `E2E` aggregate treated
 * `skipped` as a pass, and the gate reported success for a run in which no
 * E2E test executed — including the #1289 audit-write gate that exists
 * precisely to stop a silent zero.
 *
 * A required check that is SKIPPED counts as PASSING in GitHub branch
 * protection. That fact is not a bug and is not what this guard changes —
 * CLAUDE.md records it, and it is why the coverage gate was folded into
 * `test` rather than left `if:`-gated.
 *
 * THE DISTINCTION THIS GUARD HOLDS, and it is narrow:
 *
 *   · content-only skip  — a docs-only PR genuinely needs no E2E run, and
 *     the aggregate passing on that is CORRECT. Make every skip fail and
 *     every docs PR goes red; someone reverts you, and the hole reopens.
 *   · broken-prerequisite skip — the detector itself failed, so "nothing
 *     changed" was never established. Nothing ran and nothing said so.
 *
 * Both arrive at the aggregate as `skipped`. `needs.<job>.result` is the
 * only thing that separates them, which is why each aggregate now reads the
 * result of every job it depends on.
 *
 * WHY THIS EXECUTES THE WORKFLOW'S OWN SHELL rather than asserting about
 * its text: a `toContain('failure|cancelled')` passes on a condition that
 * is present but unreachable — a `case` arm below a catch-all, an `exit 1`
 * in a subshell. The teeth have to be on the EXIT CODE. So the `run:` block
 * is lifted out of ci.yml verbatim, its `${{ needs.X.result }}` expressions
 * are substituted with a scenario's values, and the result is executed
 * under `bash -e` — the same shell GitHub uses for a `run:` step with no
 * `shell:` of its own. There is no second copy of the logic to drift, and
 * no wiring gap: the thing under test IS the workflow.
 *
 * Sibling guard: tests/guards/required-checks-always-report.test.ts pins
 * the nine required contexts and the always()/!cancelled() property that
 * keeps these aggregates REPORTING. This one pins what they report.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '..', '..');
const CI = path.join(ROOT, '.github/workflows/ci.yml');

interface Step {
    name?: string;
    run?: string;
}
interface Job {
    name?: string;
    if?: unknown;
    needs?: string | string[];
    steps?: Step[];
}

const JOBS = (
    yaml.load(fs.readFileSync(CI, 'utf8')) as { jobs: Record<string, Job> }
).jobs;

/**
 * The three required contexts that register AFTER their children and so can
 * report a verdict about work that did not happen. The other six required
 * contexts (`Build`, `Lint`, `Typecheck`, `Security`, `CodeQL SAST
 * (javascript-typescript)`, `Coverage (≥60%)`) do their own work in their
 * own job, so there is no child whose absence they could misread.
 *
 * `childSkipIsPass` is the whole design decision, stated per aggregate:
 *   · E2E / Docker — their children carry a `needs.changes.outputs.*`
 *     filter, so a skip has a legitimate meaning and must stay green.
 *   · Test — `test` has no `needs:` and no path filter. Nothing upstream
 *     can skip it, so a skipped `test` is an anomaly, not a docs PR.
 */
const AGGREGATES = [
    {
        id: 'test-summary',
        check: 'Test',
        child: 'test',
        prerequisites: [] as string[],
        childSkipIsPass: false,
    },
    {
        id: 'e2e',
        check: 'E2E',
        child: 'e2e-shard',
        prerequisites: ['changes', 'build'],
        childSkipIsPass: true,
    },
    {
        id: 'docker-summary',
        // EXACTLY this, including the ampersand. `Docker image build + scan`
        // is the near-identically-named job that is NOT a required context.
        check: 'Docker Build & Scan',
        child: 'docker',
        prerequisites: ['changes', 'build'],
        childSkipIsPass: true,
    },
] as const;

type Aggregate = (typeof AGGREGATES)[number];

/** Every `${{ ... }}` GitHub expression. Two braces, so bash's own
 *  `${up#*:}` parameter expansions are untouched. */
const EXPR = /\$\{\{([^{}]*)\}\}/g;

function needsOf(job: Job): string[] {
    const n = job.needs ?? [];
    return (Array.isArray(n) ? n : [n]).map(String);
}

/** The single `run:`-bearing step of an aggregate. */
function runScriptOf(agg: Aggregate): string {
    const job = JOBS[agg.id];
    expect(job).toBeDefined();
    const runs = (job.steps ?? []).filter((s) => typeof s.run === 'string');
    // Exactly one, deliberately. A second step changes what the job's exit
    // code means, and the substitution model below would be reasoning about
    // a fragment. If you add one, re-derive this harness first.
    expect(runs).toHaveLength(1);
    const script = runs[0].run as string;
    // An extraction that silently empties would make every "must PASS"
    // assertion below pass for the wrong reason. `bash -e ''` exits 0.
    expect(script.trim().length).toBeGreaterThan(0);
    return script;
}

/** The jobs whose `.result` the aggregate's shell actually reads. */
function resultsRead(agg: Aggregate): string[] {
    const found = new Set<string>();
    for (const [, expr] of runScriptOf(agg).matchAll(EXPR)) {
        const m = /^needs\.([A-Za-z0-9_-]+)\.result$/.exec(expr.trim());
        if (m) found.add(m[1]);
    }
    return [...found].sort();
}

interface Outcome {
    code: number;
    out: string;
}

/**
 * Substitute a scenario into the lifted shell and run it.
 *
 * `bash -e <file>` mirrors GitHub's default for a `run:` step with no
 * `shell:` key — the workflow sets no `defaults.run.shell`.
 */
function run(agg: Aggregate, results: Record<string, string>): Outcome {
    const filled = runScriptOf(agg).replace(EXPR, (_whole, expr: string) => {
        const m = /^needs\.([A-Za-z0-9_-]+)\.result$/.exec(expr.trim());
        if (!m) {
            // Not a failure of the workflow — a failure of THIS harness to
            // model it. Say so loudly rather than substituting nothing and
            // testing a script that cannot behave like the real one.
            throw new Error(
                `${agg.id}: the harness cannot substitute \${{ ${expr.trim()} }}. ` +
                    `Extend the scenario model before trusting these results.`,
            );
        }
        if (!(m[1] in results)) {
            throw new Error(
                `${agg.id}: shell reads needs.${m[1]}.result but the scenario ` +
                    `gives it no value. The scenario is incomplete, not the workflow.`,
            );
        }
        return results[m[1]];
    });
    // Total substitution. A leftover expression would be passed to bash as
    // literal text and could change the exit code for a reason unrelated to
    // the condition under test.
    expect(filled).not.toContain('${{');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agri-1301-aggregate-'));
    try {
        const file = path.join(dir, 'step.sh');
        fs.writeFileSync(file, filled);
        const r = spawnSync('bash', ['-e', file], { encoding: 'utf8' });
        // A spawn that never ran leaves status null; `null !== 0` would read
        // as "the gate failed", and a null in a pass-assertion would read as
        // nothing at all. Demand a real number.
        expect(typeof r.status).toBe('number');
        return { code: r.status as number, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** All prerequisites + the child green, then apply overrides. */
function scenario(agg: Aggregate, overrides: Record<string, string> = {}) {
    const base: Record<string, string> = { [agg.child]: 'success' };
    for (const p of agg.prerequisites) base[p] = 'success';
    return { ...base, ...overrides };
}

describe('the required aggregates are wired to see an upstream failure', () => {
    it('all three aggregates exist and the registry is complete', () => {
        // A deleted entry shrinks the population silently; an empty
        // population makes every it.each below vacuous.
        expect(AGGREGATES).toHaveLength(3);
        expect(new Set(AGGREGATES.map((a) => a.id)).size).toBe(3);
    });

    it.each(AGGREGATES)('$id carries the required name "$check" verbatim', (agg) => {
        // Renaming a required context makes it ABSENT at the gate, and
        // absence reads as success — strictly worse than the bug this
        // guard closes. Byte-exact, ampersand included.
        expect(JOBS[agg.id]?.name).toBe(agg.check);
    });

    it.each(AGGREGATES)('$check is still pinned by the required-checks guard', (agg) => {
        // Cross-link, not a second pin: if the sibling guard's mirror of
        // branch protection drops one of these names, this reddens too
        // rather than leaving the aggregate unpinned at the gate.
        const sibling = fs.readFileSync(
            path.join(ROOT, 'tests/guards/required-checks-always-report.test.ts'),
            'utf8',
        );
        expect(sibling).toContain(`'${agg.check}'`);
    });

    it.each(AGGREGATES)('$id keeps reporting when a dependency fails or skips', (agg) => {
        // Without always()/!cancelled(), GitHub skips a job whose `needs`
        // skipped — so adding `changes` and `build` to these aggregates
        // would have taken the required check down with its prerequisites:
        // pending forever, which reads as "nothing wrong yet".
        expect(String(JOBS[agg.id]?.if ?? '')).toMatch(/always\(\)|!\s*cancelled\(\)/);
    });

    it.each(AGGREGATES)(
        '$id reads the result of EVERY job in its needs, and needs every job it reads',
        (agg) => {
            const declared = needsOf(JOBS[agg.id]).sort();
            const read = resultsRead(agg);
            const expected = [agg.child, ...agg.prerequisites].sort();

            expect(declared).toEqual(expected);
            // The two directions fail differently and both matter.
            // read ⊉ needs: a prerequisite can fail and the aggregate never
            //   looks — #1301 exactly.
            // needs ⊉ read: `needs.X.result` for an undeclared X evaluates
            //   to the empty string at runtime, so the check is inert.
            expect(read).toEqual(expected);
        },
    );
});

describe('the lifted condition behaves — exit codes, not text', () => {
    it('HARNESS CONTROL: the runner reports a non-zero exit as non-zero', () => {
        // Without this, every "must FAIL" assertion below could be passing
        // because the runner always returns 0.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agri-1301-control-'));
        try {
            const red = path.join(dir, 'red.sh');
            const green = path.join(dir, 'green.sh');
            fs.writeFileSync(red, 'exit 1\n');
            fs.writeFileSync(green, 'exit 0\n');
            expect(spawnSync('bash', ['-e', red]).status).toBe(1);
            expect(spawnSync('bash', ['-e', green]).status).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    describe.each(AGGREGATES)('$check', (agg) => {
        it('passes when everything succeeded', () => {
            expect(run(agg, scenario(agg)).code).toBe(0);
        });

        it('FAILS when the child reports failure', () => {
            const { code, out } = run(agg, scenario(agg, { [agg.child]: 'failure' }));
            expect(code).not.toBe(0);
            expect(out).toContain('::error::');
        });

        it('FAILS when the child reports cancelled', () => {
            const { code, out } = run(agg, scenario(agg, { [agg.child]: 'cancelled' }));
            expect(code).not.toBe(0);
            expect(out).toContain('::error::');
        });

        it('FAILS on an empty child result — fails closed, never open', () => {
            // What GitHub substitutes for a job that is not in `needs`.
            const { code } = run(agg, scenario(agg, { [agg.child]: '' }));
            expect(code).not.toBe(0);
        });

        it(
            agg.childSkipIsPass
                ? 'PASSES when the child skipped and every prerequisite is green (the docs-only PR)'
                : 'FAILS when the child skipped — this gate has no legitimate skip',
            () => {
                const { code } = run(agg, scenario(agg, { [agg.child]: 'skipped' }));
                if (agg.childSkipIsPass) expect(code).toBe(0);
                else expect(code).not.toBe(0);
            },
        );
    });
});

/**
 * The #1301 proof itself. Only the two gates with prerequisites can express
 * the defect; `Test` has none, which is the audited reason it needed no
 * change. `describe.each` over an empty list is a silent PASS, so the
 * population is asserted before it is used.
 */
describe('a broken prerequisite is not a content-only skip', () => {
    const GATED = AGGREGATES.filter((a) => a.prerequisites.length > 0);

    it('two of the three aggregates have prerequisites that can break', () => {
        expect(GATED).toHaveLength(2);
        expect(GATED.map((a) => a.check).sort()).toEqual([
            'Docker Build & Scan',
            'E2E',
        ]);
    });

    describe.each(GATED)('$check', (agg) => {
        it.each(agg.prerequisites)(
            'FAILS when the child is merely skipped but prerequisite %s FAILED',
            (prereq) => {
                // The measured run: `changes` 503s, the children skip, and
                // before this fix the aggregate said success.
                const { code, out } = run(
                    agg,
                    scenario(agg, { [agg.child]: 'skipped', [prereq]: 'failure' }),
                );
                expect(code).not.toBe(0);
                expect(out).toContain('::error::');
                // The operator has to be told WHICH prerequisite, or the
                // failure is as undiagnosable as the silent pass was.
                expect(out).toContain(prereq);
            },
        );

        it.each(agg.prerequisites)(
            'FAILS when the child is skipped and prerequisite %s was CANCELLED',
            (prereq) => {
                const { code } = run(
                    agg,
                    scenario(agg, { [agg.child]: 'skipped', [prereq]: 'cancelled' }),
                );
                expect(code).not.toBe(0);
            },
        );

        it.each(agg.prerequisites)(
            'still PASSES when prerequisite %s is itself SKIPPED (a legitimate skip chain)',
            (prereq) => {
                // The reason the condition is `failure|cancelled` and not
                // `!= success`, which the issue first reached for: a
                // prerequisite skipped by the schedule / merge-queue `if:`
                // is not broken, and reddening on it reddens ordinary PRs.
                const { code } = run(
                    agg,
                    scenario(agg, { [agg.child]: 'skipped', [prereq]: 'skipped' }),
                );
                expect(code).toBe(0);
            },
        );

        it.each(agg.prerequisites)(
            'FAILS a succeeded child under a FAILED prerequisite %s — fails closed',
            (prereq) => {
                // Not reachable today (a failed prerequisite skips the
                // child, it cannot succeed). Pinned because the direction
                // it fails in is the safe one, and because an unreachable
                // state becoming reachable should not quietly open a hole.
                const { code } = run(
                    agg,
                    scenario(agg, { [agg.child]: 'success', [prereq]: 'failure' }),
                );
                expect(code).not.toBe(0);
            },
        );
    });
});
