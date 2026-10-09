/**
 * A non-green E2E shard must NAME the specs that failed.
 *
 * ## What this protects
 *
 * #748: a main push run hit `timeout-minutes: 40`, GitHub CANCELLED the job,
 * and the cancellation concealed two genuine failures —
 *
 *     ✘ 54 [chromium] tests/e2e/auth.spec.ts:151:9 › Middleware Auth Guard …
 *     ✘ 59 [chromium] tests/e2e/ciso-portfolio.spec.ts:115:9 › CISO portfolio …
 *
 * — because `cancelled` reads as infrastructure noise and a cancelled job
 * produces no summary. Main was left unverified and nobody looked.
 *
 * #991 fixed half of that: a shell budget turns an overrun into a step
 * FAILURE, so the log and artifacts survive. This guard protects the other
 * half, which is the one the issue actually asks for — the failing spec names
 * must reach the checks UI, not sit in 25 minutes of log output that costs a
 * scroll or an artifact download to read.
 *
 * ## The three ways it silently stops working
 *
 * 1. **The step loses `always()`.** A cancelled job skips every step without
 *    it, which is the exact mechanism that made the original failures
 *    invisible. A step that does not run in the case it exists for is not a
 *    safeguard.
 * 2. **The log stops being written.** The extractor reads a file the test step
 *    tees; without `pipefail` around that tee the pipeline reports `tee`'s
 *    status and an overrun would read as a pass, and without the tee there is
 *    no file at all. Both are silent.
 * 3. **The marker drifts.** This is the subtle one and the reason this file
 *    exists rather than a one-line grep. The extractor matches U+2718, which
 *    only the `list` reporter emits. Switch `playwright.config.ts` to `dot`,
 *    `json` or `github` and the grep matches nothing — and "no failures
 *    found" is byte-identical to "my pattern is stale". The empty selection
 *    reads as a pass, which is the defect class this repo keeps paying for
 *    and precisely what the step was added to end.
 *
 * So the marker and the reporter are asserted to AGREE, derived from the two
 * files independently rather than restated here.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

interface Step {
    name?: string;
    id?: string;
    if?: string;
    run?: string;
}
interface Workflow {
    jobs?: Record<string, { steps?: Step[] }>;
}

const wf = yaml.load(read('.github/workflows/ci.yml')) as Workflow;
const shardSteps = (): Step[] => wf.jobs?.['e2e-shard']?.steps ?? [];
const stepNamed = (n: string): Step | undefined => shardSteps().find((s) => s.name === n);

const RUN_STEP = 'Run E2E tests';
const NAME_STEP = 'Name the failing specs';

describe('a non-green E2E shard names its failures', () => {
    describe('the guard is reading the real job', () => {
        it('the e2e-shard job parses and has steps', () => {
            // Without this every `find` below returns undefined and each
            // assertion would be written against nothing. Note the job is
            // `e2e-shard`; `e2e` is the one-step aggregate and reading it
            // instead would silently examine an empty step list.
            expect(shardSteps().length).toBeGreaterThan(5);
        });

        it('both steps this guard is about exist', () => {
            expect(stepNamed(RUN_STEP)).toBeDefined();
            expect(stepNamed(NAME_STEP)).toBeDefined();
        });
    });

    it('the naming step runs on always(), or a cancelled shard skips it', () => {
        // The entire failure mode in #748 is that a cancellation skips steps.
        // `failure()` is NOT sufficient and neither is the default.
        expect(stepNamed(NAME_STEP)?.if).toMatch(/always\(\)/);
    });

    it('the test step tees its output to the file the naming step reads', () => {
        const run = stepNamed(RUN_STEP)?.run ?? '';
        const namer = stepNamed(NAME_STEP)?.run ?? '';
        expect(run).toContain('tee');
        // Derived on both sides: the producer's path and the consumer's path
        // must be the same expression, not two similar-looking literals.
        const written = run.match(/tee "([^"]+)"/)?.[1];
        const readBack = namer.match(/LOG="([^"]+)"/)?.[1];
        expect(written).toBeTruthy();
        expect(readBack).toBeTruthy();
        expect(readBack).toBe(written);
    });

    it('the tee cannot mask a non-zero exit', () => {
        // A pipeline reports its LAST command and `tee` essentially always
        // succeeds, so without pipefail an overrun reads as a pass — the tee
        // added here would have introduced the very blindness it documents.
        expect(stepNamed(RUN_STEP)?.run).toMatch(/set -o pipefail/);
    });

    it("the extractor's marker is one the configured CI reporter actually emits", () => {
        // The anti-drift assertion. U+2718 is emitted by the `list` reporter;
        // `dot`, `json` and `github` do not print it. If the reporter changes
        // and this does not, the grep matches nothing and the step reports
        // silence — indistinguishable from a clean run.
        const namer = stepNamed(NAME_STEP)?.run ?? '';
        expect(namer).toContain('✘');

        const cfg = read('playwright.config.ts');
        const reporterLine = cfg.split('\n').find((l) => l.includes('reporter:'));
        expect(reporterLine).toBeTruthy();
        // The CI branch of the ternary must still include the list reporter.
        expect(reporterLine).toMatch(/isCI\s*\?\s*\[\s*\[\s*'list'/);
    });

    it('an empty extraction is reported, not passed over in silence', () => {
        // "Found no failures" and "my pattern is stale" are the same bytes.
        // When the shard did not succeed and nothing matched, the step must
        // say so — this is the whole lesson of the issue, one level down.
        const namer = stepNamed(NAME_STEP)?.run ?? '';
        expect(namer).toMatch(/E2E_OUTCOME/);
        expect(namer).toMatch(/::warning::/);
    });

    it('a ✘ is only an ERROR when the shard did not succeed', () => {
        // Measured on run 35427726541: a SUCCESSFUL shard 1 emitted two
        // `::error::` annotations for specs that had failed once and passed
        // on retry. `retries: 2`, so the list reporter prints a ✘ per failed
        // ATTEMPT — a green shard routinely contains them.
        //
        // A step that reports failures on passing runs gets ignored, which is
        // the same ending as the silence it was written to fix. So the error
        // branch must be gated on the outcome, not on the marker alone.
        // Anchor on the EMISSION, not on any mention of it: the step's own
        // comments explain why the error branch is gated, so `indexOf
        // ('::error::')` finds the prose first and reports the opposite of
        // the truth. Strip `#` comment lines before locating anything — the
        // same reason `worker-heartbeat-wiring` carries a `code()` helper.
        const namer = (stepNamed(NAME_STEP)?.run ?? '')
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n');
        const errIdx = namer.indexOf('echo "::error::');
        const gateIdx = namer.indexOf('"${E2E_OUTCOME}" != "success"');
        expect(errIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeGreaterThan(-1);
        // The gate must OPEN the branch the annotation sits in.
        expect(gateIdx).toBeLessThan(errIdx);
    });

    it('a ✘ on a GREEN shard is still reported, as a flake', () => {
        // The other direction. Dropping the green branch entirely would
        // satisfy the assertion above and silently discard flake evidence —
        // and `gh run rerun` already overwrites the job conclusion, so the
        // run that saw the flake is the only place the record can live.
        const namer = stepNamed(NAME_STEP)?.run ?? '';
        expect(namer).toMatch(/::notice::/);
        expect(namer).toMatch(/retry/i);
    });

    it('the naming step can see the test step outcome it branches on', () => {
        // `steps.e2e.outcome` resolves only if the run step carries that id.
        const namer = stepNamed(NAME_STEP);
        const referenced = JSON.stringify(namer).match(/steps\.([A-Za-z0-9_-]+)\.outcome/)?.[1];
        expect(referenced).toBeTruthy();
        expect(stepNamed(RUN_STEP)?.id).toBe(referenced);
    });
});

/**
 * On a RED shard, a recovered flake must not be announced as a failure (#1529).
 *
 * `retries: 2`, so a spec that failed an attempt and passed a later one prints
 * both a ✘ and a ✓. The red branch used to annotate every ✘ as `::error` and
 * return, which did two things: it reported a recovered flake as a failure, and
 * it skipped the ledgered/unledgered split entirely — so a brand-new flake
 * arrived looking exactly like the failure that reddened the shard.
 *
 * Measured on run 37959012790: `88 passed  1 failed  1 flaky`, two ✘ lines,
 * both `::error`. One was the real failure; the other was
 * `tooltip-and-copy.spec.ts:125` "SCIM endpoint — CopyButton writes to
 * clipboard", which recovered on retry and is NOT in the ledger — the ledgered
 * entry for that file is a different test. A new flake appeared and nothing
 * said so.
 *
 * WHY THIS EXECUTES THE STEP rather than asserting on its text: the sibling
 * assertions above can only show that a branch is PRESENT. Whether a ✘ with a
 * later ✓ reaches `::notice` instead of `::error` is behaviour, and a `toMatch`
 * on the shell source is satisfied by a condition that is present and
 * unreachable. The teeth have to be on the emitted annotations. The step's own
 * `run:` block is lifted verbatim, `${{ matrix.shard }}` substituted, and the
 * result run under `bash -e` — GitHub's default for a `run:` step with no
 * `shell:` of its own. There is no second copy of the logic to drift.
 */
describe('a red shard still tells a recovered flake from a failure', () => {
    /** One `list`-reporter line. `marker` is U+2718 or U+2713. */
    const attempt = (marker: string, n: number, spec: string, line: number, title: string) =>
        `  ${marker}  ${n} [chromium] › tests/e2e/${spec}:${line}:9 › a suite › ${title}`;

    /** A real ledger entry, read from disk — never a hardcoded title, which a
     *  prune at review would turn into a test about nothing. */
    const ledgered = (() => {
        const l = JSON.parse(read('tests/e2e/known-flakes.json')) as {
            flakes: { spec: string; title: string }[];
        };
        expect(Array.isArray(l.flakes)).toBe(true);
        expect(l.flakes.length).toBeGreaterThan(0);
        return l.flakes[0];
    })();

    interface Result {
        code: number;
        out: string;
        summary: string;
    }

    function runNamer(outcome: string, logLines: string[]): Result {
        const script = (stepNamed(NAME_STEP)?.run ?? '').replace(
            /\$\{\{([^{}]*)\}\}/g,
            (_whole, expr: string) => {
                if (expr.trim() !== 'matrix.shard') {
                    // A harness failure, not a workflow failure. Say so rather
                    // than substituting nothing and testing a script that
                    // cannot behave like the real one.
                    throw new Error(
                        `the harness cannot substitute \${{ ${expr.trim()} }} — ` +
                            `extend the scenario model before trusting these results`,
                    );
                }
                return '2';
            },
        );
        // An extraction that silently emptied would make every assertion below
        // pass for the wrong reason: `bash -e ''` exits 0 and emits nothing.
        expect(script.trim().length).toBeGreaterThan(0);
        expect(script).not.toContain('${{');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agri-1529-namer-'));
        try {
            fs.writeFileSync(path.join(dir, 'e2e-shard-2.log'), `${logLines.join('\n')}\n`);
            const outFile = path.join(dir, 'gh-output');
            const sumFile = path.join(dir, 'gh-summary');
            fs.writeFileSync(outFile, '');
            fs.writeFileSync(sumFile, '');
            const file = path.join(dir, 'step.sh');
            fs.writeFileSync(file, script);
            // `cwd: ROOT` so the step's own relative `tests/e2e/known-flakes.json`
            // resolves to the real ledger, as it does on a runner.
            const r = spawnSync('bash', ['-e', file], {
                encoding: 'utf8',
                cwd: ROOT,
                env: {
                    ...process.env,
                    RUNNER_TEMP: dir,
                    E2E_OUTCOME: outcome,
                    GITHUB_OUTPUT: outFile,
                    GITHUB_STEP_SUMMARY: sumFile,
                },
            });
            // A spawn that never ran leaves status null, and `null !== 0` would
            // read as a failing gate rather than as a broken harness.
            expect(typeof r.status).toBe('number');
            return {
                code: r.status as number,
                out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
                summary: fs.readFileSync(sumFile, 'utf8'),
            };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    const errors = (out: string) =>
        out
            .split('\n')
            .filter((l) => l.startsWith('::error::'))
            .join('\n');

    it('errors on the spec that never recovered, and ONLY on that one', () => {
        const r = runNamer('failure', [
            // Never recovered: ✘ with no later ✓ for the same spec:line.
            attempt('✘', 15, 'hard-failure.spec.ts', 10, 'never passed on any attempt'),
            // Recovered, and in the ledger.
            attempt('✘', 20, ledgered.spec, 20, ledgered.title),
            attempt('✓', 21, ledgered.spec, 20, ledgered.title),
            // Recovered, and NOT in the ledger — the case that went unreported.
            attempt('✘', 30, 'brand-new-flake.spec.ts', 30, 'nobody ledgered this one'),
            attempt('✓', 31, 'brand-new-flake.spec.ts', 30, 'nobody ledgered this one'),
            '',
            '  1 failed',
            '  2 flaky',
        ]);

        expect(r.code).toBe(0);
        expect(errors(r.out)).toContain('hard-failure.spec.ts');
        // The whole point: neither recovered spec is announced as a failure.
        expect(errors(r.out)).not.toContain('brand-new-flake.spec.ts');
        expect(errors(r.out)).not.toContain(ledgered.spec);
        expect(errors(r.out).split('\n').filter(Boolean)).toHaveLength(1);
    });

    it('runs the LEDGER check on a red shard, so a new flake still shouts', () => {
        // What #1529 was filed for. Before the fix this branch never ran on a
        // red shard, and an unledgered flake was indistinguishable from the
        // failure that reddened it.
        const r = runNamer('failure', [
            attempt('✘', 15, 'hard-failure.spec.ts', 10, 'never passed on any attempt'),
            attempt('✘', 20, ledgered.spec, 20, ledgered.title),
            attempt('✓', 21, ledgered.spec, 20, ledgered.title),
            attempt('✘', 30, 'brand-new-flake.spec.ts', 30, 'nobody ledgered this one'),
            attempt('✓', 31, 'brand-new-flake.spec.ts', 30, 'nobody ledgered this one'),
        ]);

        // A known flake stays the notice it already was...
        expect(r.out).toMatch(/::notice::flaky \(known/);
        expect(r.out).toContain(ledgered.title);
        // ...and a new one earns a warning that names the ledger.
        expect(r.out).toMatch(/::warning::NEW flake/);
        const newFlakeLine = r.out
            .split('\n')
            .find((l) => l.startsWith('::warning::NEW flake'));
        expect(newFlakeLine).toContain('brand-new-flake.spec.ts');
        // And the real failure is not reclassified as a flake in either basket.
        expect(newFlakeLine).not.toContain('hard-failure.spec.ts');
    });

    it('counts a line it cannot key as FAILED, never as recovered', () => {
        // The fail-loud direction. If the reporter's format drifts so the
        // `tests/e2e/<spec>:<line>:<col>` key stops matching, this must
        // over-report failures rather than silently reclassify every ✘ as a
        // flake — which would be the #1076 silence again, reached from the
        // other side.
        const r = runNamer('failure', [
            '  ✘  15 [chromium] › a line in some future format with no keyable path',
            '  ✓  16 [chromium] › a line in some future format with no keyable path',
        ]);

        expect(r.code).toBe(0);
        expect(errors(r.out)).toContain('no keyable path');
    });

    it('a GREEN shard is unchanged — no errors, everything classified', () => {
        // The reverted-error experiment (run 35427726541) is still right: a
        // step that cries wolf on clean runs gets ignored. This fix must not
        // reintroduce that by routing green-shard lines through the red branch.
        const r = runNamer('success', [
            attempt('✘', 20, ledgered.spec, 20, ledgered.title),
            attempt('✓', 21, ledgered.spec, 20, ledgered.title),
        ]);

        expect(r.code).toBe(0);
        expect(errors(r.out)).toBe('');
        expect(r.out).toMatch(/::notice::flaky \(known/);
    });

    it('still shouts when a red shard produced no ✘ at all', () => {
        // The empty case this step was written for — "found no failures" and
        // "my pattern no longer matches" are the same output. Moving it ahead
        // of the new partition must not have dropped it.
        const r = runNamer('failure', ['  some log with no failure markers at all']);

        expect(r.code).toBe(0);
        expect(r.out).toMatch(/::warning::E2E shard 2 did not succeed/);
        expect(r.out).toMatch(/no '✘' line was found/);
    });
});
