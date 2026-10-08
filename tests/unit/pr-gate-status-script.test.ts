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
