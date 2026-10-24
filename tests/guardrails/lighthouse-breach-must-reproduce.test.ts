/**
 * The Lighthouse gate's own shell, EXECUTED — #2207.
 *
 * ## Why this runs the loop instead of reading it
 *
 * The gate's pass/fail semantics live in about twenty lines of bash inside a
 * workflow, and #2207 is a case where those semantics were wrong in a way no
 * amount of reading caught: a single 5-run median was treated as final on a
 * page whose LCP is bimodal across the bound. The fix — a breach must
 * reproduce before it fails the job — is control flow, and control flow
 * asserted by grepping the script for `breaches` would pass against a loop
 * that increments the counter and never reads it.
 *
 * So this extracts the step's `run:` block from the workflow, substitutes a
 * STUB for the lhci invocation, and runs the real loop under bash. Every
 * assertion below is about what the gate did, not about what it says.
 *
 * ## What the stub replaces, and what it must not
 *
 * Only the `timeout … npx @lhci/cli …` line is replaced, by a function that
 * pops the next scripted outcome and writes the canned log the real tool would
 * have written. The loop, the counter, the branches, the exits and the
 * annotations are the workflow's own text. `sleep` is stubbed to return at
 * once so three attempts cost no wall-clock, and the script runs in a temp
 * directory because it begins with `rm -rf .lighthouseci`.
 *
 * If the extraction ever stops finding the step or the lhci line, these tests
 * FAIL rather than skip — an extraction that silently empties would make every
 * assertion here pass over nothing, which is the defect this file exists to
 * prevent one level down.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/lighthouse.yml');
const STEP_NAME = 'Gate: Lighthouse mobile budget';

/** The step's shell, straight from the workflow. */
function gateScript(): string {
    const doc = yaml.parse(fs.readFileSync(WORKFLOW, 'utf8')) as {
        jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
    const step = steps.find((s) => s.name === STEP_NAME);
    if (!step?.run) {
        throw new Error(
            `"${STEP_NAME}" has no run: block in ${WORKFLOW}. If the step was renamed, `
                + 'update STEP_NAME — do not let this test pass over nothing.',
        );
    }
    return step.run;
}

/** The lhci call, matched from `timeout` to the line that captures its status. */
const LHCI_CALL = /^\s*timeout\s+-k\s+\d+\s+\d+\s+npx[\s\S]*?\|\|\s*status=\$\?\s*$/m;

/**
 * One scripted attempt.
 *
 * `budget` writes the assertion table the gate greps for, so the loop takes
 * the breach branch. `collect` writes a log WITHOUT it, which is how a crashed
 * Chrome looks — the case the retry loop was built for.
 */
type Outcome = { kind: 'pass' } | { kind: 'budget'; lcp: number } | { kind: 'collect' };

const ASSERTION_TABLE = (lcp: number) =>
    [
        'Checking assertions against 1 URL(s), 5 total run(s)',
        '  X  largest-contentful-paint failure for maxNumericValue assertion',
        '        expected: <=3800',
        `           found: ${lcp}`,
        '      all values: 2066.278, 4105.168, 4121.923, 4124.123, 4281.702',
    ].join('\\n');

function runGate(outcomes: Outcome[]) {
    const script = gateScript();
    expect(script).toMatch(LHCI_CALL); // extraction is not vacuous
    const stubbed = script.replace(LHCI_CALL, '            lhci_stub || status=$?');

    const cases = outcomes
        .map((o, i) => {
            const body =
                o.kind === 'budget'
                    ? `printf '%b\\n' "${ASSERTION_TABLE(o.lcp)}" > "$log"; return 1`
                    : o.kind === 'collect'
                      ? `echo "Run #1...failed! NO_NAVSTART" > "$log"; return 7`
                      : `echo "Done running Lighthouse!" > "$log"; return 0`;
            return `      ${i + 1}) ${body} ;;`;
        })
        .join('\n');

    const prelude = [
        'set -u',
        'call=0',
        'lhci_stub() {',
        '  call=$((call + 1))',
        '  case "$call" in',
        cases,
        // An attempt the scenario did not script is a test-authoring error, not
        // a pass. Returning 0 here would quietly convert "the loop ran more
        // times than expected" into a green gate.
        '      *) echo "UNSCRIPTED ATTEMPT $call" >&2; return 99 ;;',
        '  esac',
        '}',
        'sleep() { :; }',
        '',
    ].join('\n');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhgate-'));
    const file = path.join(dir, 'gate.sh');
    fs.writeFileSync(file, `${prelude}${stubbed}\n`);
    // `scripts/` is symlinked in rather than running this in the repo root,
    // for two reasons that both bit: the gate calls
    // `node scripts/ci/lighthouse-breach.mjs` by a RELATIVE path, so in a bare
    // temp directory it silently did not run (`|| true` swallowed it, which is
    // the reporter behaving correctly and the test measuring nothing); and the
    // loop opens with `rm -rf .lighthouseci`, which must never be aimed at a
    // real checkout.
    fs.symlinkSync(path.resolve(__dirname, '../../scripts'), path.join(dir, 'scripts'), 'dir');
    const r = spawnSync('bash', [file], { cwd: dir, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('the Lighthouse gate requires a breach to reproduce (#2207)', () => {
    it('extracts a real loop — the control over this whole file', () => {
        const script = gateScript();
        expect(script).toContain('for attempt in 1 2 3');
        expect(script).toContain('Checking assertions against');
        expect(script).toMatch(LHCI_CALL);
    });

    it('passes on the first attempt without mentioning a breach', () => {
        const { code, out } = runGate([{ kind: 'pass' }]);
        expect(code).toBe(0);
        expect(out).toContain('::notice::Lighthouse passed');
        expect(out).not.toContain('breach');
    });

    it('does NOT fail on a single breach — it re-collects', () => {
        // The behaviour #2207 asked for. One breach on a bimodal metric is a
        // draw, not a verdict.
        const { code, out } = runGate([{ kind: 'budget', lcp: 4121.923 }, { kind: 'pass' }]);
        expect(code).toBe(0);
        expect(out).toContain('re-collecting ONCE');
        expect(out).toContain('PASSED on re-collection');
        expect(out).toContain('mode draw');
    });

    it('announces the unreproduced breach rather than hiding it', () => {
        // A silent pass would conceal exactly the flapping this issue opened
        // on: the page sitting close enough to its bound to land either side.
        const { out } = runGate([{ kind: 'budget', lcp: 4121.923 }, { kind: 'pass' }]);
        expect(out).toContain('::warning::');
        expect(out).toContain('sitting close enough to its bound');
    });

    it('still reports the measurement on the first breach', () => {
        // The reporter runs on EVERY breach, not only the fatal one, so a
        // warning that something flapped always carries its numbers.
        const { out } = runGate([{ kind: 'budget', lcp: 4121.923 }, { kind: 'pass' }]);
        expect(out).toContain('largest-contentful-paint');
        expect(out).toContain('bound <=3800 ms');
    });

    it('FAILS when the breach reproduces — a real regression is still caught', () => {
        // #2239's regression breached twice, medians 4122 ms then 4172 ms.
        // This is the case that must stay red.
        const { code, out } = runGate([
            { kind: 'budget', lcp: 4121.923 },
            { kind: 'budget', lcp: 4172.015 },
        ]);
        expect(code).not.toBe(0);
        expect(out).toContain('BUDGET failed TWICE');
        expect(out).toContain('verdict about the page');
        // Both measurements present, so the reader can compare them.
        expect((out.match(/largest-contentful-paint:/g) ?? []).length).toBe(2);
    });

    it('does not spend a third attempt once the breach has reproduced', () => {
        // Exiting on the second breach rather than rolling again is what keeps
        // this from being "retry until it passes". A third scripted attempt
        // would be consumed if the loop continued.
        const { out } = runGate([
            { kind: 'budget', lcp: 4121.923 },
            { kind: 'budget', lcp: 4172.015 },
            { kind: 'pass' },
        ]);
        expect(out).toContain('BUDGET failed TWICE');
        expect(out).not.toContain('::notice::Lighthouse passed');
    });

    it('retries a COLLECTION failure without counting it as a breach', () => {
        // The original #1901 behaviour, which this must not disturb: a run that
        // never navigated produced no data to judge.
        const { code, out } = runGate([{ kind: 'collect' }, { kind: 'pass' }]);
        expect(code).toBe(0);
        expect(out).toContain('COLLECTION failed before assertions');
        expect(out).not.toContain('breach');
        expect(out).not.toContain('mode draw');
    });

    it('fails an unreproduced breach when the attempts ran out', () => {
        // Collection failures eat the attempts, so the reproduction
        // requirement is never tested. Clearing the breach here would let a
        // real regression through whenever the runner is also flaky — an
        // absence reading as success.
        const { code, out } = runGate([
            { kind: 'collect' },
            { kind: 'collect' },
            { kind: 'budget', lcp: 4121.923 },
        ]);
        expect(code).not.toBe(0);
        expect(out).toContain('attempts ran out before it could be re-collected');
        expect(out).toContain('unreproduced breach is unmeasured, not cleared');
        // And it must not misreport itself as a collection failure.
        expect(out).not.toContain('collection failed 3/3');
    });

    it('still reports a pure collection failure as one', () => {
        const { code, out } = runGate([
            { kind: 'collect' },
            { kind: 'collect' },
            { kind: 'collect' },
        ]);
        expect(code).not.toBe(0);
        expect(out).toContain('collection failed 3/3');
        expect(out).not.toContain('unreproduced breach');
    });
});
