/**
 * Guard: the `@typescript-eslint` family is version-coherent in the lockfile,
 * and the meta-package stays a DECLARED dependency (#1337).
 *
 * ## The two things this pins, and why each needs pinning
 *
 * **1. The meta is declared.** It was not, and that was the whole of #1337:
 * the dedicated Dependabot group added in #1155 never produced a single pull
 * request, because its first pattern — the bare name `typescript-eslint` —
 * matched nothing Dependabot could act on. The meta reached the tree only
 * through `eslint-config-next`, held in place by an `overrides` entry, and
 * **Dependabot does not manage `overrides`**. So the family could not move as
 * one unit however the group was ordered: the only member Dependabot could see
 * was `@typescript-eslint/eslint-plugin`, and the meta it has to stay in
 * lockstep with was invisible.
 *
 * The config guard (`dependabot-typescript-eslint-group`) was green throughout
 * and correctly so — it grades the config's shape, and the shape was right.
 * What no test could see was that the group had no subject.
 *
 * **2. The family is coherent.** The plugin pins its siblings EXACTLY and
 * peers `@typescript-eslint/parser` at the same minor. A skew strands the
 * parser on an older line and breaks the plugin's peer — which is what #1308
 * was. This assertion would not have caught that sooner than the install did,
 * so its value is as a statement of the invariant rather than as an earlier
 * alarm. It is in the same class as `lockfile-libc-preserved`: a property OF
 * the lockfile, cheap to check, and the kind of thing a hand-patch breaks.
 *
 * ## The override must be `$name`, and that is not cosmetic
 *
 * Hoisting the meta to a direct devDependency makes the old literal override
 * (`^8.70.0`) ILLEGAL. Measured:
 *
 *     npm error code EOVERRIDE
 *     npm error Override for typescript-eslint@^8.71.1 conflicts with direct dependency
 *
 * So the entry became `"typescript-eslint": "$typescript-eslint"` — the form
 * `tests/guards/overrides-no-direct-dep-conflict.test.ts` already requires of
 * any override naming a direct dependency, after a literal range aborted an
 * entire Dependabot run on `sharp`. That guard covers the form; this one
 * covers the declaration it depends on.
 *
 * The pairing is worth stating plainly because the obvious alternative is a
 * trap: keeping the literal override and hoisting anyway means the next
 * Dependabot bump of the devDependency — the very thing #1337 exists to enable
 * — fails the install with EOVERRIDE, since Dependabot would not touch the
 * override. The fix would have broken on first use.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const META = 'typescript-eslint';
const SCOPE = '@typescript-eslint/';

interface Manifest {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, unknown>;
}
interface Lock {
    packages: Record<string, { version?: string } | undefined>;
}

describe('the @typescript-eslint family (#1337)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Manifest;
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as Lock;

    /** Every lockfile entry in the family, by package name. */
    const family = new Map<string, Set<string>>();
    for (const [path, entry] of Object.entries(lock.packages)) {
        if (!entry?.version) continue;
        const name = path.split('node_modules/').pop() ?? '';
        if (name === META || name.startsWith(SCOPE)) {
            if (!family.has(name)) family.set(name, new Set());
            family.get(name)!.add(entry.version);
        }
    }

    it('the family is present at all — the denominator', () => {
        // Without this, "every version agrees" is satisfied by finding none,
        // which is exactly what a renamed scope or a changed lockfile shape
        // would produce.
        expect(family.size).toBeGreaterThanOrEqual(8);
        expect([...family.keys()]).toContain(META);
        expect([...family.keys()]).toContain('@typescript-eslint/parser');
        expect([...family.keys()]).toContain('@typescript-eslint/eslint-plugin');
    });

    it('Dependabot can SEE the meta-package — it is a declared dependency', () => {
        const declared =
            pkg.dependencies?.[META] ?? pkg.devDependencies?.[META] ?? null;

        if (!declared) {
            throw new Error(
                `\`${META}\` is not declared in dependencies or devDependencies.\n\n` +
                    `The Dependabot group in .github/dependabot.yml matches it by bare ` +
                    `name, and Dependabot does NOT manage \`overrides\` — so an undeclared ` +
                    `meta means the group's first pattern matches nothing it can act on, ` +
                    `and the family cannot move as one unit however the group is ordered. ` +
                    `That is #1337: the group produced zero PRs in the month after it was ` +
                    `added, while the plugin shipped three releases.\n\n` +
                    `Declare it in devDependencies, and make sure the \`overrides\` entry ` +
                    `uses \`$${META}\` — a literal range there is rejected outright:\n` +
                    `    npm error code EOVERRIDE\n` +
                    `    npm error Override for ${META}@… conflicts with direct dependency`,
            );
        }
    });

    it('every member resolves to ONE version, and they all agree', () => {
        const multi = [...family.entries()].filter(([, v]) => v.size > 1);
        const versions = new Set([...family.values()].flatMap((v) => [...v]));

        if (multi.length || versions.size > 1) {
            const detail = [...family.entries()]
                .map(([n, v]) => `    ${n.padEnd(42)} ${[...v].sort().join(', ')}`)
                .join('\n');
            throw new Error(
                `The @typescript-eslint family is not version-coherent:\n\n${detail}\n\n` +
                    `The plugin pins its siblings EXACTLY and peers the parser at the same ` +
                    `minor, so a skew strands the parser on an older line and breaks the ` +
                    `plugin's peer (#1308). Resolve with npm 11 — the bundled 10.9.8 ` +
                    `strips the lockfile's \`libc\` entries that ` +
                    `lockfile-libc-preserved exists to protect.`,
            );
        }
    });

    it('the override names the direct dependency rather than a literal range', () => {
        // `overrides-no-direct-dep-conflict` enforces this as a general rule;
        // asserted here too because this specific pairing is the fix, and the
        // failure mode if it regresses is not a lint warning but a refused
        // install on the next Dependabot bump.
        const override = pkg.overrides?.[META];
        if (override !== undefined) {
            expect(typeof override).toBe('string');
            expect(override).toBe(`$${META}`);
        }
    });
});
