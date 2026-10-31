/**
 * The public-surface probe can actually FILE its issue — #2561.
 *
 * ## The defect this exists for
 *
 * `Raise it` had never once succeeded. It located an existing issue with
 *
 *     --json number,state --jq '.[0] | "\(.number) \(.state)"'
 *
 * and for an EMPTY result `.[0]` is null, so the interpolation produced the
 * literal string `"null null"` — measured:
 *
 *     echo '[]' | jq -r '.[0] | "\(.number) \(.state)"'   =>  null null
 *     echo '[]' | jq -r '.[0].number // empty'            =>  (nothing)
 *
 * `"null null"` is non-empty, so `[ -n "$existing" ]` took the
 * reopen-and-comment branch with `num=null`, `gh issue reopen null` was
 * swallowed by its own `2>/dev/null || true`, and `gh issue comment null`
 * exited 1 with `invalid issue format: "null"`. **The create branch was
 * unreachable**, so the step could only work where an issue already existed
 * under the same title — and none ever did.
 *
 * Observed on run 41202376983, where the probe computed `VERDICT: OUTAGE` and
 * the step then died, leaving only the generic `CI failure:` notifier. That
 * notifier does not carry the verdict, so the DARK/OUTAGE distinction this
 * probe exists to make was computed, logged and thrown away.
 *
 * ## Why this EXECUTES the step's shell instead of asserting on its text
 *
 * The bug was in a jq expression inside a shell block inside YAML. A guard
 * matching source text would have to encode the right expression to compare
 * against, which is the same act as writing it — and `#2403` records this
 * repo's own version of that mistake, where a check for compliance matched
 * prose. So this lifts the `run:` block out of the workflow and runs it under
 * `bash` with a stubbed `gh`, the pattern `ci-aggregate-upstream-failure` uses
 * for the aggregate jobs and `restore-drill-remote-script` for the drill.
 *
 * The stub pipes canned JSON through the REAL `jq` using the expression it was
 * handed, so the assertion covers the actual expression in the actual file.
 * A stub that returned a pre-digested number would have passed against the
 * broken version.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = '.github/workflows/public-surface-probe.yml';

type Step = { name?: string; run?: string; id?: string };
const DOC = yaml.load(readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8')) as {
    jobs: Record<string, { 'timeout-minutes'?: number; steps: Step[] }>;
};
const JOB = DOC.jobs.probe;
const STEPS = JOB.steps;
const RAISE = STEPS.find((s) => s.name === 'Raise it');
const PROBE = STEPS.find((s) => s.name === 'Probe');

/**
 * Run the `Raise it` block with a `gh` that records its argv and answers
 * `issue list` by piping `listJson` through the real `jq`.
 */
function runRaiseIt(listJson: string): { calls: string[]; status: number; stderr: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'probe-raise-'));
    const log = path.join(dir, 'calls.log');
    const ghStub = path.join(dir, 'gh');
    writeFileSync(
        ghStub,
        [
            '#!/usr/bin/env bash',
            'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
            'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
            '    expr=""; prev=""',
            '    for a in "$@"; do',
            '        if [ "$prev" = "--jq" ]; then expr="$a"; fi',
            '        prev="$a"',
            '    done',
            // The real jq, on the real expression out of the workflow.
            '    printf "%s" "$GH_STUB_LIST_JSON" | jq -r "$expr"',
            'fi',
            'exit 0',
        ].join('\n'),
        'utf8',
    );
    chmodSync(ghStub, 0o755);
    writeFileSync(log, '', 'utf8');

    const script = path.join(dir, 'raise.sh');
    writeFileSync(script, RAISE?.run ?? '', 'utf8');

    let status = 0;
    let stderr = '';
    try {
        execFileSync('bash', [script], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH ?? ''}`,
                GH_STUB_LOG: log,
                GH_STUB_LIST_JSON: listJson,
                GH_TOKEN: 'stub-token-not-a-credential', // pragma: allowlist secret
                VERDICT: 'OUTAGE',
                DETAIL: 'the ungated control /robots.txt answered 502',
                RUN_URL: 'https://example.invalid/run/1',
            },
        });
    } catch (error) {
        const e = error as { status?: number; stderr?: string };
        status = e.status ?? 1;
        stderr = e.stderr ?? '';
    }
    return { calls: readFileSync(log, 'utf8').split('\n').filter(Boolean), status, stderr };
}

describe('public-surface probe escalation (#2561)', () => {
    it('lifts a real step out of the workflow — not an empty string', () => {
        // Without this the two scenarios below would run an empty script,
        // exit 0, and assert nothing. A renamed step is the likely cause.
        console.log(
            `[probe-escalation] ${STEPS.length} step(s); Raise it is `
                + `${(RAISE?.run ?? '').length} chars, Probe is ${(PROBE?.run ?? '').length}`,
        );
        expect(RAISE).toBeDefined();
        expect((RAISE?.run ?? '').length).toBeGreaterThan(400);
        expect(RAISE?.run).toContain('gh issue create');
        expect(RAISE?.run).toContain('gh issue comment');
    });

    it('FILES a new issue when none exists — the branch that was unreachable', () => {
        const { calls, status, stderr } = runRaiseIt('[]');
        expect({ status, stderr: stderr.slice(0, 200) }).toEqual({ status: 0, stderr: '' });
        expect(calls.some((c) => c.startsWith('issue create'))).toBe(true);
        // And it must NOT have tried to comment on a non-issue, which is the
        // exact failure: `invalid issue format: "null"`.
        expect(calls.filter((c) => /^issue (comment|reopen)/.test(c))).toEqual([]);
        expect(calls.join('\n')).not.toContain('null');
    });

    it('COMMENTS on the existing issue when there is one, and reopens it', () => {
        const { calls, status } = runRaiseIt('[{"number":123,"state":"CLOSED"}]');
        expect(status).toBe(0);
        expect(calls.some((c) => c.startsWith('issue reopen 123'))).toBe(true);
        expect(calls.some((c) => c.startsWith('issue comment 123'))).toBe(true);
        expect(calls.some((c) => c.startsWith('issue create'))).toBe(false);
    });

    it('carries the VERDICT into the title, which the generic notifier cannot', () => {
        // The reason this step exists at all: `CI failure: Public surface
        // probe` says `failure` and nothing else, so an operator cannot tell a
        // dark gated surface from a restarting site.
        const { calls } = runRaiseIt('[]');
        const create = calls.find((c) => c.startsWith('issue create')) ?? '';
        expect(create).toContain('Public surface probe: OUTAGE');
        expect(create).toContain('/robots.txt answered 502');
    });

    it('the Probe step retries, so a deploy restart is not an outage', () => {
        // This file's own header records watchtower polling `:latest` every 60
        // seconds, and a restart behind a live Caddy is what returns 502 on an
        // ungated control. Three samples 40s apart outlast it; a real outage
        // survives them. `timeout` is per attempt — `ci-retry-loop-timeout`
        // enumerates this loop and requires it.
        expect(PROBE?.run).toMatch(/for attempt in 1 2 3/);
        expect(PROBE?.run).toMatch(/timeout\s+\d+\s+npx/);
        expect(PROBE?.run).toMatch(/sleep\s+\d+/);
        // Still fails closed, or an outage goes unreported here.
        expect(PROBE?.run).toMatch(/\|\|\s*exit 1/);
        // Worst case must fit the job budget: 3 attempts + 2 sleeps.
        const perAttempt = Number(/timeout\s+(\d+)\s+npx/.exec(PROBE?.run ?? '')?.[1]);
        const gap = Number(/sleep\s+(\d+)/.exec(PROBE?.run ?? '')?.[1]);
        const budget = (JOB['timeout-minutes'] ?? 0) * 60;
        console.log(
            `[probe-escalation] worst case ${3 * perAttempt + 2 * gap}s against a ${budget}s job budget`,
        );
        expect(3 * perAttempt + 2 * gap).toBeLessThan(budget);
    });
});
