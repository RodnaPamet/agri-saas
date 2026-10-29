/**
 * Structural ratchet — the SBOM must be generated BEFORE semantic-release,
 * and attaching it must survive a release that did not return cleanly.
 *
 * ## The defect (#2458)
 *
 * `release.yml` used to generate the SBOM *after* `Detect published
 * release`, gated on `steps.release.outputs.released == 'true'`. That
 * gate is individually correct — it stops a no-op run emitting a stray
 * SBOM — and it also made the artifact producible only in the window
 * AFTER semantic-release returned.
 *
 * Measured on run 40894421227 (2026-10-29):
 *
 *     Run semantic-release    14:44:03 -> 14:54:19   cancelled
 *     Detect published release                       skipped
 *     Generate SBOM (SPDX-JSON)                      skipped
 *     Attach SBOM to GitHub Release                  skipped
 *     Post release summary                           skipped
 *
 * semantic-release PUBLISHED v12.80.2 at 14:45:21 — 78 seconds in, tag
 * and GitHub Release both created, commit-back landed as
 * `3debc28c chore(release): 12.80.2 [skip ci]` — and then hung for nine
 * more minutes until the job's `timeout-minutes: 10` cancelled it. Every
 * step after it was `skipped`, so v12.80.2 is the only one of the twelve
 * most recent releases with an empty asset list while all eleven
 * neighbours carry `sbom.spdx.json`.
 *
 * The run reported SUCCESS at the workflow level, which is why nobody
 * saw it: a release with no SBOM looked exactly like a release with one.
 *
 * ## What this guard holds, and why each half is load-bearing
 *
 * The fix has two directions and reverting either one restores a gap:
 *
 *  - **Generation runs first, ungated.** Moving it back after the release
 *    reinstates the starvation window verbatim. Gating it on `released`
 *    does the same thing, because that output cannot exist before
 *    semantic-release has run.
 *  - **Generation is `continue-on-error`.** Now that it runs first, a
 *    HARD failure here would stop the release being cut at all — and a
 *    syft download 504 is measured history, not a hypothetical (#685,
 *    2026-08-21). An SBOM is a document *about* a release; it must never
 *    gate shipping one.
 *  - **`Detect published release` and `Attach SBOM` use `always()`.**
 *    Under `success()` both skip on exactly the run that needs them, and
 *    `released` is never set, so the attach cannot fire however else it
 *    is gated.
 *  - **The attach step fails loud on a missing file.** This is the half
 *    that keeps `continue-on-error` from being the silent-gap trade
 *    `sbom-backfill.yml`'s docblock argues against. The signal moves
 *    rather than disappearing: it becomes "this release has no SBOM"
 *    (actionable, with the backfill command) instead of "a CDN returned
 *    504" (a mechanism detail).
 *
 * ## Why a guard and not care
 *
 * Every one of the four is the kind of thing a reasonable "tidy up the
 * release workflow" PR removes: an ungated expensive step looks wasteful,
 * `continue-on-error` looks like suppression, `always()` looks like
 * sloppiness, and a `test -s` on a file the previous step just wrote
 * looks redundant. All four read as cleanups and all four are the defect.
 *
 * The detector is proved against synthetic workflows below rather than by
 * mutating the real file, so a green run here means the assertions can
 * actually fail.
 *
 * ## One thing NOT to do while writing about this
 *
 * Do not quote the offending commit's subject into a commit message. The
 * commit-back commit's subject carries a skip-CI marker, and GitHub matches
 * that substring without understanding quotation — #2478's first commit
 * described the defect by pasting it, and got zero workflow runs on the pull
 * request while reading as "CI has not started". See the CI-skip-marker
 * subsection in CLAUDE.md under "A merged PR body is not a tracker".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RELEASE_YML = path.join(REPO_ROOT, '.github/workflows/release.yml');

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    'continue-on-error'?: boolean;
    'timeout-minutes'?: number;
    with?: Record<string, unknown>;
}

function stepsOf(source: string): Step[] {
    const doc = yaml.load(source) as { jobs: Record<string, { steps: Step[] }> };
    const jobs = Object.values(doc.jobs);
    expect(jobs).toHaveLength(1);
    return jobs[0].steps;
}

const label = (s: Step): string => s.name ?? s.uses ?? '(unnamed)';

/** Index of the SBOM-generating step, or -1. Keyed on the ACTION, not the name. */
const sbomIndex = (steps: Step[]): number =>
    steps.findIndex((s) => (s.uses ?? '').startsWith('anchore/sbom-action'));

/** Index of the step that runs semantic-release, or -1. Keyed on the COMMAND. */
const releaseIndex = (steps: Step[]): number =>
    steps.findIndex((s) => /\bsemantic-release\b/.test(s.run ?? ''));

const attachIndex = (steps: Step[]): number =>
    steps.findIndex((s) => /gh release upload/.test(s.run ?? ''));

const detectIndex = (steps: Step[]): number =>
    steps.findIndex((s) => /git describe --tags/.test(s.run ?? '') && /released=/.test(s.run ?? ''));

/**
 * The four findings, as data, so the same function grades the real file and
 * the synthetic fixtures. Returns [] for a compliant workflow.
 */
function violations(source: string): string[] {
    const steps = stepsOf(source);
    const out: string[] = [];

    const iSbom = sbomIndex(steps);
    const iRel = releaseIndex(steps);
    const iDetect = detectIndex(steps);
    const iAttach = attachIndex(steps);

    if (iSbom === -1) return ['no anchore/sbom-action step at all'];
    if (iRel === -1) return ['no semantic-release step at all'];
    if (iAttach === -1) return ['no `gh release upload` step at all'];
    if (iDetect === -1) return ['no step detecting whether a release published'];

    const sbom = steps[iSbom];
    const attach = steps[iAttach];
    const detect = steps[iDetect];

    // 1 — ordering.
    if (iSbom > iRel) {
        out.push(`SBOM generation (step ${iSbom + 1}) runs AFTER semantic-release (step ${iRel + 1})`);
    }

    // 2 — generation must not be gated on the release having happened.
    if (/released/.test(sbom.if ?? '')) {
        out.push(`SBOM generation is gated on the release outcome: if: ${sbom.if}`);
    }

    // 3 — generation must not be able to block the release.
    if (sbom['continue-on-error'] !== true) {
        out.push('SBOM generation lacks `continue-on-error: true`, so a syft outage blocks the release');
    }

    // 4 — detect + attach must not be gated on success().
    for (const [step, what] of [
        [detect, 'Detect published release'],
        [attach, 'Attach SBOM'],
    ] as const) {
        const cond = step.if ?? '';
        if (!/\balways\(\)/.test(cond)) {
            out.push(`${what} is not gated on always(): if: ${cond || '(none)'}`);
        }
        if (/\bsuccess\(\)/.test(cond)) {
            out.push(`${what} is gated on success(), which skips on a cancelled release: if: ${cond}`);
        }
    }

    // 5 — a missing SBOM must be loud, since generation is soft-failing.
    if (!/-s\s+sbom\.spdx\.json/.test(attach.run ?? '')) {
        out.push('Attach step does not check the SBOM file exists, so a missing SBOM ships silently');
    }

    return out;
}

describe('release.yml generates its SBOM before the release (#2458)', () => {
    const source = fs.readFileSync(RELEASE_YML, 'utf8');

    it('reports the population it graded', () => {
        const steps = stepsOf(source);
        // Tagged for tests/reporters/denominator-summary.cjs — jest's default
        // reporter drops console output once a run has more than one suite,
        // and CI shards the whole tree with no --verbose.
        console.log(
            `[release-sbom-ordering] graded ${steps.length} steps in .github/workflows/release.yml; ` +
                `sbom=#${sbomIndex(steps) + 1} semantic-release=#${releaseIndex(steps) + 1} ` +
                `detect=#${detectIndex(steps) + 1} attach=#${attachIndex(steps) + 1}`,
        );
        console.log(
            `[release-sbom-ordering] step names: ${steps.map((s, i) => `${i + 1}.${label(s)}`).join(' | ')}`,
        );
        // A detector that located none of the four would pass every
        // assertion below over nothing.
        expect(sbomIndex(steps)).toBeGreaterThanOrEqual(0);
        expect(releaseIndex(steps)).toBeGreaterThanOrEqual(0);
        expect(detectIndex(steps)).toBeGreaterThanOrEqual(0);
        expect(attachIndex(steps)).toBeGreaterThanOrEqual(0);
    });

    it('has no ordering or gating violations', () => {
        expect(violations(source)).toEqual([]);
    });

    it('names the steps it reports on', () => {
        // `label()` feeds the denominator print above, and a reading nobody can
        // read is worth nothing — selector-teeth caught this exact gap: the
        // helper had no assertion behind it, so mutating it to return nothing
        // SURVIVED. The steps are LOCATED by their action/command fingerprints,
        // which is what makes this guard robust to a rename; this asserts they
        // are also NAMED for what they do, so the step summary and the job log
        // stay legible to whoever is reading a failed release.
        const steps = stepsOf(source);
        expect(label(steps[sbomIndex(steps)])).toMatch(/sbom/i);
        expect(label(steps[releaseIndex(steps)])).toMatch(/semantic-release/i);
        expect(label(steps[attachIndex(steps)])).toMatch(/attach/i);
        expect(label(steps[detectIndex(steps)])).toMatch(/detect/i);
        // No step may be anonymous, or the ordering print loses its subject.
        expect(steps.map(label).filter((l) => l === '(unnamed)')).toEqual([]);
    });

    it('bounds the semantic-release step itself', () => {
        // The #2458 hang ran 9 minutes past a 78-second publish. A step
        // timeout is a clean step FAILURE, so the steps after it still run;
        // a job cancellation skipped all four. Must leave room inside the
        // job budget for the attach to follow.
        const steps = stepsOf(source);
        const rel = steps[releaseIndex(steps)];
        const stepBudget = rel['timeout-minutes'];
        expect(typeof stepBudget).toBe('number');

        const doc = yaml.load(source) as { jobs: Record<string, { 'timeout-minutes'?: number }> };
        const jobBudget = Object.values(doc.jobs)[0]['timeout-minutes'];
        expect(typeof jobBudget).toBe('number');
        expect(stepBudget!).toBeLessThan(jobBudget!);
    });
});

/**
 * Detector proof. Each case is the real workflow with ONE property broken,
 * and each must be reported — otherwise the suite above is green over
 * assertions that cannot fire.
 */
describe('the detector can express each failure', () => {
    const source = fs.readFileSync(RELEASE_YML, 'utf8');

    it('is silent on the real file (control)', () => {
        expect(violations(source)).toEqual([]);
    });

    it('catches generation moved back after semantic-release', () => {
        const steps = stepsOf(source);
        const doc = yaml.load(source) as { jobs: Record<string, { steps: Step[] }> };
        const job = Object.values(doc.jobs)[0];
        const [sbom] = job.steps.splice(sbomIndex(steps), 1);
        job.steps.push(sbom);
        const found = violations(yaml.dump(doc));
        expect(found.join('\n')).toMatch(/runs AFTER semantic-release/);
    });

    it('catches generation re-gated on the release outcome', () => {
        const doc = yaml.load(source) as { jobs: Record<string, { steps: Step[] }> };
        const job = Object.values(doc.jobs)[0];
        job.steps[sbomIndex(job.steps)].if = "success() && steps.release.outputs.released == 'true'";
        expect(violations(yaml.dump(doc)).join('\n')).toMatch(/gated on the release outcome/);
    });

    it('catches continue-on-error being removed from generation', () => {
        const doc = yaml.load(source) as { jobs: Record<string, { steps: Step[] }> };
        const job = Object.values(doc.jobs)[0];
        delete job.steps[sbomIndex(job.steps)]['continue-on-error'];
        expect(violations(yaml.dump(doc)).join('\n')).toMatch(/lacks `continue-on-error/);
    });

    it('catches detect/attach reverted to success()', () => {
        const doc = yaml.load(source) as { jobs: Record<string, { steps: Step[] }> };
        const job = Object.values(doc.jobs)[0];
        job.steps[detectIndex(job.steps)].if = 'success()';
        job.steps[attachIndex(job.steps)].if = "success() && steps.release.outputs.released == 'true'";
        const found = violations(yaml.dump(doc)).join('\n');
        expect(found).toMatch(/Detect published release is gated on success\(\)/);
        expect(found).toMatch(/Attach SBOM is gated on success\(\)/);
    });

    it('catches the missing-file check being dropped from the attach', () => {
        const doc = yaml.load(source) as { jobs: Record<string, { steps: Step[] }> };
        const job = Object.values(doc.jobs)[0];
        const attach = job.steps[attachIndex(job.steps)];
        attach.run = "gh release upload \"${{ steps.release.outputs.version }}\" sbom.spdx.json --clobber";
        expect(violations(yaml.dump(doc)).join('\n')).toMatch(/does not check the SBOM file exists/);
    });
});
