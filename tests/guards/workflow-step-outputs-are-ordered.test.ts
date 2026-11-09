/**
 * A step's `if:` may not read an output produced by a LATER step.
 *
 * ## It fails by SKIPPING, which is the whole problem
 *
 * `${{ steps.params.outputs.scenario }}` for a `params` step that has not run
 * yet evaluates to the EMPTY STRING. So `if: steps.params.outputs.scenario ==
 * 'delivery'` is false, the step is skipped, and GitHub reports `skipped` —
 * not an error, not a warning, nothing in the summary. The failure surfaces
 * somewhere else entirely, as whatever depended on that step's work.
 *
 * MEASURED on run 42574529418 (#2881): a `Build k6 with xk6-sse` step placed
 * beside `Setup k6` — the obvious home for it — sat two steps above the
 * `params` step whose output it tested. It skipped, and `Run k6 — delivery`
 * died two seconds in on a missing `./k6-sse`. The diagnosis cost a job log;
 * the rule costs a sort.
 *
 * This is the same family as `ci-aggregate-upstream-failure`: a `skipped`
 * result that reads as "not needed" when it means "could not run". That guard
 * covers JOB-level `needs`; this covers STEP-level `steps.<id>.outputs`, which
 * nothing did.
 *
 * ## Derived from the filesystem, so a new workflow is covered when it exists
 *
 * Every `.github/workflows/*.yml`, every job, every step. The alternative — a
 * list of workflows to check — is the shape #805 records: `Publish image to
 * GHCR`, the one workflow that produces what production runs, was missing from
 * a curated watchlist.
 *
 * ## What it does NOT claim
 *
 * Only `steps.<id>.outputs.*` inside `if:`. A `run:` body referencing a later
 * step's output has the same defect and is NOT checked here, because a `run:`
 * is a shell script that can legitimately mention the string — and the failure
 * mode differs: an empty substitution in a shell is a bug this repo already
 * records separately (`empty-substitution-destroys-the-target`), while an
 * empty substitution in an `if:` is a silent skip. Narrow and honest beats
 * broad and noisy.
 */
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const WORKFLOW_DIR = path.join(process.cwd(), '.github/workflows');

interface Step {
    id?: string;
    name?: string;
    if?: string;
}
interface Job {
    steps?: Step[];
}
interface Workflow {
    jobs?: Record<string, Job>;
}

const files = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

/** Every `steps.<id>.outputs` reference inside a condition string. */
function referencedStepIds(condition: string): string[] {
    const ids = new Set<string>();
    const re = /steps\.([A-Za-z0-9_-]+)\.outputs\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(condition)) !== null) ids.add(m[1]);
    return [...ids];
}

interface Violation {
    file: string;
    job: string;
    step: string;
    referenced: string;
    reason: string;
}

/** Exported shape so the teeth cases below can run the rule over a fixture. */
export function violationsIn(file: string, wf: Workflow): Violation[] {
    const out: Violation[] = [];
    for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
        const steps = job.steps ?? [];
        steps.forEach((step, index) => {
            const condition = step.if;
            if (typeof condition !== 'string') return;
            for (const refId of referencedStepIds(condition)) {
                const producerIndex = steps.findIndex((s) => s.id === refId);
                const label = step.name ?? step.id ?? `step ${index + 1}`;
                if (producerIndex === -1) {
                    out.push({
                        file,
                        job: jobName,
                        step: label,
                        referenced: refId,
                        reason: `no step in this job declares \`id: ${refId}\``,
                    });
                } else if (producerIndex >= index) {
                    out.push({
                        file,
                        job: jobName,
                        step: label,
                        referenced: refId,
                        reason:
                            `\`id: ${refId}\` is step ${producerIndex + 1}, at or after this one `
                            + `(step ${index + 1})`,
                    });
                }
            }
        });
    }
    return out;
}

const parsed = files.map((f) => ({
    file: f,
    wf: yaml.load(readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')) as Workflow,
}));

describe('a step condition reads only outputs that already exist', () => {
    it('reports the population it graded', () => {
        let steps = 0;
        let conditioned = 0;
        let references = 0;
        for (const { wf } of parsed) {
            for (const job of Object.values(wf.jobs ?? {})) {
                for (const step of job.steps ?? []) {
                    steps += 1;
                    if (typeof step.if === 'string') {
                        conditioned += 1;
                        references += referencedStepIds(step.if).length;
                    }
                }
            }
        }
        console.log(
            `[workflow-step-order] ${parsed.length} workflow(s), ${steps} step(s), `
            + `${conditioned} with an \`if:\`, ${references} \`steps.<id>.outputs\` reference(s)`,
        );
        // Three floors, because this guard can go inert three ways: no
        // workflows found, none parsed into jobs, and — the one that matters —
        // no step actually referencing a step output, which would make every
        // assertion below true over nothing.
        expect(parsed.length).toBeGreaterThanOrEqual(10);
        expect(steps).toBeGreaterThan(50);
        expect(references).toBeGreaterThan(0);
    });

    for (const { file, wf } of parsed) {
        it(`${file} orders its step-output references`, () => {
            const found = violationsIn(file, wf);
            if (found.length > 0) {
                throw new Error(
                    `${found.length} step condition(s) read a step output that is not yet set:\n`
                    + found
                        .map(
                            (v) =>
                                `  ${v.file} › ${v.job} › "${v.step}"\n`
                                + `      reads steps.${v.referenced}.outputs — ${v.reason}`,
                        )
                        .join('\n')
                    + '\n\nAn unset `steps.<id>.outputs.*` is the EMPTY STRING, so the condition is\n'
                    + 'false and the step is SKIPPED — reported as `skipped`, which reads as "not\n'
                    + 'needed" rather than "could not run". Move the step BELOW the one that\n'
                    + 'declares that id.',
                );
            }
            expect(found).toEqual([]);
        });
    }
});

describe('the guard itself has teeth', () => {
    it('catches a condition reading a LATER step', () => {
        const wf: Workflow = {
            jobs: {
                build: {
                    steps: [
                        { name: 'uses it early', if: "steps.params.outputs.x == 'y'" },
                        { id: 'params', name: 'sets it late' },
                    ],
                },
            },
        };
        const found = violationsIn('fixture.yml', wf);
        expect(found).toHaveLength(1);
        expect(found[0].reason).toMatch(/at or after this one/);
    });

    it('catches a condition reading a step id that does not exist', () => {
        // The adjacent failure, and it is not the same one: a renamed `id:`
        // leaves every condition referencing the old name permanently false,
        // so the steps skip for ever with nothing missing from the file.
        const wf: Workflow = {
            jobs: { build: { steps: [{ name: 'orphan', if: 'steps.gone.outputs.x' }] } },
        };
        expect(violationsIn('fixture.yml', wf)[0].reason).toMatch(/no step in this job declares/);
    });

    it('allows a condition reading an EARLIER step — the control', () => {
        // Without this the rule could be "any step-output reference is a
        // violation", which would fire on every correct workflow in the repo
        // and be switched off within a day.
        const wf: Workflow = {
            jobs: {
                build: {
                    steps: [
                        { id: 'params', name: 'sets it first' },
                        { name: 'uses it after', if: "steps.params.outputs.x == 'y'" },
                    ],
                },
            },
        };
        expect(violationsIn('fixture.yml', wf)).toEqual([]);
    });

    it('is not fooled by a reference to the SAME step', () => {
        // A step cannot read its own output in its own condition, and the
        // off-by-one that allows it (`>` instead of `>=`) is the easy mistake.
        const wf: Workflow = {
            jobs: {
                build: { steps: [{ id: 'self', name: 'reads itself', if: 'steps.self.outputs.x' }] },
            },
        };
        expect(violationsIn('fixture.yml', wf)).toHaveLength(1);
    });

    it('ignores a job-level `needs` reference, which is the other guard', () => {
        // `ci-aggregate-upstream-failure` owns `needs.<job>.result`. Reporting
        // it here would duplicate that guard and make this one noisy.
        const wf: Workflow = {
            jobs: { build: { steps: [{ name: 'fine', if: "needs.test.result == 'success'" }] } },
        };
        expect(violationsIn('fixture.yml', wf)).toEqual([]);
    });
});
