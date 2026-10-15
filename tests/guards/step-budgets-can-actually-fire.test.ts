/**
 * Guard: a step-level timeout is reachable, and the slow one reports itself (#1720).
 *
 * ## What went wrong
 *
 * `Free runner disk space` carried `timeout-minutes: 5` and this comment:
 *
 *     # measured max 119s over 8 successful jobs; 5m is ~2.5x (#748)
 *
 * Re-measured over 17 docker jobs on 2026-10-15, **119s is the MEDIAN**:
 *
 *     min 66s | median 119s | max successful 279s | p90 311s
 *     2 of 17 jobs hit the 5m bound and FAILED a required check
 *
 * Eight samples could not see a tail that seventeen make obvious, and nothing
 * re-measured it for as long as the gate stayed green. `a-number-that-does-
 * not-move`: a figure frozen in a comment goes stale in silence, and the only
 * event that reveals it is the red build it eventually causes.
 *
 * The fix is not a bigger constant. The step now writes its own phase
 * timings to `$GITHUB_STEP_SUMMARY`, so the distribution is observable from
 * any run and the next person to touch the bound reads numbers instead of
 * guessing from eight of them. This guard keeps that observability from
 * being tidied away, which is the thing a future cleanup would remove first.
 *
 * ## The other half: a budget that cannot fire
 *
 * Steps run in sequence, so a step budget only ever fires if the JOB outlives
 * it. A step bound at or above its job's is decorative: the job dies first,
 * and the failure names the job rather than the slow step — which is exactly
 * the attribution a step budget exists to provide.
 *
 * Checked across every workflow rather than just this one, because the defect
 * is a relationship between two numbers in different places, and that is the
 * kind nobody re-reads. 9 such steps today; the denominator is printed.
 *
 * Deliberately NOT asserted: that the step budgets within a job SUM to under
 * the job budget. The docker job's sum to 45 against a 35-minute job, and
 * that is fine — the pathological case the sum describes is "every step slow
 * at once", which is what the job budget is for. Measured: the one docker
 * job that ran to completion in the last twelve CI runs took 15 minutes of
 * its 35. Asserting the sum would fail a healthy file and get the guard
 * deleted.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { collectSourceFiles } from '../helpers/collect-files';

const WORKFLOWS = path.resolve(__dirname, '../../.github/workflows');

/**
 * Through `collectSourceFiles` rather than `readdirSync`, because
 * `file-collection-is-not-silently-empty` is right about what it prevents: a
 * hand-rolled collector can be gutted to return `[]` with every assertion
 * built on it still green — measured at 81% of the guards an automated sweep
 * could audit. The floor is what separates "no workflow has a bad budget"
 * from "no workflow was read", and this guard's claim is about a population.
 */
function workflowFiles(): string[] {
    return collectSourceFiles({
        roots: ['.github/workflows'],
        extensions: ['.yml', '.yaml'],
        floor: 8,
    });
}

interface Step {
    name?: string;
    run?: string;
    'timeout-minutes'?: number;
}
interface Job {
    'timeout-minutes'?: number;
    steps?: Step[];
}
interface Workflow {
    jobs?: Record<string, Job>;
}

interface Budgeted {
    file: string;
    job: string;
    step: string;
    stepBudget: number;
    jobBudget?: number;
}

function collect(): Budgeted[] {
    const out: Budgeted[] = [];
    for (const abs of workflowFiles()) {
        const file = path.basename(abs);
        const doc = yaml.load(fs.readFileSync(abs, 'utf8')) as Workflow;
        for (const [job, body] of Object.entries(doc.jobs ?? {})) {
            for (const step of body.steps ?? []) {
                const stepBudget = step['timeout-minutes'];
                if (typeof stepBudget !== 'number') continue;
                out.push({
                    file,
                    job,
                    step: step.name ?? '(unnamed)',
                    stepBudget,
                    jobBudget: body['timeout-minutes'],
                });
            }
        }
    }
    return out;
}

const budgeted = collect();

describe('a step budget can actually fire (#1720)', () => {
    it('ranges over every workflow — the denominator', () => {
        console.log(
            `[step-budgets] ${budgeted.length} step(s) with a step-level timeout across ` +
                `${workflowFiles().length} workflow file(s)`,
        );
        // A floor, so a refactor that stopped finding steps fails loudly
        // rather than passing over an empty population.
        expect(budgeted.length).toBeGreaterThanOrEqual(5);
    });

    it('every step budget is strictly below its job budget', () => {
        const unreachable = budgeted
            .filter((b) => b.jobBudget !== undefined && b.stepBudget >= b.jobBudget)
            .map((b) => `  ${b.file} ${b.job} / "${b.step}": step ${b.stepBudget}m >= job ${b.jobBudget}m`);
        expect(unreachable.join('\n')).toBe('');
    });

    it('every step carrying a budget also has a job budget behind it', () => {
        // Without one the job inherits the 360-minute runner default, so a
        // wedged step burns six hours of a 20-slot account cap before
        // anything notices. #748 found queue wait to be the real constraint,
        // which is what makes that expensive rather than merely slow.
        const naked = budgeted
            .filter((b) => b.jobBudget === undefined)
            .map((b) => `  ${b.file} ${b.job} / "${b.step}" has no job budget`);
        expect(naked.join('\n')).toBe('');
    });

    it('the disk-cleanup step keeps a bound clear of its measured tail', () => {
        const disk = budgeted.find((b) => b.step.includes('Free runner disk space'));
        expect(disk).toBeDefined();
        // 279s was the slowest SUCCESSFUL run and the distribution is
        // right-censored above 300s, so the true tail is unknown. Anything
        // under 10m puts the bound back inside the region where runs were
        // observed to fail.
        // Named so the failure says which number is wrong, rather than
        // "expected undefined to be >= 10".
        expect(`${disk?.step}: ${disk?.stepBudget}m`).toBe(`${disk?.step}: ${disk?.stepBudget}m`
            .replace(/: \d+m$/, `: ${Math.max(disk?.stepBudget ?? 0, 10)}m`));
    });

    it('the disk-cleanup step still publishes its own timing', () => {
        // The measurement has to stay observable, or the next bound is set
        // from whatever handful of samples someone can scrape. Asserted on
        // the step summary specifically: `console.log` would be dropped by
        // the runner's log retention long before anyone re-measured, and
        // #1879 is the same lesson one layer down.
        const ci = yaml.load(
            fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8'),
        ) as Workflow;
        const step = Object.values(ci.jobs ?? {})
            .flatMap((j) => j.steps ?? [])
            .find((s) => (s.name ?? '').includes('Free runner disk space'));
        expect(step).toBeDefined();
        expect(step?.run ?? '').toContain('GITHUB_STEP_SUMMARY');
        // Per PHASE, because the distribution is bimodal and a single total
        // cannot say which half moved.
        expect(step?.run ?? '').toContain('prune_secs');
        expect(step?.run ?? '').toContain('rm_secs');
    });
});
