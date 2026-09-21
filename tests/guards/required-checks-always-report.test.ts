/**
 * Required status checks must always REPORT.
 *
 * A check listed in main's branch protection blocks a PR until it
 * reports. If the job carrying that name can be skipped — by a path
 * filter, say — the check is never created, and GitHub shows the PR as
 * pending forever. Not red: PENDING. An absent check looks like nothing
 * went wrong, which is why this class of mistake survives review.
 *
 * The pipeline's answer is a split: the heavy, skippable job does the
 * work under a descriptive name, and a tiny summary job carries the
 * REQUIRED name, always runs, and translates `skipped` into a pass where
 * that is the honest reading. `Test`, `E2E` and `Docker Build & Scan`
 * are all built that way.
 *
 * This guard pins the relationship so the split cannot be undone by
 * someone renaming a job or adding a path filter to the wrong one.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Mirrors `gh api repos/RodnaPamet/agri-saas/branches/main/protection
 * -q '.required_status_checks.contexts[]'`, read 2026-09-22.
 *
 * A test cannot reach the API, so this is a PIN, not a derivation: if
 * protection changes, this list changes in the same PR. A required check
 * missing from here is invisible to this guard — which is the one thing
 * it cannot tell you.
 */
const REQUIRED_CHECKS = [
    'Build',
    'Lint',
    'Typecheck',
    'E2E',
    'Security',
    'CodeQL SAST (javascript-typescript)',
    'Docker Build & Scan',
    'Test',
    'Coverage (≥60%)',
];

type Job = { name?: string; if?: unknown };

function loadJobs(file: string): Record<string, Job> {
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) as { jobs: Record<string, Job> };
    return doc.jobs;
}

/**
 * The job behind a required check name.
 *
 * A matrixed job reports as `<name> (<matrix value>)`, so an exact miss
 * is retried against the name with a trailing parenthetical removed.
 * Exact match is tried FIRST and matters: `Coverage (≥60%)` is a whole
 * job name that merely looks like a matrix suffix.
 */
function jobFor(jobs: Record<string, Job>, check: string): [string, Job] | null {
    const byName = (want: string) =>
        Object.entries(jobs).find(([id, j]) => (j.name ?? id) === want) ?? null;
    return byName(check) ?? byName(check.replace(/\s*\([^()]*\)\s*$/, '')) ?? null;
}

const CI = path.resolve(__dirname, '../../.github/workflows/ci.yml');

describe('required status checks always report', () => {
    const jobs = loadJobs(CI);

    it.each(REQUIRED_CHECKS)('%s is produced by a job in ci.yml', (check) => {
        expect(jobFor(jobs, check)).not.toBeNull();
    });

    it.each(REQUIRED_CHECKS)('%s is not behind a path filter', (check) => {
        const found = jobFor(jobs, check);
        expect(found).not.toBeNull();
        const [, job] = found!;
        // `needs.changes.outputs.*` is how this pipeline skips work for
        // irrelevant diffs. A required check gated that way never reports.
        expect(String(job.if ?? '')).not.toContain('needs.changes.outputs');
    });

    it('SELF-TEST: a required name behind a path filter is detected', () => {
        const rigged: Record<string, Job> = {
            docker: { name: 'Docker Build & Scan', if: "${{ needs.changes.outputs.image == 'true' }}" },
        };
        const [, job] = jobFor(rigged, 'Docker Build & Scan')!;
        expect(String(job.if)).toContain('needs.changes.outputs');
    });

    it('SELF-TEST: a parenthesised job name is matched exactly, not as a matrix suffix', () => {
        // Guards the `Coverage (≥60%)` case: stripping first would look
        // for a job called `Coverage`, find nothing, and report a false
        // missing-check.
        const rigged: Record<string, Job> = { cov: { name: 'Coverage (≥60%)' } };
        expect(jobFor(rigged, 'Coverage (≥60%)')).not.toBeNull();
        expect(jobFor(rigged, 'Coverage')).toBeNull();
    });
});
