/**
 * The commit a branch is measured AGAINST, and how to read a file at it.
 *
 * Extracted from `tests/guards/rendered-coverage-floor.test.ts`, which proved
 * the resolution order, so there is ONE implementation rather than a second
 * that drifts — the same reason `scripts/lib/coverage-groups.mjs` holds jest's
 * group algorithm once.
 *
 * ## Resolution order, and why CI's value wins
 *
 * CI supplies `RATCHET_BASE_SHA` explicitly, using the expression the
 * selector-teeth job proved: `github.event.pull_request.base.sha ||
 * github.event.before`. GitHub knows the PR's base exactly, whereas
 * `merge-base --fork-point` is a guess that inverts on a branch that is
 * BEHIND — reporting a peer's merged work as your deletions. Locally there is
 * no such env, so fall back to a merge-base against `origin/main`: a developer
 * running jest is not the enforcement point, CI is.
 *
 * ## Absence is three different things
 *
 * - **Unset** — a local run. Degrade, and say so.
 * - **Set but the OBJECT is unreadable** — the shallow-clone case. The sha
 *   names a commit this clone never fetched, or (with
 *   `--filter=blob:none`) fetched the TREES of but not the BLOBS. A guard that
 *   returns quietly here is a vacuous pass WITH the require-flag on, which is
 *   the hole the flag exists to close.
 * - **Set and readable** — the enforcing path.
 *
 * `requireBase()` is what turns the first two fatal where the base is
 * guaranteed. Callers must distinguish them in their message: "I could not
 * look" and "there is nothing there" are different facts.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '../..');

/** Is a missing base a configuration failure rather than an environment fact? */
export function requireBase(): boolean {
    return process.env.RATCHET_DELTA_REQUIRE_BASE === '1';
}

/** The sha this branch is measured against, or null when none can be resolved. */
export function baseSha(): string | null {
    const fromCi = process.env.RATCHET_BASE_SHA?.trim();
    if (fromCi && /^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi;
    try {
        const sha = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

/**
 * The CONTENT of `rel` as it was at `sha`, or null if it cannot be read.
 *
 * Null covers both "the path did not exist at that commit" (a genuinely new
 * file) and "this clone does not have the blob". Those are different facts and
 * a caller that treats either as "no change" is wrong, so the two are
 * separated by `blobPresentAt` below.
 */
export function readFileAtSha(sha: string, rel: string): string | null {
    try {
        return execFileSync('git', ['show', `${sha}:${rel}`], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 64 * 1024 * 1024, // the spec is ~1MB and growing
        });
    } catch {
        return null;
    }
}

/**
 * Is the COMMIT itself readable in this clone?
 *
 * Load-bearing, and the reason is a positive control that failed. `blobPresentAt`
 * returns false for BOTH "the path was not in that tree" (a genuinely new file,
 * a real pass) and "this clone does not have that commit at all" (could not
 * look, and a vacuous pass if treated as the first). A bogus
 * `RATCHET_BASE_SHA` therefore sailed through a require-flagged run — the
 * failure mode the flag exists to prevent, reproduced by the code written to
 * prevent it.
 *
 * Ask about the commit FIRST: unreadable commit means unknown, never empty.
 */
export function commitPresent(sha: string): boolean {
    try {
        execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
            cwd: REPO_ROOT,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Did `rel` EXIST at `sha`, judged from the tree rather than the blob?
 *
 * `git ls-tree` needs only trees, which a `--filter=blob:none` fetch does
 * supply — so this answers "was the file there" even where `readFileAtSha`
 * cannot answer "what did it say". That is exactly the pair needed to tell a
 * new file from an unfetched blob, and getting it wrong in the lenient
 * direction turns the gate off silently.
 */
export function blobPresentAt(sha: string, rel: string): boolean {
    try {
        const out = execFileSync('git', ['ls-tree', '--name-only', sha, rel], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out.length > 0;
    } catch {
        return false;
    }
}
