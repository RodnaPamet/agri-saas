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
    /**
     * The cancel discriminator, as two numbers, because ONE number cannot
     * express the case that matters (#748).
     *
     * `jobsCreated` is `.jobs | length`; `jobsExecuted` counts the jobs with
     * at least one timestamped step. The old harness had a single
     * `startedJobs` standing for `select(.started_at != null) | length`, and
     * that expression cannot distinguish a job that ran from a job that only
     * ever had a RECORD: the Jobs API sets `started_at` to a placeholder
     * equal to `created_at` before any runner is assigned. So the two reads
     * were identical in the stub and identical in production, and a run whose
     * jobs were cancelled in the queue was reported as a timeout.
     *
     * `jobsExecuted` defaults to `jobsCreated` — a plain budget kill, the
     * shape the old single number always implied.
     */
    jobsCreated?: number;
    jobsExecuted?: number;
    /**
     * Overrides the two numbers with a verbatim probe answer, so a malformed
     * one can be driven. Exists because the branch that reads a bad answer as
     * "0 jobs" is the SILENT branch.
     */
    rawProbe?: string;
    /** What `gh issue view --json body` should report as the existing body. */
    existingBody?: string;
    conclusion: string;
    runId: string;
    /** The watched workflow's name. Defaults to a workflow with no exception. */
    wf?: string;
}

/**
 * Runs the real script with a stubbed `gh` that logs every invocation, and
 * returns both the script's stdout and the recorded `gh` calls.
 */
function run(s: Scenario): { out: string; calls: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-'));
    try {
        const callLog = path.join(dir, 'calls.txt');
        const jobsCreated = s.jobsCreated ?? 0;
        const jobsExecuted = s.jobsExecuted ?? jobsCreated;
        // Newlines are squashed to spaces so one gh invocation stays one log
        // line — the issue body is multi-line and would otherwise be split
        // across entries, hiding the marker this test checks for.
        const stub = `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >> ${JSON.stringify(callLog)}
case "$1 $2" in
  "issue list")   printf '%s' ${JSON.stringify(s.openIssue ?? '')} ;;
  "issue view")   printf '%s' ${JSON.stringify(s.existingBody ?? '')} ;;
  api*)           ${
      s.rawProbe === undefined
          ? `printf '%s\\t%s' '${jobsCreated}' '${jobsExecuted}'`
          : `printf '%s' ${JSON.stringify(s.rawProbe)}`
  } ;;
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
                WF: s.wf ?? 'Release',
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

    it('a SUPERSEDED cancel files nothing — no job record at all', () => {
        // Defect 1, which fired in production as #680. A `concurrency` group
        // kills the earlier PENDING run, so it reports ZERO jobs — measured on
        // the real run: `gh api .../jobs` returned an empty set.
        const { out, calls } = run({ conclusion: 'cancelled', runId: '202', jobsCreated: 0 });

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
        const { out, calls } = run({
            conclusion: 'cancelled',
            runId: '203',
            jobsCreated: 18,
            jobsExecuted: 18,
        });

        expect(created(calls)).toBe(true);
        expect(out).toContain('budget kill');
    });

    it('a timed-out cancel COMMENTS rather than duplicating, like any failure', () => {
        const { calls } = run({
            conclusion: 'cancelled',
            runId: '204',
            jobsCreated: 18,
            openIssue: '42',
        });

        expect(created(calls)).toBe(false);
        expect(commented(calls)).toBe(true);
    });

    // ── #748: a QUEUE DROP is not a budget kill, and the report must say so ──
    //
    // Measured on run 35754149459 (a main push, 2026-09-22): 21 job records,
    // all 21 with a non-null `started_at`, and only 2 that executed a single
    // step. Nineteen required checks produced no log and no verdict because no
    // runner was ever free — the queue was ~80 jobs deep — and the notifier
    // reported that as `timed_out_or_cancelled`, i.e. as a budget overrun. Two
    // weeks of #748 went into looking for a slow job that was never there.
    //
    // The counts come from the SAME payload, so this costs no extra request.
    it('a QUEUE-DROP cancel files, and names itself a queue drop with the counts', () => {
        const { out, calls } = run({
            conclusion: 'cancelled',
            runId: '206',
            jobsCreated: 21,
            jobsExecuted: 2,
            wf: 'CI',
        });

        // The filing DECISION is unchanged — a main push that lost 19 checks
        // is news. What changes is that the report distinguishes the cause.
        expect(created(calls)).toBe(true);
        expect(out).toContain('queue drop');
        expect(out).not.toContain('budget kill');

        const body = calls.find((l) => l.startsWith('issue create')) ?? '';
        expect(body).toContain('21 created');
        expect(body).toContain('2 executed a step');
        expect(body).toContain('19 never started');
        expect(body).toContain('queue drop');
    });

    it('a BUDGET KILL names itself a budget kill, and never a queue drop', () => {
        // The opposite pole, measured on run 35246281669: 21 of 21 jobs
        // executed, and `CodeQL SAST` was killed at 15m05s against its
        // `timeout-minutes: 15`. Both poles are asserted because a classifier
        // with one tested arm is a constant.
        const { out, calls } = run({
            conclusion: 'cancelled',
            runId: '207',
            jobsCreated: 21,
            jobsExecuted: 21,
            wf: 'CI',
        });

        expect(created(calls)).toBe(true);
        expect(out).toContain('budget kill');
        expect(out).not.toContain('queue drop');

        const body = calls.find((l) => l.startsWith('issue create')) ?? '';
        expect(body).toContain('0 never started');
        expect(body).toContain('budget kill');
    });

    it('the probe reads STEPS, not `started_at` — the field that cannot tell the two apart', () => {
        // The tests above stub `gh`, so they prove the PARSER and the
        // classifier and can say nothing about which field the `--jq` reads.
        // Reverting the expression to `select(.started_at != null)` would make
        // created == executed on every run with job records and every
        // cancellation would read as a budget kill again — with all of the
        // above still green. So the selector itself is pinned here.
        //
        // The live evidence that `started_at` cannot discriminate, for the
        // next reader (both are `gh api .../jobs`, both 21 jobs, both with a
        // non-null `started_at` on all 21):
        //
        //   run 35754149459  queue drop   executed a step:  2
        //   run 35246281669  budget kill  executed a step: 21
        const src = fs.readFileSync(SCRIPT, 'utf8');
        expect(src).toContain('(.jobs | length)');
        expect(src).toContain('select((.steps // []) | map(select(.started_at != null)) | length > 0)');
        // And the field that was wrong must not be the whole of the count.
        expect(src).not.toContain('[.jobs[] | select(.started_at != null)] | length');
    });

    it('a probe that answers with ONE number is a failed probe, not "0 created"', () => {
        // The suppression branch is reached by `CREATED -eq 0`, so a parser
        // that mis-reads a malformed answer as zero goes SILENT on a real
        // failure. That is the shape of the `|| echo 0` defect this script
        // already carries a comment about; the TSV split gave it a second way
        // to happen, so both halves are validated.
        const { out, calls } = run({
            conclusion: 'cancelled',
            runId: '208',
            rawProbe: 'not-a-number',
            wf: 'CI',
        });

        expect(created(calls)).toBe(true);
        expect(out).toContain('probe');
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

    // ── #805: `Publish image to GHCR` cancellations are ambiguous ──
    //
    // The `cancelled` discriminator above ("did any job start?") was derived
    // from CI, where a superseded run dies while PENDING. ghcr-publish is a
    // SINGLE-job workflow whose job starts within seconds, so a supersession
    // always finds a started job and would be misreported as a real failure.
    // The case that genuinely matters — main's tip has no image — is answered
    // by image-tip-check.yml asking about STATE, not by this event.
    it('a cancelled ghcr-publish files NOTHING, even with jobs started', () => {
        const { calls } = run({
            conclusion: 'cancelled',
            runId: '300',
            jobsCreated: 1,
            wf: 'Publish image to GHCR',
        });

        expect(created(calls)).toBe(false);
        expect(commented(calls)).toBe(false);
    });

    it('a FAILED ghcr-publish still files — only the ambiguous conclusion is suppressed', () => {
        const { calls } = run({
            conclusion: 'failure',
            runId: '301',
            wf: 'Publish image to GHCR',
        });

        expect(created(calls)).toBe(true);
    });

    it('the exception is scoped: a cancelled CI run still files', () => {
        // Without this, the fix for one workflow would silently blind the
        // notifier to the timeout class it was extended to catch in the
        // first place (the Coverage gate, 2026-08-21).
        const { calls } = run({
            conclusion: 'cancelled',
            runId: '302',
            jobsCreated: 1,
            wf: 'CI',
        });

        expect(created(calls)).toBe(true);
    });
});
