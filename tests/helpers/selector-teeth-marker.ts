/**
 * Is a `selector-teeth` sweep currently holding a source file gutted? (#1171 mode 1)
 *
 * ## What this is for
 *
 * `scripts/selector-teeth.mjs` rewrites a guard file IN PLACE and runs jest
 * against that path, so for the length of each `runGuard` call the file on
 * disk is a mutant. Anything else reading it in that window gets a confident
 * wrong answer — a detector reported a guard as having a dead selector when
 * the sweep merely had it gutted at that instant. The two readings were only
 * separable because they disagreed over a clean `git status`.
 *
 * The window is not small: ~104 files × ~9 guts, no timeout on the sweep by
 * design, so it is open almost continuously for hours. The standing advice —
 * "while a sweep runs, do not run jest anywhere else in the repo" — is a rule
 * an operator has to remember, which is not a control.
 *
 * The sweep now publishes what it is gutting. This reads that, so a reader at
 * a choke point can REFUSE instead of answering.
 *
 * ## Why the git common directory
 *
 * The contamination crosses checkouts, and every worktree of this repo
 * resolves the same `--git-common-dir`. `node_modules/.cache` is per-worktree
 * and would make a sweep in one checkout invisible to a reader in another.
 * Not `os.tmpdir()`: a predictable name in a world-writable directory is a
 * symlink-race vector (CodeQL js/insecure-temporary-file) — the same reason
 * `PER_WORKER_MARKER` is repo-local.
 *
 * ## A dead owner is STALE, never an answer
 *
 * The sweep cannot always clear its own marker. Almost all of its wall clock
 * is inside a blocking `spawnSync`, where node cannot deliver a signal, so a
 * SIGTERM can kill it with the marker still on disk — the same reason it
 * carries a `[recovered]` path for stray `.teeth-bak` files. A marker whose
 * pid is gone therefore reads as absent. Treating it as live would turn one
 * interrupted sweep into a repo nobody can run tests in.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Kept identical to `MARKER_BASENAME` in scripts/selector-teeth.mjs. */
export const MARKER_BASENAME = 'selector-teeth-active.json';

export interface ActiveMutation {
    pid: number;
    file: string;
    selector?: string;
    gut?: string;
    line?: number;
    startedAt?: string;
}

export function markerPath(): string {
    // Kept in lockstep with the writer's override, and proven so by a test
    // that has the SCRIPT write a marker this reader then reads.
    if (process.env.SELECTOR_TEETH_MARKER) return path.resolve(process.env.SELECTOR_TEETH_MARKER);
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
    }).trim();
    return path.join(path.resolve(common), MARKER_BASENAME);
}

function pidAlive(pid: number): boolean {
    try {
        // Signal 0 tests for existence without delivering anything.
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * The mutation a LIVE sweep is currently holding, or `null`.
 *
 * `null` covers every ambiguous case — no marker, unreadable, malformed, or a
 * dead owner — because this gates whether other work may proceed, and a
 * reader that cannot tell must not block.
 */
export function readActiveMutation(): ActiveMutation | null {
    let raw: string;
    try {
        raw = fs.readFileSync(markerPath(), 'utf8');
    } catch {
        return null; // absent, or no git available
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const m = parsed as ActiveMutation;
    if (typeof m?.pid !== 'number' || typeof m?.file !== 'string') return null;
    if (!pidAlive(m.pid)) return null;
    return m;
}

/**
 * Refuse to proceed while somebody else's sweep holds a file gutted.
 *
 * Exempt: the sweep's OWN jest child, which carries `SELECTOR_TEETH_OWNER`
 * equal to the marker's pid — it is supposed to run against the mutant, that
 * being the entire measurement.
 *
 * Escape hatch: `SELECTOR_TEETH_ALLOW_CONCURRENT=1` downgrades the refusal to
 * a warning. It exists because this is a correctness aid, not a security
 * control, and an operator who knows their suite reads none of the swept
 * files should not be blocked — but it says so loudly, so a surprising result
 * afterwards is attributable.
 */
export function assertNoForeignMutation(what: string): void {
    const m = readActiveMutation();
    if (!m) return;
    if (process.env.SELECTOR_TEETH_OWNER === String(m.pid)) return;

    const where = m.selector ? `${m.file} :: ${m.selector}()` : m.file;
    const detail =
        `a selector-teeth sweep (pid ${m.pid}, since ${m.startedAt ?? 'unknown'}) is holding\n` +
        `  ${where}${m.gut ? ` gutted to \`${m.gut}\`` : ' gutted'}\n` +
        `on disk right now. That file is a MUTANT: any result from it is about the\n` +
        `mutation, not about your tree — which is how a guard was once reported as\n` +
        `having a dead selector it did not have.`;

    if (process.env.SELECTOR_TEETH_ALLOW_CONCURRENT === '1') {
        console.warn(`\n[${what}] PROCEEDING OVER A LIVE MUTATION — ${detail}\n`);
        return;
    }
    throw new Error(
        `${what}: refusing to run while a sweep is mutating this repo.\n\n${detail}\n\n` +
            `Wait for the sweep, or set SELECTOR_TEETH_ALLOW_CONCURRENT=1 if your suite\n` +
            `reads none of the swept files.`,
    );
}
