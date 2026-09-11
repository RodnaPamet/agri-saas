/**
 * An `overrides` entry for a DIRECT dependency must reference it, not repeat it.
 *
 * ## What this cost
 *
 * `sharp` was both a direct dependency (`^0.35.3`) and a literal override of
 * the same range. npm accepts that until something tries to move one of them:
 * bump the dependency and the override still pins the old range, which is a
 * conflict. Dependabot hit it and gave up —
 *
 *     Override for sharp@0.35.4 conflicts with direct dependency
 *
 * — and because that aborts the whole updater run, it did not just skip sharp.
 * **Every** dependency update stopped, including security ones. The failure was
 * only visible in a workflow nobody watches, which is the same class of silent
 * gap the CI-failure notifier exists for.
 *
 * ## The fix, which this repo already knew
 *
 * `"$sharp"` tells npm "whatever the direct dependency resolves to", so the two
 * can never diverge. The file already uses that idiom for `postcss`, `react`,
 * `react-dom`, `nodemailer` and `next`. `sharp` was the one that spelled the
 * range out instead.
 *
 * A nested override (`{"pkg": {"dep": "..."}}`) is a different thing — it
 * constrains a package's OWN dependencies, not the package, so it is untouched
 * by this rule.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, unknown>;
};

const direct: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

/**
 * Overrides that name a direct dependency and pin a literal range.
 *
 * Takes the map as a parameter so a control can run THIS function — not a
 * reimplementation of it — over the real overrides with one entry perturbed.
 * Without that, `conflicts()` could `return []` wholesale and every
 * assertion here still passed: measured, it SURVIVED selector-teeth.
 */
function conflicts(overrides: Record<string, unknown> = pkg.overrides ?? {}): string[] {
    const out: string[] = [];
    for (const [name, value] of Object.entries(overrides)) {
        if (typeof value !== 'string') continue;   // nested — constrains the package's own deps
        if (value.startsWith('$')) continue;       // references the direct dep, which is the fix
        if (direct[name]) out.push(`${name}: direct=${direct[name]} override=${value}`);
    }
    return out;
}

describe('overrides do not fight the direct dependencies', () => {
    it('finds the overrides it is meant to be checking', () => {
        // Anti-vacuity: an empty or restructured overrides block would make the
        // real assertion below pass while checking nothing.
        expect(Object.keys(pkg.overrides ?? {}).length).toBeGreaterThan(5);
    });

    it('...and the override -> direct-dependency JOIN resolves', () => {
        // The control above proves the overrides block is non-empty. It does
        // NOT prove `direct` is populated, and conflicts() selects by looking
        // each override name up in `direct` — so emptying that map makes
        // conflicts() return [] for every input and the assertion below passes
        // while reading nothing. Measured: `const direct = {}` left all three
        // tests green.
        //
        // The OVERLAP is the observable only the healthy path produces: it is
        // computed from the same `direct` map the real assertion selects
        // through, on the real package.json, so it cannot be satisfied by a
        // dead join.
        const overlap = Object.keys(pkg.overrides ?? {}).filter((n) => direct[n]);
        expect(overlap.length).toBeGreaterThan(0);
        expect(overlap).toContain('sharp');
    });

    it('...and conflicts() itself can select on the real overrides', () => {
        // The control above proves the JOIN resolves. It does not prove
        // conflicts() selects through it — `return []` survived it.
        //
        // A healthy tree has zero conflicts, which is exactly what the
        // assertion below asserts, so counting the live result can never
        // prove selection. Instead, run the real function over the REAL
        // overrides map with the one entry we know is a direct dependency
        // flipped to a literal range. That is the production population with
        // a single realistic perturbation — not a hand-made fixture that the
        // live path never sees.
        const perturbed = { ...(pkg.overrides ?? {}), sharp: '0.34.0' };
        expect(conflicts(perturbed)).toEqual([
            `sharp: direct=${direct.sharp} override=0.34.0`,
        ]);
    });

    it('every override of a direct dependency uses $name, not a literal range', () => {
        // A literal range here does not fail at install time — it fails later,
        // in Dependabot, by aborting the entire updater run.
        expect(conflicts()).toEqual([]);
    });

    it('sharp specifically references its direct dependency', () => {
        // Named because it is the one that broke, and a regression would most
        // likely arrive as someone "pinning" it again during an incident.
        expect(pkg.overrides?.sharp).toBe('$sharp');
        expect(pkg.dependencies?.sharp).toBeDefined();
    });
});
