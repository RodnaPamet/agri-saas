/**
 * The publish-retry decision logic, EXECUTED (#2582).
 *
 * This mechanism re-dispatches a production image publish, so the thing worth
 * testing is not that it retries — it is the three cases where it must NOT,
 * each of which would be a defect in production:
 *
 *   1. a CANCELLED publish is a supersession (the queue dropping a pending run
 *      because a newer commit arrived, since #877), so retrying it rebuilds an
 *      OLDER commit;
 *   2. a retry of a retry is a loop, and a genuinely broken build — a full
 *      disk, a bad Dockerfile — would spin until somebody noticed;
 *   3. a commit main has moved past must not be re-pushed, because
 *      `ghcr-publish.yml` tags `latest` as well as `sha-<short>`, so doing it
 *      would move `:latest` BACKWARDS — production told to run older code by
 *      the thing meant to repair it.
 *
 * `gh` is stubbed and every case asserts whether it was CALLED, because "it
 * printed a refusal" and "it refused" are different claims: a script that
 * explains itself and then re-dispatches anyway reads correct in the log.
 *
 * Logic in a script rather than in the workflow YAML for #676's reason — that
 * notifier's first version put its decisions inline where nothing could
 * execute them, and shipped two defects that both fired within two minutes.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/publish-retry.sh');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Scenario {
    conclusion?: string;
    runAttempt?: string;
    headSha?: string;
    tipSha?: string;
}

/** Runs the real script with a stubbed `gh` that logs every invocation. */
function run(s: Scenario = {}): { out: string; calls: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-retry-'));
    try {
        const callLog = path.join(dir, 'calls.txt');
        const ghStub = path.join(dir, 'gh');
        fs.writeFileSync(ghStub, `#!/bin/bash\necho "$*" >> ${callLog}\n`, { mode: 0o755 });

        const out = execFileSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: {
                ...process.env,
                GH: ghStub,
                REPO: 'owner/name',
                RUN_ID: '4242',
                CONCLUSION: s.conclusion ?? 'failure',
                RUN_ATTEMPT: s.runAttempt ?? '1',
                HEAD_SHA: s.headSha ?? SHA,
                TIP_SHA: s.tipSha ?? SHA,
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

const rerequested = (calls: string[]): boolean => calls.some((c) => c.includes('run rerun'));

describe('publish retry — re-dispatches a failed publish, and only that', () => {
    it('retries a FAILED publish of the current tip — the positive control', () => {
        // Without this every refusal below is satisfied by a script that never
        // retries anything, which is the state before #2582 rather than the one
        // it asks for.
        const { out, calls } = run();
        expect(rerequested(calls)).toBe(true);
        expect(calls[0]).toContain('--repo owner/name');
        expect(out).toContain('retrying run 4242');
    });

    it('does NOT retry a CANCELLED publish — a cancellation is a supersession', () => {
        // Since #877 the publish QUEUES rather than cancels, so a cancelled run
        // is one the queue dropped because a newer commit arrived. Retrying it
        // rebuilds the older commit.
        const { out, calls } = run({ conclusion: 'cancelled' });
        expect(rerequested(calls)).toBe(false);
        expect(out).toContain('SUPERSESSION');
    });

    it('does NOT retry a TIMED-OUT publish', () => {
        // The one real instance had already pushed successfully 13 minutes
        // before the budget killed it, so a retry rebuilds what is served.
        const { calls } = run({ conclusion: 'timed_out' });
        expect(rerequested(calls)).toBe(false);
    });

    it('does NOT retry a SUCCESS, which is the most common call by far', () => {
        const { calls } = run({ conclusion: 'success' });
        expect(rerequested(calls)).toBe(false);
    });

    it('never retries a RETRY — attempt 2 is left alone', () => {
        const { out, calls } = run({ runAttempt: '2' });
        expect(rerequested(calls)).toBe(false);
        expect(out).toContain('already retried');
    });

    it('does NOT re-push a commit main has moved past — `:latest` must not regress', () => {
        // `ghcr-publish.yml` pushes `type=raw,value=latest` alongside
        // `sha-<short>`, so re-publishing a superseded commit moves `:latest`
        // backwards. The newer commit's own publish covers it.
        const { out, calls } = run({ headSha: SHA, tipSha: OTHER });
        expect(rerequested(calls)).toBe(false);
        expect(out).toContain('tip MOVED');
    });

    it('exits 0 on every refusal, so a refusal is not reported as a broken workflow', () => {
        // A non-zero exit here would file a `ci-failure` issue for the normal
        // case — every successful publish in the repo — which is the
        // accumulating noise the notifier work removed.
        for (const s of [
            { conclusion: 'success' },
            { conclusion: 'cancelled' },
            { runAttempt: '2' },
            { tipSha: OTHER },
        ]) {
            expect(() => run(s)).not.toThrow();
        }
    });

    it('refuses to run at all without its inputs, rather than guessing', () => {
        // An absent `TIP_SHA` must not read as "the tip is empty, so nothing
        // matches, so do nothing" — that would be a silent no-op for the whole
        // mechanism.
        expect(() =>
            execFileSync('bash', [SCRIPT], {
                encoding: 'utf8',
                env: { ...process.env, REPO: 'o/r', CONCLUSION: 'failure', RUN_ID: '1', RUN_ATTEMPT: '1', HEAD_SHA: SHA, TIP_SHA: '' },
            }),
        ).toThrow();
    });
});
