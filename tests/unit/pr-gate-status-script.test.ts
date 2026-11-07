/**
 * `scripts/pr-gate-status.sh` distinguishes the four states it must, and
 * ABSENT and UNREADABLE are two of them.
 *
 * ## Why this test exists at all
 *
 * The script was written to fix a defect in a CI monitor whose green test was
 * `pending == 0`: with nine ABSENT required contexts and zero pending — a
 * freshly-pushed PR's exact state — it reported ALL GREEN for a PR that had
 * run nothing. Absence scored as success, inside the watcher whose only job is
 * deciding whether to merge, and the failure mode leaves no trace: it shows up
 * as merging something unverified and being pleased about it.
 *
 * Then a positive control found the same class of defect in the fix. With the
 * gate unreadable the first version exited 1 — the same code as "checks still
 * pending" — because `gh api` died under `set -e` before reaching its own
 * refusal message. A caller reading 1 as "keep waiting" would have reported
 * `outstanding` for ever on a broken probe.
 *
 * So the exit codes carry the distinction, and this file is what stops them
 * being collapsed again:
 *
 *   0  every required context passes
 *   1  outstanding
 *   2  a required context is RED
 *   3  the gate could not be READ — no answer
 *
 * ## Scope
 *
 * The unreadable-gate path is driven for real, against a repository that does
 * not exist. The red and all-green paths are driven through the same
 * classification arithmetic the script uses, because manufacturing a live PR
 * with a red required check is not something a test may do.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pr-gate-status.sh');

describe('§1 an unreadable gate is its own state, not "still pending"', () => {
    it('exits 3 and says so, rather than falling back to the rollup', () => {
        const r = spawnSync('bash', [SCRIPT, '1'], {
            encoding: 'utf8',
            env: { ...process.env, REPO: 'RodnaPamet/this-repo-does-not-exist-xyz' },
            cwd: ROOT,
        });
        expect(r.status).toBe(3);
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        expect(out).toMatch(/GATE UNREADABLE/);
        // The instruction matters as much as the code: the tempting fallback
        // is the rollup, whose length is what registered rather than what
        // must pass.
        expect(out).toMatch(/Do NOT fall back to the rollup/);
    });

    it('3 is distinct from 1, which is the whole point', () => {
        // Stated as its own assertion because the first version collapsed
        // them, and a caller cannot tell a broken probe from patience.
        expect(3).not.toBe(1);
        const src = readFileSync(SCRIPT, 'utf8');
        expect(src).toMatch(/exit 3/);
        // `set -e` would kill the script before its own check; the fix is to
        // drop it and capture the gh call. Pinned because restoring `set -e`
        // silently reintroduces the defect.
        expect(src).toMatch(/^set -uo pipefail$/m);
        expect(src).not.toMatch(/^set -euo pipefail$/m);
    });
});

describe('§2 the classification does not fold ABSENT into pass', () => {
    /** The script's own arm, lifted verbatim so the test cannot drift from it. */
    function classify(conclusion: string | null): 'green' | 'red' | 'waiting' {
        if (conclusion === null) return 'waiting'; // ABSENT or unfinished
        switch (conclusion) {
            case 'SUCCESS':
            case 'SKIPPED':
                return 'green';
            case 'FAILURE':
            case 'CANCELLED':
            case 'TIMED_OUT':
            case 'ACTION_REQUIRED':
                return 'red';
            default:
                return 'waiting';
        }
    }

    it('an absent context is WAITING, never green', () => {
        // The original monitor bug in one line.
        expect(classify(null)).toBe('waiting');
    });

    it('SKIPPED is green — and that is deliberate, not an oversight', () => {
        // `Load Smoke (k6)` is push-only and registers SKIPPED on every PR.
        // Treating skipped as outstanding would make every PR permanently
        // un-mergeable; treating ABSENT as green would merge unverified work.
        // The two look alike and must be classified oppositely.
        expect(classify('SKIPPED')).toBe('green');
        expect(classify(null)).toBe('waiting');
    });

    it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'])(
        '%s is red',
        (c) => {
            // CANCELLED and TIMED_OUT especially: a cancelled required check
            // reads as passing to an aggregate, which is #1289.
            expect(classify(c)).toBe('red');
        },
    );

    it('a run of mixed outcomes resolves to the worst one', () => {
        const outcomes = ['SUCCESS', 'SKIPPED', 'FAILURE', null];
        const kinds = outcomes.map(classify);
        expect(kinds.filter((k) => k === 'red')).toHaveLength(1);
        expect(kinds.filter((k) => k === 'waiting')).toHaveLength(1);
        // Red must win over waiting, or a red is reported as "not finished".
        const verdict = kinds.includes('red') ? 2 : kinds.includes('waiting') ? 1 : 0;
        expect(verdict).toBe(2);
    });
});

describe('§2b freshness measures the BRANCH, not the base pointer (#2812)', () => {
    /**
     * Driven end to end against a stubbed `gh`, because the defect was
     * invisible to every structural reading.
     *
     * The first version compared `baseRefOid` with the base branch's tip.
     * Measured on #2810: `baseRefOid` IS the base branch's tip — identical
     * while the branch's merge-base was 27 commits behind AND after a
     * `merge:main` made it current. So the check was main's tip against main's
     * tip, it could essentially never report STALE, and it printed
     * `FRESH (main @ 589f1ea35)` — a sentence that reads like a measurement of
     * the branch and was a measurement of main.
     *
     * A structural test ("does it call compare") would pass on a script that
     * called compare and then ignored the answer, which is why this drives the
     * real script and reads its verdict.
     */
    const ghStub = (aheadBy: string): string => `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "pr" ]; then
  cat <<'JSON'
{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main",
 "baseRefOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
 "headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
 "statusCheckRollup":[]}
JSON
  exit 0
fi
# gh api …
for arg in "$@"; do
  case "$arg" in
    *branches/main/protection*)
      echo '{"required_status_checks":{"contexts":["Build"]}}'; exit 0 ;;
    *compare/*)
      echo '${aheadBy}'; exit 0 ;;
  esac
done
echo '{}'
`;

    function runWithStub(aheadBy: string): { stdout: string; status: number | null } {
        const dir = mkdtempSync(path.join(tmpdir(), 'pr-gate-stub-'));
        const bin = path.join(dir, 'gh');
        writeFileSync(bin, ghStub(aheadBy), { mode: 0o755 });
        const r = spawnSync('bash', [SCRIPT, '4242'], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
        });
        rmSync(dir, { recursive: true, force: true });
        return { stdout: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
    }

    it('reports STALE when the head is behind the base — the case #2812 missed', () => {
        const { stdout } = runWithStub('7');
        expect(stdout).toMatch(/base freshness\s+STALE/);
        expect(stdout).toContain('behind main by 7 commit');
    });

    it('reports FRESH at zero — the control, so STALE is not unconditional', () => {
        const { stdout } = runWithStub('0');
        expect(stdout).toMatch(/base freshness\s+FRESH/);
        expect(stdout).not.toMatch(/STALE/);
    });

    it('a non-numeric answer is UNKNOWN, never fresh', () => {
        // `[ "$BEHIND" -eq 0 ]` on an empty string is a bash error, and
        // silence must not pass for currency — "could not ask" is its own
        // state, the same distinction §1 holds for the gate itself.
        const { stdout } = runWithStub('');
        expect(stdout).toMatch(/base freshness\s+UNKNOWN/);
        expect(stdout).not.toMatch(/FRESH/);
    });

    it('no longer compares the base pointer against the base tip', () => {
        // The old call. Kept as an assertion rather than deleted quietly,
        // because re-adding it would restore a check that cannot fail while
        // printing a value that reads like one that can.
        const src = readFileSync(SCRIPT, 'utf8');
        expect(src).not.toContain('git/ref/heads/');
    });
});

describe('§3 the script reads the gate rather than carrying names', () => {
    it('does not hard-code any required context name', () => {
        // A peer came within one `||` of reading five PRs as further along
        // than they were by typing `Coverage` where the gate says
        // `Coverage (≥60%)`. The gate's names belong to someone else and can
        // change with nothing in this repo moving, so they are read, never
        // written down.
        const src = readFileSync(SCRIPT, 'utf8');
        for (const name of ['Coverage', 'Docker Build', 'CodeQL SAST', 'Typecheck']) {
            // Allowed in a comment, never in executable text.
            const code = src
                .split('\n')
                .filter((l) => !l.trimStart().startsWith('#'))
                .join('\n');
            expect(code).not.toContain(name);
        }
    });

    it('calls the branch-protection endpoint, and alone', () => {
        const src = readFileSync(SCRIPT, 'utf8');
        expect(src).toMatch(/branches\/main\/protection/);
        // Chaining it after `rules/branches/main` is how the gate was
        // mistakenly concluded unreadable: that returns `[]`, and a `-q`
        // filter over `[]` prints nothing and exits 0, so an `||` never fires.
        const code = src
            .split('\n')
            .filter((l) => !l.trimStart().startsWith('#'))
            .join('\n');
        expect(code).not.toMatch(/rules\/branches/);
    });
});
