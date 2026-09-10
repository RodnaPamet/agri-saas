/**
 * The gate that decides whether image-tip-check asks about the tip.
 *
 * This exists because the gate was wrong for three hours in production and no
 * test could have caught it, because the logic lived inline in YAML and there
 * was no test. The scenarios below are the REAL ones from 2026-09-10, not
 * invented shapes — see #877.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const GATE = path.join(ROOT, '.github', 'scripts', 'image-tip-gate.sh');

const TIP = '1af2bf0b5c0ffee0000000000000000000000000';
const OLDER = '0adb33ff2deadbeef000000000000000000000000';
const PUBLISH = 'Publish image to GHCR';

interface Run {
    status: string;
    conclusion: string | null;
    /** Defaults to the publish workflow. Set it to model OTHER workflows on the same sha. */
    name?: string;
}

/**
 * A `gh` stub.
 *
 * It emits whatever runs it is given, INCLUDING runs of other workflows. That
 * matters more than it looks: an earlier version stamped every run with the
 * publish workflow's name, so the gate's `select(.name == $wf)` filter was
 * untestable — dropping it entirely left all seven tests green. A double more
 * forgiving than the real API manufactures a passing mutation, and the harness
 * then reports success about a comparison it never made. (Thanks to the peer
 * session, which hit the same shape in a Cache stand-in that tried an exact
 * match before an ignoreSearch pass, where the real Cache does one
 * insertion-order pass — its loose retry silently absorbed the exact one.)
 *
 * The real endpoint filters by head_sha server-side but does NOT filter by
 * workflow; every workflow that ran on that sha comes back.
 */
function ghStub(dir: string, runs: Run[] | 'fail'): string {
    const p = path.join(dir, 'gh');
    const body =
        runs === 'fail'
            ? `#!/bin/bash\necho "gh: HTTP 403: API rate limit exceeded" >&2\nexit 1\n`
            : `#!/bin/bash\ncat <<'JSON'\n${JSON.stringify({
                  workflow_runs: runs.map((r) => ({
                      name: r.name ?? PUBLISH,
                      status: r.status,
                      conclusion: r.conclusion,
                  })),
              })}\nJSON\n`;
    fs.writeFileSync(p, body, { mode: 0o755 });
    return p;
}

interface Decision {
    skipped: boolean;
    stdout: string;
    exitCode: number;
}

function runGate(opts: {
    target: string;
    triggering: string;
    runs: Run[] | 'fail';
}): Decision {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    try {
        const gh = ghStub(dir, opts.runs);
        const out = path.join(dir, 'output');
        fs.writeFileSync(out, '');
        let stdout = '';
        let exitCode = 0;
        try {
            stdout = execFileSync('bash', [GATE], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    REPO: 'RodnaPamet/agri-saas',
                    TARGET: opts.target,
                    TRIGGERING_SHA: opts.triggering,
                    GH: gh,
                    GITHUB_OUTPUT: out,
                },
            });
        } catch (e) {
            const err = e as { status?: number; stdout?: string };
            exitCode = err.status ?? 1;
            stdout = err.stdout ?? '';
        }
        return { skipped: fs.readFileSync(out, 'utf8').includes('skip=true'), stdout, exitCode };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('image-tip-check gate', () => {
    it('the harness can actually make it skip — a control on the assertions below', () => {
        // Every test here asserts a DECISION. If the harness could never produce
        // one of the two decisions, half of them would pass vacuously.
        const d = runGate({
            target: TIP,
            triggering: OLDER,
            runs: [{ status: 'in_progress', conclusion: null }],
        });
        expect(d.skipped).toBe(true);
    });

    it('THE INCIDENT: tip unbuilt, every publish cancelled — must ASK, not defer', () => {
        // 2026-09-10 15:19:09 and 15:25:08. The old gate skipped both times and
        // exited 0 while production sat three commits behind, because it said
        // "that commit's own publish will trigger this check". Under
        // cancel-in-progress starvation the tip's publish is cancelled too, so
        // it never triggers anything.
        const d = runGate({
            target: TIP,
            triggering: OLDER,
            runs: [
                { status: 'completed', conclusion: 'cancelled' },
                { status: 'completed', conclusion: 'cancelled' },
                { status: 'completed', conclusion: 'cancelled' },
            ],
        });
        expect(d.skipped).toBe(false);
        expect(d.stdout).toMatch(/NO publish queued or running/);
        expect(d.stdout).toMatch(/#877/);
    });

    it('the genuine race is still deferred: the tip IS building', () => {
        // The reason the gate exists. An older publish's cancellation fires
        // workflow_run while the tip's build is mid-flight. Failing there would
        // be a false alarm, and this must keep working.
        const d = runGate({
            target: TIP,
            triggering: OLDER,
            runs: [
                { status: 'in_progress', conclusion: null },
                { status: 'completed', conclusion: 'cancelled' },
            ],
        });
        expect(d.skipped).toBe(true);
        expect(d.stdout).toMatch(/still running/);
    });

    it('a queued publish counts as coming', () => {
        const d = runGate({ target: TIP, triggering: OLDER, runs: [{ status: 'queued', conclusion: null }] });
        expect(d.skipped).toBe(true);
    });

    it('a DIFFERENT workflow running on the tip is not a publish — must ASK', () => {
        // Without the `select(.name == $wf)` filter, any in-flight run on that
        // sha reads as "the publish is coming" and the gate defers forever.
        // Measured: dropping the filter left the other seven tests green,
        // because the stub used to stamp every run with the publish name. A
        // double more forgiving than the API cannot test the filter.
        const d = runGate({
            target: TIP,
            triggering: OLDER,
            runs: [
                { status: 'in_progress', conclusion: null, name: 'CI' },
                { status: 'in_progress', conclusion: null, name: 'CodeQL' },
                { status: 'completed', conclusion: 'cancelled' },
            ],
        });
        expect(d.skipped).toBe(false);
        expect(d.stdout).toMatch(/NO publish queued or running/);
    });

    it("the tip's own publish always asks", () => {
        const d = runGate({ target: TIP, triggering: TIP, runs: [] });
        expect(d.skipped).toBe(false);
        expect(d.stdout).toMatch(/this IS the tip's own publish/);
    });

    it('a FAILED probe asks rather than defers — not knowing is not a reason to be quiet', () => {
        // `|| echo 0` here would make a rate limit read as "nothing running",
        // which sends us down the skip path. That collapse is exactly what made
        // the CI-failure notifier go silent (#873). A probe that cannot answer
        // must not be treated as answering "no".
        const d = runGate({ target: TIP, triggering: OLDER, runs: 'fail' });
        expect(d.skipped).toBe(false);
        expect(d.stdout).toMatch(/Could not read the tip's publish runs/);
    });

    it('the workflow calls this script rather than re-inlining the decision', () => {
        const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/image-tip-check.yml'), 'utf8');
        expect(wf).toMatch(/image-tip-gate\.sh/);
        // and it can still ask GitHub about runs
        expect(wf).toMatch(/actions:\s*read/);
        expect(wf).toMatch(/GH_TOKEN/);
    });
});
