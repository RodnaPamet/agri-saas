/**
 * `:latest` may only move FORWARD (#2901), executed.
 *
 * On 2026-11-09 two publishes overlapped and finished out of order:
 *
 *     b92bd5032 (#2897, NEWER commit)  started 01:38:32  ended 01:50:06
 *     f56915555 (#2896, OLDER commit)  started 01:39:30  ended 01:59:54
 *
 * Both succeeded. The older one finished nine minutes later and overwrote
 * `:latest`, so production ran the older commit while the newer commit's
 * `sha-` tag sat correct and unused. Only `image-tip-check` noticed.
 *
 * ## The two cases that matter are both refusals
 *
 * Pushing is the easy half. What this file is really for is that the script
 * SKIPS when it must, and — the part a weaker test would miss — that it skips
 * when it cannot TELL. An unknown served commit must not read as "not an
 * ancestor": `git merge-base --is-ancestor` exits non-zero for an unknown
 * object exactly as it does for a real negative, so without the `cat-file`
 * gate a shallow clone would produce a decisive-looking answer meaning "I could
 * not see".
 *
 * Fail-safe here is SKIP, and the asymmetry is the whole argument: a wrong skip
 * leaves `:latest` stale and `image-tip-check` says so within minutes, on every
 * publish and daily. A wrong push puts production on older code silently.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/latest-is-forward-only.sh');

const SERVED = 'a'.repeat(40);
const THIS = 'b'.repeat(40);

interface Scenario {
    /** The revision label the registry reports, or '' for no label. */
    servedRevision?: string;
    /** Does `:latest` exist at all? */
    latestExists?: boolean;
    /** Is the served commit present in the clone? */
    commitPresent?: boolean;
    /** Is the served commit an ancestor of THIS_SHA? */
    isAncestor?: boolean;
    thisSha?: string;
}

function run(s: Scenario = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
    try {
        const rev = s.servedRevision ?? SERVED;
        const exists = s.latestExists ?? true;
        const docker = path.join(dir, 'docker');
        // `inspect --format` is the label read; a bare `inspect` is the
        // does-it-exist probe. They must answer independently, or "no label"
        // and "no image" collapse into one case.
        // The two calls are told apart by `--format`, NOT by argument count:
        // both carry four or more, so a count test answers the same for each
        // and the no-label case silently became "first publish".
        fs.writeFileSync(docker, `#!/bin/bash
if [ "$1" = "buildx" ]; then
  case "$*" in
    *--format*) ${exists && rev ? `echo '{"Config":{"Labels":{"org.opencontainers.image.revision":"${rev}"}}}'; exit 0` : 'exit 1'} ;;
    *)          ${exists ? 'exit 0' : 'exit 1'} ;;
  esac
fi
exit 0
`, { mode: 0o755 });
        const git = path.join(dir, 'git');
        fs.writeFileSync(git, `#!/bin/bash
case "$1" in
  cat-file)    exit ${s.commitPresent === false ? 1 : 0} ;;
  merge-base)  exit ${s.isAncestor === false ? 1 : 0} ;;
esac
exit 0
`, { mode: 0o755 });

        return execFileSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: { ...process.env, REF: 'ghcr.io/o/n', THIS_SHA: s.thisSha ?? THIS, DOCKER: docker, GIT: git },
        }).trim();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe(':latest may only move forward (#2901)', () => {
    it('PUSHES when the served commit is an ancestor — the ordinary case', () => {
        // The positive control. Without it every refusal below is satisfied by
        // a script that never pushes, which would freeze production.
        expect(run({ isAncestor: true })).toContain('LATEST_DECISION=push');
    });

    it('SKIPS when the served commit is NOT an ancestor — the #2901 case', () => {
        const out = run({ isAncestor: false });
        expect(out).toContain('LATEST_DECISION=skip');
        expect(out).toContain('NOT an ancestor');
    });

    it('PUSHES when re-publishing the very commit :latest serves', () => {
        // A re-run of the same commit is how today's incident was repaired by
        // hand. It must not be refused as "not newer".
        expect(run({ servedRevision: THIS, isAncestor: false })).toContain('LATEST_DECISION=push');
    });

    it('PUSHES on the FIRST publish, when no :latest exists', () => {
        expect(run({ latestExists: false })).toContain('LATEST_DECISION=push');
    });

    it('SKIPS when the served commit is not in the clone — not "not an ancestor"', () => {
        // `--is-ancestor` exits non-zero for an unknown object exactly as for a
        // real negative. Without the `cat-file` gate a shallow clone would look
        // like a decisive refusal; this asserts the REASON, so the two cannot
        // be confused by a reader of the log either.
        const out = run({ commitPresent: false });
        expect(out).toContain('LATEST_DECISION=skip');
        expect(out).toContain('not in this clone');
        expect(out).not.toContain('NOT an ancestor');
    });

    it('SKIPS when :latest exists but carries no revision label', () => {
        // Ordering cannot be established, so the fail-safe direction applies.
        const out = run({ servedRevision: '' });
        expect(out).toContain('LATEST_DECISION=skip');
        expect(out).toContain('no revision label');
    });

    it('always exits 0 — a refusal is a decision, not a broken publish', () => {
        // A non-zero exit here would fail the publish and file a ci-failure
        // issue for the case the guard exists to handle calmly.
        for (const s of [{ isAncestor: false }, { commitPresent: false }, { servedRevision: '' }]) {
            expect(() => run(s)).not.toThrow();
        }
    });
});
