/**
 * The CI-failure notifier must file for real failures, and only for those.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * The first version of this notifier (#676) put its decision logic inline in
 * the workflow YAML, where nothing could execute it. It shipped two defects
 * and BOTH fired within two minutes of merging:
 *
 *   1. It treated `cancelled` as a failure. A workflow with a `concurrency`
 *      group keeps only the most recent pending run and cancels the earlier
 *      ones, so four rapid merges to main produced two cancelled `Release`
 *      runs — the queue working exactly as designed — and the notifier filed
 *      an issue about one. That is the accumulating noise the PR body had
 *      promised the design would avoid.
 *
 *   2. It had no ordering guarantee. The issue filed for run 32469042244
 *      (commit d725e214) was closed by run 32469023657 (commit c3581cfb) —
 *      an EARLIER commit whose run simply finished later. A stale success can
 *      close an issue about a newer failure, which is worse than never filing
 *      it, because the queue then looks clean.
 *
 * Both are decision logic, not YAML. So the logic now lives in
 * `.github/scripts/ci-failure-issue.sh` and these tests EXECUTE it against a
 * stubbed `gh`, asserting on the commands it would actually run. No network,
 * no GitHub, no workflow dispatch.
 *
 * The lesson is the one this notifier exists to serve: a mechanism that
 * reports on other people's failures needs to be at least as verifiable as
 * what it watches.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/ci-failure-issue.sh');

interface Scenario {
    /** What `gh issue list` should report: an issue number, or empty for none. */
    openIssue?: string;
    /** How many jobs the run reports as having STARTED — the cancel discriminator. */
    startedJobs?: number;
    /** What `gh issue view --json body` should report as the existing body. */
    existingBody?: string;
    conclusion: string;
    runId: string;
}

/**
 * Runs the real script with a stubbed `gh` that logs every invocation, and
 * returns both the script's stdout and the recorded `gh` calls.
 */
function run(s: Scenario): { out: string; calls: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-'));
    try {
        const callLog = path.join(dir, 'calls.txt');
        // Newlines are squashed to spaces so one gh invocation stays one log
        // line — the issue body is multi-line and would otherwise be split
        // across entries, hiding the marker this test checks for.
        const stub = `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >> ${JSON.stringify(callLog)}
case "$1 $2" in
  "issue list")   printf '%s' ${JSON.stringify(s.openIssue ?? '')} ;;
  "issue view")   printf '%s' ${JSON.stringify(s.existingBody ?? '')} ;;
  api*)           printf '%s' ${JSON.stringify(String(s.startedJobs ?? 0))} ;;
esac
exit 0
`;
        const bin = path.join(dir, 'gh');
        fs.writeFileSync(bin, stub, { mode: 0o755 });

        const out = execFileSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: {
                ...process.env,
                GH: bin,
                WF: 'Release',
                CONCLUSION: s.conclusion,
                RUN_URL: `https://example.invalid/${s.runId}`,
                RUN_ID: s.runId,
                EVENT: 'push',
                BRANCH: 'main',
                SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                REPO: 'RodnaPamet/agri-saas',
            },
        });

        const calls = fs.existsSync(callLog)
            ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean)
            : [];
        return { out, calls };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const created = (c: string[]) => c.some((l) => l.startsWith('issue create'));
const commented = (c: string[]) => c.some((l) => l.startsWith('issue comment'));
const closed = (c: string[]) => c.some((l) => l.startsWith('issue close'));

describe('CI-failure notifier — files for real failures, and only those', () => {
    it('a genuine failure with nothing open FILES one issue', () => {
        const { calls } = run({ conclusion: 'failure', runId: '200' });

        expect(created(calls)).toBe(true);
        expect(commented(calls)).toBe(false);
        // The high-water mark must be embedded, or the ordering guard below
        // has nothing to compare against on the next success.
        expect(calls.find((l) => l.startsWith('issue create'))).toContain('ci-failure-run: 200');
    });

    it('a repeat failure COMMENTS rather than filing a duplicate', () => {
        const { calls } = run({ conclusion: 'failure', runId: '201', openIssue: '42' });

        expect(created(calls)).toBe(false);
        expect(commented(calls)).toBe(true);
        // And refreshes the mark, so a later success must beat the LATEST
        // failure rather than the first one.
        expect(calls.some((l) => l.startsWith('issue edit'))).toBe(true);
    });

    it('a SUPERSEDED cancel files nothing — no job ever started', () => {
        // Defect 1, which fired in production as #680. A `concurrency` group
        // kills the earlier PENDING run, so it reports ZERO jobs — measured on
        // the real run: `gh api .../jobs` returned an empty set.
        const { out, calls } = run({ conclusion: 'cancelled', runId: '202', startedJobs: 0 });

        expect(created(calls)).toBe(false);
        expect(commented(calls)).toBe(false);
        expect(closed(calls)).toBe(false);
        expect(out).toContain('superseded');
    });

    it('a TIMED-OUT cancel DOES file — jobs ran, and one was killed', () => {
        // The false NEGATIVE that fixing defect 1 created. On 2026-08-21 the
        // Coverage gate hit its 60-minute timeout on three consecutive main
        // pushes; the run concluded `cancelled` with 17 of 18 jobs SUCCEEDING,
        // and this notifier said nothing. A gate that can neither pass nor fail
        // went dark unannounced.
        const { out, calls } = run({ conclusion: 'cancelled', runId: '203', startedJobs: 17 });

        expect(created(calls)).toBe(true);
        expect(out).toContain('real failure');
    });

    it('a timed-out cancel COMMENTS rather than duplicating, like any failure', () => {
        const { calls } = run({
            conclusion: 'cancelled',
            runId: '204',
            startedJobs: 17,
            openIssue: '42',
        });

        expect(created(calls)).toBe(false);
        expect(commented(calls)).toBe(true);
    });

    it.each(['skipped', 'neutral', 'action_required'])('%s is not a failure either', (c) => {
        const { calls } = run({ conclusion: c, runId: '205' });
        expect(created(calls)).toBe(false);
    });

    it('a NEWER success closes the issue', () => {
        const { calls } = run({
            conclusion: 'success',
            runId: '300',
            openIssue: '42',
            existingBody: '<!-- ci-failure-run: 200 -->',
        });

        expect(commented(calls)).toBe(true);
        expect(closed(calls)).toBe(true);
    });

    it('an OLDER success does NOT close it — this is defect 2, and it fired in production', () => {
        // Run 32469023657 (commit c3581cfb) finished AFTER run 32469042244
        // (commit d725e214) and closed the issue about it. Run ids are
        // monotonic per repo, so the comparison is reliable even when runs
        // conclude out of order.
        const { out, calls } = run({
            conclusion: 'success',
            runId: '100',
            openIssue: '42',
            existingBody: '<!-- ci-failure-run: 200 -->',
        });

        expect(closed(calls)).toBe(false);
        expect(commented(calls)).toBe(false);
        expect(out).toContain('stale success');
    });

    it('a success with nothing open does nothing at all', () => {
        // The quiet path, and by far the most common one. If this ever starts
        // commenting, every green run on main becomes noise.
        const { calls } = run({ conclusion: 'success', runId: '400' });

        expect(calls.filter((l) => !l.startsWith('issue list'))).toEqual([]);
    });

    it('a success closes an issue that carries NO marker — legacy issues still clear', () => {
        // Issues filed by the first version have no `ci-failure-run` comment.
        // Refusing to close those would strand them open forever.
        const { calls } = run({
            conclusion: 'success',
            runId: '500',
            openIssue: '42',
            existingBody: 'filed by the old version, no marker here',
        });

        expect(closed(calls)).toBe(true);
    });
});
