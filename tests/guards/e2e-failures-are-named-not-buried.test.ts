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
import * as fs from 'node:fs';
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

    it('the naming step can see the test step outcome it branches on', () => {
        // `steps.e2e.outcome` resolves only if the run step carries that id.
        const namer = stepNamed(NAME_STEP);
        const referenced = JSON.stringify(namer).match(/steps\.([A-Za-z0-9_-]+)\.outcome/)?.[1];
        expect(referenced).toBeTruthy();
        expect(stepNamed(RUN_STEP)?.id).toBe(referenced);
    });
});
