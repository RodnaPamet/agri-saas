/**
 * The audit gate's TEST-ONLY doors must never be opened in CI.
 *
 * `scripts/audit-exemptions.mjs` takes two test-only env overrides:
 *
 *   · `EXEMPT_OVERRIDE`       — replaces the real (empty) exemption list
 *   · `AUDIT_CANARY_OVERRIDE` — replaces the advisory-feed positive control
 *
 * Either one, set in a workflow, silently disarms the gate: the first lets
 * any advisory be "exempt", the second lets a blind advisory feed be
 * declared live. Both would leave the job green.
 *
 * `AUDIT_JSON_OVERRIDE` is deliberately NOT in this list. It stopped being
 * test-only when CI moved to capturing one report and handing the script
 * those exact bytes — it is now the primary input on both paths, which is
 * what makes the tested path and the production path the same path rather
 * than two parallel ones.
 *
 * This is the shape of guard the repo already uses for other "escape hatch
 * that must not reach production" cases. It exists because the gate it
 * protects spent an unknown period reporting "✓ every remaining moderate+
 * advisory is tracked and exempt" while checking nothing at all: an
 * absence of findings and an absence of checking produced identical output.
 * Every lever that can reproduce that deserves a ratchet.
 *
 * ## Scoped to the BEHAVIOUR, not to where an instance was found
 *
 * The first version of this file scanned `.github/` only — because that is
 * where CI lives, and CI is where the danger seemed to be. But the levers
 * are environment variables, and anything that can invoke the gate in an
 * automated context can set them: a `package.json` script, a shell script
 * under `scripts/`, a Dockerfile. None do today, which is exactly why the
 * narrower version would have looked correct indefinitely.
 *
 * Three separate guards in this repo were caught on the same day scoped to
 * an instance rather than to the behaviour — one allowlisting a route BY
 * PATH and missing the file it was extracted into, one detecting
 * dependency-installing jobs by the composite action they happened to use
 * and so excluding the job with the worst case, and this one. A rule that
 * enumerates where it has seen the pattern cannot see the pattern
 * somewhere new; a rule that derives from what the thing DOES can.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
/**
 * Every root from which the gate can be invoked automatically. `tests/` is
 * deliberately absent — that is where these levers are legitimately set.
 */
const SCAN_ROOTS = ['.github', 'scripts', 'deploy', 'infra'];
const SCAN_FILES = ['package.json', 'Dockerfile', 'docker-compose.yml'];
const GITHUB_DIR = path.join(ROOT, '.github');

/** Levers that would disarm the audit gate if set outside a test. */
const TEST_ONLY_ENV = ['EXEMPT_OVERRIDE', 'AUDIT_CANARY_OVERRIDE'] as const;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (/\.(ya?ml|sh|mjs|js|json|ts)$/.test(entry.name) || /^Dockerfile/.test(entry.name)) out.push(p);
    }
    return out;
}

const files = [
    ...SCAN_ROOTS.flatMap((r) => (fs.existsSync(path.join(ROOT, r)) ? walk(path.join(ROOT, r)) : [])),
    ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
    // The gate itself names the variables (it reads them); excluded so the
    // scan does not flag the implementation as a misuse.
].filter((f) => !f.endsWith('scripts/audit-exemptions.mjs'));

describe('the audit gate cannot be disarmed from CI', () => {
    it('finds the files it is meant to be scanning, across every root', () => {
        // Anti-vacuity: an empty file list would make every assertion below
        // pass while checking nothing — which is precisely the bug class
        // this guard was written in response to. Asserted PER ROOT, because
        // a single total would stay healthy while one root silently
        // contributed nothing (a renamed directory, a changed extension).
        expect(files.length).toBeGreaterThan(20);
        expect(files.some((f) => f.endsWith('ci.yml'))).toBe(true);
        expect(files.some((f) => f.endsWith('package.json'))).toBe(true);
        for (const root of ['.github', 'scripts']) {
            expect(files.filter((f) => f.includes(`/${root}/`)).length).toBeGreaterThan(0);
        }
    });

    it.each(TEST_ONLY_ENV)('%s appears in no automated invocation path', (name) => {
        const offenders = files
            .filter((f) => fs.readFileSync(f, 'utf8').includes(name))
            .map((f) => path.relative(ROOT, f));
        expect(offenders).toEqual([]);
    });

    it('the security job still hands the script a captured report', () => {
        // The single-audit wiring is the thing that closes the
        // short-circuit and the two-audit flap window. If someone restores
        // `npm audit ... || node scripts/audit-exemptions.mjs`, every check
        // in that script moves back behind a branch a blind registry never
        // takes.
        const ci = fs.readFileSync(path.join(GITHUB_DIR, 'workflows/ci.yml'), 'utf8');
        expect(ci).toContain('AUDIT_JSON_OVERRIDE="$RUNNER_TEMP/audit.json" node scripts/audit-exemptions.mjs');

        // Match COMMANDS, not prose. The step's own comment quotes the old
        // `||` form to explain why it was removed, and a naive scan of the
        // raw file flags that explanation as the defect — which would make
        // the guard unfixable without deleting the documentation that gives
        // it its reason. (Caught by this guard failing on its own first run.)
        const commands = ci
            .split('\n')
            .filter((line) => !/^\s*#/.test(line))
            .join('\n');
        expect(commands).not.toMatch(/npm audit[^\n]*\|\|\s*node scripts\/audit-exemptions\.mjs/);
    });
});
