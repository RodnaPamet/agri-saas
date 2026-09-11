/**
 * Deterministic-install ratchet.
 *
 * Locks in the strict, reproducible install model so a future "make
 * the build pass" shortcut cannot quietly reintroduce a
 * non-deterministic install:
 *
 *   1. Every install path (Dockerfile + CI workflows) uses `npm ci`,
 *      never `npm install`. `npm ci` installs EXACTLY the
 *      `package-lock.json` tree and fails fast if the lockfile is out
 *      of sync with `package.json`. `npm install` can mutate the
 *      lockfile and re-resolve semver ranges to fresh versions — so
 *      two CI runs of the same commit are no longer guaranteed
 *      identical, and a corrupt lockfile is silently "repaired"
 *      instead of surfaced.
 *
 *   2. `package.json` declares an `engines` policy (node + npm) so the
 *      supported runtime is explicit, not tribal knowledge.
 *
 *   3. The Node major version is pinned CONSISTENTLY across `.nvmrc`,
 *      `engines.node`, and every workflow's `node-version` — local,
 *      CI, and release environments all install on the same runtime.
 *
 * Companion ratchet: `no-legacy-peer-deps.test.ts` (strict peer
 * resolution). Together they make the whole install surface
 * trustworthy. The rationale is written up in
 * `docs/dependency-policy.md` — a POINTER, not an assertion: nothing
 * in this file opens that document, so nothing here fails if its
 * prose goes stale. Repo-wide the only check on it is an existence
 * test (`dependency-governance-integrity.test.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Dockerfile(s) + every CI workflow — the dependency-install surface. */
function installPathFiles(): string[] {
    const files: string[] = [];
    for (const f of fs.readdirSync(ROOT)) {
        if (/^Dockerfile/.test(f)) files.push(f);
    }
    const wfDir = path.join(ROOT, '.github/workflows');
    if (fs.existsSync(wfDir)) {
        for (const f of fs.readdirSync(wfDir)) {
            if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
        }
    }
    return files;
}

/**
 * Strip the comment portion of a line (a `#` at line-start or
 * preceded by whitespace — covers Dockerfile + YAML comments and
 * trailing `RUN ... # note` comments) so a prose mention of
 * `npm install` inside a comment is never mistaken for a command.
 */
const stripComment = (line: string) => line.replace(/(^|\s)#.*$/, '');

/**
 * The node-version SELECTOR. Shared with its control below on purpose: an
 * inline copy can be killed (a regex that matches no line) while the control
 * keeps using a private, working one, and then the control proves nothing
 * about the path that matters. Measured: a never-matching regex here left
 * all four tests green.
 */
const NODE_VERSION_RE = /\bnode-version:\s*(.+?)\s*$/;

/** `npm install` and its aliases (`npm i`, `npm add`) — the verbs we ban. */
const NPM_INSTALL = /\bnpm\s+(install|i|add)\b/;

describe('deterministic install model', () => {
    it('every install path uses `npm ci`, never `npm install`', () => {
        const offenders: string[] = [];
        for (const rel of installPathFiles()) {
            read(rel)
                .split('\n')
                .forEach((line, i) => {
                    if (NPM_INSTALL.test(stripComment(line))) {
                        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
                    }
                });
        }
        expect(offenders).toEqual([]);
    });

    it('the install surface actually invokes `npm ci` (guard is not vacuous)', () => {
        const usesCi = installPathFiles().some((rel) =>
            /\bnpm\s+ci\b/.test(read(rel)),
        );
        expect(usesCi).toBe(true);
    });

    it('package.json declares an engines policy (node + npm)', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.engines).toBeDefined();
        expect(typeof pkg.engines.node).toBe('string');
        expect(typeof pkg.engines.npm).toBe('string');
        // The supported runtime is Node 22 across all environments.
        expect(pkg.engines.node).toContain('22');
    });

    it('the node-version selector actually matches production workflows', () => {
        // NODE_VERSION_RE is the selector the assertion below filters through.
        // A regex that matches nothing yields zero offenders and passes — the
        // empty-selection class. This counts what the SAME regex extracts from
        // the SAME files, so a dead selector cannot satisfy it.
        const found: string[] = [];
        for (const rel of installPathFiles()) {
            if (!rel.startsWith('.github/workflows/')) continue;
            for (const line of read(rel).split('\n')) {
                const m = stripComment(line).match(NODE_VERSION_RE);
                if (m) found.push(`${rel}: ${m[1]}`);
            }
        }
        expect(found.length).toBeGreaterThan(2);
    });

    it('the Node version is pinned consistently (.nvmrc / engines / workflows)', () => {
        // .nvmrc is the source of truth for version-manager users.
        const nvmrc = read('.nvmrc').trim();
        const nvmMajor = nvmrc.split('.')[0];
        expect(nvmMajor).toBe('22');

        // engines.node must admit that major.
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.engines.node).toContain(nvmMajor);

        // Every workflow `node-version:` must agree — either the literal
        // major, or ci.yml's `${{ env.NODE_VERSION }}` indirection.
        const offenders: string[] = [];
        for (const rel of installPathFiles()) {
            if (!rel.startsWith('.github/workflows/')) continue;
            read(rel)
                .split('\n')
                .forEach((line, i) => {
                    const m = stripComment(line).match(NODE_VERSION_RE);
                    if (!m) return;
                    // Value may be '22' / "22" or a GitHub Actions
                    // expression `${{ env.NODE_VERSION }}`.
                    const v = m[1].replace(/['"]/g, '');
                    const ok =
                        v.includes('NODE_VERSION') ||
                        v.split('.')[0] === nvmMajor;
                    if (!ok) offenders.push(`${rel}:${i + 1}  node-version: ${v}`);
                });
        }
        expect(offenders).toEqual([]);
    });
});
