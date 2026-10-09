/**
 * A flake that passes on retry must still leave its evidence (#1492).
 *
 * ## The defect this pins
 *
 * Both Playwright artifact uploads were `if: ${{ failure() || cancelled() }}`
 * — the SHARD's verdict. `retries: 2`, so a spec that fails twice and passes on
 * the third attempt concludes the shard `success`, and the two attempts whose
 * traces would diagnose it were discarded with the runner.
 *
 * The consequence is backwards: **the better the retries work, the less
 * diagnosable the flake becomes.** Only a flake bad enough to exhaust all three
 * attempts produced evidence, and the one trace that has ever diagnosed #1076
 * existed purely because that run happened to fail 3-of-3.
 *
 * The reporting side of this was already fixed — "Name the failing specs"
 * classifies a retried flake against the ledger rather than staying silent. The
 * evidence side never caught up, and that is all this guards.
 *
 * ## Why the condition is published by the detection step
 *
 * `✘` in the Playwright `list` output marks a failed ATTEMPT, whatever the
 * shard concluded. That step already computes it, so the upload reads its
 * output rather than re-deriving the same thing from the same log — two
 * spellings of one policy is how they drift apart.
 *
 * ## The three failures this file exists to catch
 *
 *   1. the condition silently narrowing back to `failure()`, which restores the
 *      original defect and breaks nothing;
 *   2. the condition silently WIDENING to `always()`, which is the inverse
 *      failure — evidence kept for every green run is as useless as evidence
 *      kept for none, and it surfaces as a storage bill rather than a test;
 *   3. the output being set inside one of the detection step's several exit
 *      branches, so a path that returns early leaves it unset — and an unset
 *      output is indistinguishable from "no attempt failed" at an `if:`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const CI_YML = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PW_CONFIG = fs.readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8');

const OUTPUT = 'had_failed_attempt';

/** The `if:` line of each named step, in file order. */
function conditionsOf(stepName: string): string[] {
    const out: string[] = [];
    const lines = CI_YML.split('\n');
    lines.forEach((line, i) => {
        if (!line.includes(`- name: ${stepName}`)) return;
        // The `if:` sits within the next few lines of the step's block.
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
            if (/^\s*-\s+name:/.test(lines[j])) break;
            if (/^\s*if:/.test(lines[j])) {
                out.push(lines[j].trim());
                break;
            }
        }
    });
    return out;
}

const UPLOAD_STEPS = [
    'Upload Playwright HTML report',
    'Upload test results (traces, screenshots, videos)',
];

describe('a retried flake still uploads its artifacts', () => {
    it('control: both upload steps were found and each has a condition', () => {
        // Without this, every assertion below passes vacuously if a step is
        // renamed — `conditionsOf` would return [] and `.every()` on an empty
        // array is true. That is the exact shape of guard this repo keeps
        // finding, so it is pinned first.
        for (const step of UPLOAD_STEPS) {
            expect(conditionsOf(step)).toHaveLength(1);
        }
    });

    it('each upload fires when an ATTEMPT failed, not only when the shard did', () => {
        for (const step of UPLOAD_STEPS) {
            expect(conditionsOf(step)[0]).toContain(OUTPUT);
        }
    });

    it('each upload still fires on outright failure and cancellation', () => {
        // The new condition ADDS a case; it must not replace the two that
        // covered a run which died before writing a log at all.
        for (const step of UPLOAD_STEPS) {
            const cond = conditionsOf(step)[0];
            expect(cond).toContain('failure()');
            expect(cond).toContain('cancelled()');
        }
    });

    it('no upload is unconditional — evidence for everything is evidence for nothing', () => {
        // The inverse failure. `always()` here would pay artifact storage on
        // every green run, which is what the original condition's own comment
        // declined to do, and it would be invisible until someone read a bill.
        for (const step of UPLOAD_STEPS) {
            expect(conditionsOf(step)[0]).not.toContain('always()');
        }
    });
});

describe('the condition is published on every path that can reach the upload', () => {
    it('is set BEFORE the outcome branch, not inside one', () => {
        // The detection step has several `exit 0` paths. An output written
        // inside the non-success branch is unset on the green-shard path — and
        // the green-shard path is the only one this change exists for, so that
        // mistake would produce a guard that passes and a fix that does
        // nothing. Asserted by position: the first write must precede the
        // branch that reads E2E_OUTCOME.
        const firstWrite = CI_YML.indexOf(`${OUTPUT}=true`);
        const outcomeBranch = CI_YML.indexOf('if [ "${E2E_OUTCOME}" != "success" ]');

        expect(firstWrite).toBeGreaterThan(-1);
        expect(outcomeBranch).toBeGreaterThan(-1);
        expect(firstWrite).toBeLessThan(outcomeBranch);
    });

    it('the no-log path sets it too, rather than leaving it unset', () => {
        // That path knows neither "an attempt failed" nor "none did". It says
        // `false` and relies on `failure()` to cover it — which is only sound
        // because the assertion above keeps `failure()` in the condition.
        const noLog = CI_YML.indexOf('No Playwright log for shard');
        const before = CI_YML.slice(Math.max(0, noLog - 600), noLog);

        expect(before).toContain(`${OUTPUT}=false`);
    });

    it('both values are published, so a green shard is distinguishable', () => {
        expect(CI_YML).toContain(`${OUTPUT}=true`);
        expect(CI_YML).toContain(`${OUTPUT}=false`);
    });

    it('the detection step has the id the upload refers to', () => {
        // A condition naming a step id that does not exist evaluates to an
        // empty string, compares false, and silently restores the old
        // behaviour — green tests, no upload.
        expect(CI_YML).toMatch(/id:\s*failing_specs/);
        for (const step of UPLOAD_STEPS) {
            expect(conditionsOf(step)[0]).toContain('steps.failing_specs.outputs');
        }
    });
});

describe('the cost of widening the condition is bounded', () => {
    it('video is retained on failure, not recorded for every test', () => {
        // Measured on a real shard-2 artifact: `video: 'on'` produced 94 files
        // / 24.1 MB, against 29.9 MB of trace for the three failed attempts
        // that were the actual evidence. Widening the upload without this makes
        // every retry-passed flake — most runs — pay for videos of tests that
        // passed, and that is what gets this reverted on cost rather than on
        // merit.
        expect(PW_CONFIG).toMatch(/video:\s*'retain-on-failure'/);
        expect(PW_CONFIG).not.toMatch(/video:\s*'on'/);
    });

    it('the trace policy still keeps the FIRST failed attempt', () => {
        // `on-first-retry` would hand over a directory with a trace for attempt
        // 2 and nothing for attempt 1 — and attempt 1 is the cold one that
        // failed. An uploaded directory with no trace for the failure is worse
        // than no upload, because it reads as evidence that was gathered.
        expect(PW_CONFIG).toMatch(/trace:\s*'retain-on-failure'/);
    });
});
