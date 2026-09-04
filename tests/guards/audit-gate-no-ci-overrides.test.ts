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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GITHUB_DIR = path.join(ROOT, '.github');

/** Levers that would disarm the audit gate if set outside a test. */
const TEST_ONLY_ENV = ['EXEMPT_OVERRIDE', 'AUDIT_CANARY_OVERRIDE'] as const;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (/\.(ya?ml|sh|mjs|js)$/.test(entry.name)) out.push(p);
    }
    return out;
}

const files = fs.existsSync(GITHUB_DIR) ? walk(GITHUB_DIR) : [];

describe('the audit gate cannot be disarmed from CI', () => {
    it('finds the workflow files it is meant to be scanning', () => {
        // Anti-vacuity: an empty file list would make every assertion below
        // pass while checking nothing — which is precisely the bug class
        // this guard was written in response to.
        expect(files.length).toBeGreaterThan(3);
        expect(files.some((f) => f.endsWith('ci.yml'))).toBe(true);
    });

    it.each(TEST_ONLY_ENV)('%s appears nowhere under .github/', (name) => {
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
