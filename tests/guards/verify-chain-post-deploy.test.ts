/**
 * #3099's post-deploy half, EXECUTED — including its embedded shell.
 *
 * ## Why this is an execution test and not a guard over the source
 *
 * `deploy/verify-chain.sh` sends shell snippets into containers through
 * `docker compose exec -T … sh -c '…'`, which is three levels of quoting. The
 * bugs in a script like that are quoting bugs, and a test that stubbed the
 * OUTPUT would grade the decision logic while leaving the shell unexercised —
 * the exact split that let `$$` be eaten by a remote shell earlier today, and
 * the reason `restore-drill-remote-script.test.ts` asserts its payload is
 * byte-identical to its heredoc.
 *
 * So the script's paths are env-overridable and this runs the REAL script,
 * with `CHAIN_LOCAL=1` and a `CHAIN_DOCKER` stub that executes each snippet
 * locally against a temp filesystem. The embedded shell really runs.
 *
 * ## What each case is about
 *
 * The three questions correspond to three defects that all had a correct image
 * AND a correct compose file, so neither the in-image check nor the
 * declaration guard could see them:
 *
 *   Q1 -> #3113  the share was root:root, so the publish failed best-effort
 *   Q2 -> #3117  ESM resolves a bare import from the FILE's URL, not the cwd
 *   Q3 -> #3120  the worker never mounted the volume the producer writes to
 *
 * ## The exit codes are the contract
 *
 *   0  chain healthy
 *   2  DEPLOYED AND DEGRADED — must say do-not-roll-back
 *   1  could not look — a third thing, and not a pass
 */
import { execFile } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '../../deploy/verify-chain.sh');
const BUNDLE = 'zarnoborsa-fetch.mjs';

interface Scenario {
    /** bytes of the app's own dist/ copy; 0 = absent */
    imageBytes?: number;
    /** bytes published into the share; 0 = absent */
    publishedBytes?: number;
    /** does the fetch mount carry the bundle, and does its import resolve? */
    fetchImport?: 'resolves' | 'fails' | 'none';
    /** can the worker read the handoff dir? */
    workerReads?: boolean;
    /** make a container unanswerable, to exercise the "could not look" path */
    silent?: 'app' | 'zarnoborsa' | 'worker';
}

function build(s: Scenario): { root: string; env: Record<string, string> } {
    const root = mkdtempSync(join(tmpdir(), 'chain-'));
    const appDist = join(root, 'app-dist');
    const share = join(root, 'share');
    const pkgRoot = join(root, 'pkg');
    /*
     * UNDER the package root, not beside it — which is the whole #3117
     * property and which my first fixture got wrong: I made these siblings,
     * resolution legitimately failed, and the script correctly refused a
     * "healthy" scenario. Every failure case passed while the positive did
     * not, which is the tell that the FIXTURE was wrong rather than the
     * subject. Worth keeping as a comment: a harness that does not reproduce
     * the real topology tests something else.
     */
    const fetchMount = join(pkgRoot, 'dist');
    const handoff = join(root, 'handoff');
    for (const d of [appDist, share, fetchMount, pkgRoot, handoff]) mkdirSync(d, { recursive: true });

    const img = s.imageBytes ?? 7490;
    if (img > 0) writeFileSync(join(appDist, BUNDLE), Buffer.alloc(img, 0x20));
    const pub = s.publishedBytes ?? img;
    if (pub > 0) writeFileSync(join(share, BUNDLE), Buffer.alloc(pub, 0x20));

    // The fetch mount's copy, whose BARE IMPORT the script extracts and probes.
    const mode = s.fetchImport ?? 'resolves';
    if (mode === 'none') {
        writeFileSync(join(fetchMount, BUNDLE), 'console.log("no imports here");\n');
    } else {
        writeFileSync(join(fetchMount, BUNDLE), 'import x from "faux-pkg";\nconsole.log(x);\n');
    }
    if (mode === 'resolves') {
        // A real resolvable package, in the PACKAGE ROOT — so resolution only
        // succeeds if the probe file is written inside the mount under that
        // root, which is the whole property (#3117).
        const pkg = join(pkgRoot, 'node_modules', 'faux-pkg');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'faux-pkg', version: '1.0.0', main: 'i.mjs' }));
        writeFileSync(join(pkg, 'i.mjs'), 'export default 1;\n');
    }

    if (s.workerReads === false) rmSync(handoff, { recursive: true, force: true });

    // The stub: `… exec -T <service> sh -c <script>` runs <script> locally.
    // A `silent` service produces nothing, which is the could-not-look case.
    const stub = join(root, 'dc');
    writeFileSync(stub, `#!/usr/bin/env bash
svc=""
for a in "$@"; do case "$a" in app|zarnoborsa|worker) svc="$a"; break;; esac; done
if [ "$svc" = "${s.silent ?? '__none__'}" ]; then exit 0; fi
script="\${@: -1}"
cd ${JSON.stringify(mode === 'resolves' ? pkgRoot : root)} 2>/dev/null || true
bash -c "$script"
`);
    chmodSync(stub, 0o755);

    return {
        root,
        env: {
            CHAIN_LOCAL: '1',
            CHAIN_DOCKER: stub,
            CHAIN_BUNDLE: BUNDLE,
            CHAIN_APP_DIST: appDist,
            CHAIN_APP_SHARE: share,
            CHAIN_FETCH_MOUNT: fetchMount,
            CHAIN_FETCH_PKG_ROOT: pkgRoot,
            CHAIN_HANDOFF_DIR: handoff,
        },
    };
}

function run(env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
        execFile('bash', [SCRIPT], { env: { ...process.env, ...env } }, (e, stdout, stderr) => {
            const code = e && typeof (e as { code?: number }).code === 'number'
                ? (e as { code: number }).code
                : e ? 1 : 0;
            resolve({ code, out: String(stdout), err: String(stderr) });
        });
    });
}

describe('deploy/verify-chain.sh — the post-deploy half (#3099)', () => {
    const roots: string[] = [];
    const scenario = (s: Scenario) => {
        const b = build(s);
        roots.push(b.root);
        return b.env;
    };
    afterAll(() => {
        for (const r of roots) rmSync(r, { recursive: true, force: true });
    });

    it('EXIT 0 on a healthy chain — the control for every failure below', async () => {
        const r = await run(scenario({}));
        expect(r.code).toBe(0);
        expect(r.out).toContain('chain OK');
        // The DENOMINATOR: a green run over one check and over three are the
        // same line without it.
        expect(r.out).toContain('3 check(s)');
    });

    it('Q1 — EXIT 2 when the share is EMPTY (#3113, the root-owned volume)', async () => {
        const r = await run(scenario({ publishedBytes: 0 }));
        expect(r.code).toBe(2);
        expect(r.err).toContain('is absent or empty');
        expect(r.err).toContain('MOUNT flag');
    });

    it('Q1 — EXIT 2 on a STALE publish, where bytes disagree', async () => {
        const r = await run(scenario({ imageBytes: 7490, publishedBytes: 4000 }));
        expect(r.code).toBe(2);
        expect(r.err).toContain('Stale publish');
    });

    it('Q2 — EXIT 2 when the bundle\'s import does NOT resolve (#3117)', async () => {
        const r = await run(scenario({ fetchImport: 'fails' }));
        expect(r.code).toBe(2);
        expect(r.err).toContain('does NOT resolve from its mount');
        expect(r.err).toContain('ignores the cwd');
    });

    it('Q2 — SKIPS rather than passing when there is no bare import', async () => {
        // Not a failure and not silently a pass: a bundle with no external
        // import has nothing to resolve, and reporting that as OK would make
        // an empty probe indistinguishable from a working one.
        const r = await run(scenario({ fetchImport: 'none' }));
        expect(r.code).toBe(0);
        expect(r.out).toContain('no bare import');
    });

    it('Q3 — EXIT 2 when the worker cannot read the handoff (#3120)', async () => {
        const r = await run(scenario({ workerReads: false }));
        expect(r.code).toBe(2);
        expect(r.err).toContain('cannot read');
        expect(r.err).toContain('unaudited');
    });

    it('a DEGRADED verdict says DO NOT ROLL BACK, in those words', async () => {
        // The whole failure posture. #2692 is what happens when a non-outage
        // reads as one: people paste the rollback and undo a working deploy.
        const r = await run(scenario({ workerReads: false }));
        expect(r.code).toBe(2);
        expect(r.err).toContain('DEPLOYED AND DEGRADED');
        expect(r.err).toContain('DO NOT ROLL BACK');
    });

    it.each(['app', 'zarnoborsa', 'worker'] as const)(
        'EXIT 1 — not 2 and not 0 — when the %s container cannot be asked',
        async (svc) => {
            // "Could not look" is a third thing. Folded into the degraded code
            // it would send someone chasing a chain that may be fine; folded
            // into 0 it is `absence-reads-as-success`.
            const r = await run(scenario({ silent: svc }));
            expect(r.code).toBe(1);
            expect(r.err).toContain('UNREADABLE');
            expect(r.err).toContain('Not a pass');
        },
    );

    it('apply.sh wires it WITHOUT folding it into HEALTH_FAILED', async () => {
        // The integration property, asserted on source because no test can run
        // a real apply: a chain finding must not reach the health accumulator,
        // or a dead background feature would read as "roll back".
        const apply = require('fs').readFileSync(join(__dirname, '../../deploy/apply.sh'), 'utf8') as string;
        expect(apply).toContain('verify-chain.sh');
        expect(apply).toContain('CHAIN_STATUS');
        // The load-bearing absence: the chain's status is never OR-ed into the
        // health flag.
        expect(apply).not.toMatch(/HEALTH_FAILED=.*CHAIN/);
        expect(apply).not.toMatch(/CHAIN_STATUS.*HEALTH_FAILED=1/);
        expect(apply).toContain('do not roll back');
    });
});
