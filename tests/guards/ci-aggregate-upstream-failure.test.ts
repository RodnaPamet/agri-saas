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
 * the ten required contexts and the always()/!cancelled() property that
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
        // No prerequisites, so this never reaches the GATED block; declared
        // so every entry has the same shape and `GATED` is the only filter.
        prereqSkipIsPass: true,
        // Every entry declares `outputs`, even the three that read none.
        // With `as const` a field present on ONE member is not on the union,
        // so `agg.outputs` was a TS2339 that jest never saw — ts-jest
        // transpiles without typechecking.
        outputs: {} as Record<string, string>,
    },
    {
        id: 'e2e',
        check: 'E2E',
        child: 'e2e-shard',
        prerequisites: ['changes', 'build'],
        childSkipIsPass: true,
        // `changes` is excluded from `merge_group`, so a skipped prerequisite
        // there is the schedule doing its job rather than a break.
        prereqSkipIsPass: true,
        outputs: {} as Record<string, string>,
    },
    {
        id: 'docker-summary',
        // EXACTLY this, including the ampersand. `Docker image build + scan`
        // is the near-identically-named job that is NOT a required context.
        check: 'Docker Build & Scan',
        child: 'docker',
        prerequisites: ['changes', 'build'],
        childSkipIsPass: true,
        prereqSkipIsPass: true,
        outputs: {} as Record<string, string>,
    },
    {
        // The FOURTH, added by #2676 — and its absence is why that defect
        // shipped. This registry held three while four required aggregates
        // existed, under a test named "all three aggregates exist and the
        // registry is complete": complete against a hand-written list of
        // three, inside the guard whose whole subject is a gate that scores
        // an unexamined population as a pass.
        //
        // It is also the only aggregate whose shell reads an OUTPUT rather
        // than only a `.result`, which is the likeliest reason it was left
        // out — the harness threw on anything but `needs.X.result`, loudly,
        // and extending it was the price of admission.
        id: 'selector-teeth-summary',
        check: 'Selector teeth',
        child: 'selector-teeth',
        prerequisites: ['selector-teeth-plan'],
        // A skipped matrix IS legitimate here, but only when the plan found
        // nothing — GitHub skips a matrix job whose include list is empty. The
        // `total` output is what separates that from a dropped partition, so
        // the default below is what makes this `true` honest.
        childSkipIsPass: true,
        // FALSE here, unlike its siblings, and measured rather than assumed:
        // `selector-teeth-plan` carries NO `if:` and NO `needs:`, so nothing
        // upstream can skip it and a skip is an anomaly — the same reasoning
        // that makes `test`'s own `childSkipIsPass` false. Forcing a pass on it
        // would green-tick an audit that never partitioned anything.
        prereqSkipIsPass: false,
        outputs: { 'selector-teeth-plan.total': '0' } as Record<string, string>,
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
function run(
    agg: Aggregate,
    results: Record<string, string>,
    outputs: Record<string, string> = {},
): Outcome {
    // `needs.X.outputs.Y`, keyed "X.Y" — #2676. An aggregate may branch on an
    // OUTPUT and not only on a `.result`, and `Selector teeth` does: its whole
    // non-obvious case is "the matrix skipped, so was there anything to
    // audit?", which only `total` answers.
    const outs: Record<string, string> = { ...(agg.outputs ?? {}), ...outputs };
    const filled = runScriptOf(agg).replace(EXPR, (_whole, expr: string) => {
        const trimmed = expr.trim();
        const r = /^needs\.([A-Za-z0-9_-]+)\.result$/.exec(trimmed);
        if (r) {
            if (!(r[1] in results)) {
                throw new Error(
                    `${agg.id}: shell reads needs.${r[1]}.result but the scenario ` +
                        `gives it no value. The scenario is incomplete, not the workflow.`,
                );
            }
            return results[r[1]];
        }
        const o = /^needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/.exec(trimmed);
        if (o) {
            const key = `${o[1]}.${o[2]}`;
            if (!(key in outs)) {
                throw new Error(
                    `${agg.id}: shell reads needs.${key.replace('.', '.outputs.')} but the ` +
                        `scenario gives it no value. The scenario is incomplete, not the workflow.`,
                );
            }
            return outs[key];
        }
        // Not a failure of the workflow — a failure of THIS harness to
        // model it. Say so loudly rather than substituting nothing and
        // testing a script that cannot behave like the real one.
        throw new Error(
            `${agg.id}: the harness cannot substitute \${{ ${trimmed} }}. ` +
                `Extend the scenario model before trusting these results.`,
        );
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
    it('every required aggregate is in the registry — derived, not counted by hand', () => {
        // #2676: this asserted `toHaveLength(3)` while FOUR required
        // aggregates existed, so the missing one's shell was never executed
        // and shipped a defect that failed a required check on main. A
        // hand-written count cannot notice its own omission, so the
        // population is now DERIVED: every job in ci.yml that reports a
        // required context and exists to summarise another job must appear.
        const sibling = fs.readFileSync(
            path.join(ROOT, 'tests/guards/required-checks-always-report.test.ts'),
            'utf8',
        );
        // The aggregates are exactly the required contexts whose job has a
        // `needs:` and a single `run:` step — a job that summarises others.
        const summaries = Object.entries(JOBS)
            .filter(([, j]) => needsOf(j).length > 0)
            .filter(([, j]) => (j.steps ?? []).filter((st) => typeof st.run === 'string').length === 1)
            .filter(([, j]) => sibling.includes(`'${String(j.name ?? '')}'`))
            .map(([id]) => id)
            .sort();

        const registered = AGGREGATES.map((a) => a.id).sort();
        console.log(`[ci-aggregates] ${registered.length} registered of ${summaries.length} derived`);
        // A floor, so a derivation that stops matching cannot pass over nothing.
        expect(summaries.length).toBeGreaterThanOrEqual(4);
        expect(registered).toEqual(summaries);
        expect(new Set(registered).size).toBe(registered.length);
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
/**
 * The `total` output, which is the one thing no other aggregate has — #2676.
 *
 * `Selector teeth` failed on main (run 41309116651) printing "the plan found
 * **  ** changed guard file(s)" — `$total` interpolated EMPTY, because the
 * plan's legitimately-baseless `exit 0` returned without writing the output
 * the aggregate reads. `[ "" = "0" ]` is false, so an unset output took the
 * failure branch and a correct build went red.
 *
 * The chain is worth stating because it is not obvious: an empty `total` also
 * makes the CHILD's `if:` (`total != '0'`) true, so the matrix job runs with
 * an empty include list, GitHub skips it, and the aggregate then sees
 * `skipped` with no count to justify it.
 */
describe('Selector teeth and the total it reads', () => {
    const agg = AGGREGATES.find((a) => a.id === 'selector-teeth-summary');
    // Not an `expect` inside the tests below: if the registry entry were
    // renamed away, every `it` would skip and the suite would still be green.
    if (!agg) throw new Error('selector-teeth-summary is not in AGGREGATES');
    const t = (total: string, child = 'skipped') =>
        run(agg, scenario(agg, { [agg.child]: child }), {
            'selector-teeth-plan.total': total,
        });

    it('PASSES on a skipped matrix when the plan counted ZERO', () => {
        // The legitimate case: no guard file changed, so there was nothing to
        // partition and the detector control in the plan still ran.
        const { code, out } = t('0');
        expect(code).toBe(0);
        expect(out).toContain('no guard files changed');
    });

    it('FAILS on a skipped matrix when the plan counted files — the dropped partition', () => {
        const { code, out } = t('5');
        expect(code).not.toBe(0);
        expect(out).toContain('::error::');
        // The count has to reach the operator, or the failure says less than
        // the silent pass it replaced.
        expect(out).toContain('5');
    });

    it('FAILS on an EMPTY total, and says the count is UNKNOWN rather than zero', () => {
        // THE REGRESSION. Before #2676 this took the "found $total changed
        // guard file(s)" arm and printed a blank where the number belongs —
        // failing a correct build with a message that described a different
        // defect.
        const { code, out } = t('');
        expect(code).not.toBe(0);
        expect(out).toContain('::error::');
        expect(out.toUpperCase()).toContain('UNKNOWN');
        // And it must NOT claim a count it does not have.
        expect(out).not.toMatch(/found\s+changed guard file/);
    });

    it('FAILS on an empty total even when the matrix SUCCEEDED', () => {
        // A green matrix does not license an unknown denominator: the
        // aggregate cannot say how many files those shards audited, which is
        // the same unexamined-population defect one level along.
        const { code } = t('', 'success');
        expect(code).not.toBe(0);
    });

    it('CONTROL: the plan WRITES a total on every path that exits 0', () => {
        // The source half, because the four assertions above are about the
        // aggregate's tolerance and this is about never needing it. Every
        // `exit 0` in the plan's shell must be preceded by a `total=` write —
        // otherwise a new early return reintroduces the empty output and only
        // the (now loud) aggregate catches it, after a red build.
        const plan = JOBS['selector-teeth-plan'];
        const script = (plan.steps ?? [])
            .map((st) => (typeof st.run === 'string' ? st.run : ''))
            .join('\n');
        expect(script).toContain('total=');
        const lines = script.split('\n');
        const exitZero = lines
            .map((l, i) => ({ l: l.trim(), i }))
            .filter((x) => /^exit 0( |;|$)/.test(x.l));
        // A floor: an extraction finding no `exit 0` would make this vacuous.
        expect(exitZero.length).toBeGreaterThanOrEqual(2);
        for (const { i } of exitZero) {
            const before = lines.slice(0, i).join('\n');
            expect(before).toMatch(/total=/);
        }
    });
});

describe('a broken prerequisite is not a content-only skip', () => {
    const GATED = AGGREGATES.filter((a) => a.prerequisites.length > 0);

    it('every aggregate with prerequisites is covered here', () => {
        // Was `toHaveLength(2)` with the two names written out, which went
        // stale the moment a third gated aggregate was registered (#2676).
        // Derived from the registry instead: the population is whoever has
        // prerequisites, and the floor is what stops a filter that matches
        // nothing from passing over it.
        console.log(`[ci-aggregates] ${GATED.length} aggregate(s) with prerequisites`);
        expect(GATED.length).toBeGreaterThanOrEqual(3);
        expect(GATED.every((a) => a.prerequisites.length > 0)).toBe(true);
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
            agg.prereqSkipIsPass
                ? 'still PASSES when prerequisite %s is itself SKIPPED (a legitimate skip chain)'
                : 'FAILS when prerequisite %s skipped — it carries no `if:`, so a skip is an anomaly',
            (prereq) => {
                // The reason the condition is `failure|cancelled` and not
                // `!= success`, which the issue first reached for: a
                // prerequisite skipped by the schedule / merge-queue `if:`
                // is not broken, and reddening on it reddens ordinary PRs.
                //
                // That argument is ABOUT THE PREREQUISITE, not about
                // aggregates in general, which is why it is now a per-entry
                // decision (#2676): `selector-teeth-plan` has no `if:` and no
                // `needs:`, so nothing can legitimately skip it.
                const { code } = run(
                    agg,
                    scenario(agg, { [agg.child]: 'skipped', [prereq]: 'skipped' }),
                );
                if (agg.prereqSkipIsPass) expect(code).toBe(0);
                else expect(code).not.toBe(0);
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
