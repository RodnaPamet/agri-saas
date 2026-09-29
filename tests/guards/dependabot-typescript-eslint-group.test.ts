import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * The typescript-eslint family must be grouped, and the group must stay ABOVE
 * `dev-dependencies`.
 *
 * `typescript-eslint` is a meta-package pinning its siblings to EXACT versions
 * (at 8.71.0: parser 8.71.0, eslint-plugin 8.71.0, utils 8.71.0,
 * typescript-estree 8.71.0), while `@typescript-eslint/eslint-plugin` declares
 * a PEER on `parser@^<its own version>`. So bumping one member without the
 * meta-package is unresolvable by construction, not merely untidy:
 *
 *     ERESOLVE could not resolve
 *     peer @typescript-eslint/parser@"^8.70.1"
 *       from @typescript-eslint/eslint-plugin@8.70.1
 *
 * Measured 2026-09-29 (#1150, reproduced into #1152 by `@dependabot recreate`,
 * which is how we know it is structural and not a stale branch): `npm ci`
 * failed, so ALL 15 jobs went red on ONE broken install and 15 unrelated dev
 * updates were held hostage by it.
 *
 * WHY THIS IS A GUARD AND NOT JUST A COMMENT. Dependabot assigns a dependency
 * to the FIRST group whose patterns match. `dev-dependencies` selects by
 * `dependency-type: development` with no patterns, so it also matches this
 * family — meaning if the dedicated group is moved BELOW it, or its patterns
 * stop matching, the old behaviour returns silently. There is no error
 * anywhere: the config stays valid, dependabot keeps running, and the next
 * plugin release reddens a batch again. That is precisely the class of
 * regression a comment cannot hold.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const CONFIG = path.join(REPO_ROOT, '.github/dependabot.yml');

const raw = () => fs.readFileSync(CONFIG, 'utf8');

interface Group {
    patterns?: string[];
    'dependency-type'?: string;
    'update-types'?: string[];
}
interface Update {
    'package-ecosystem': string;
    groups?: Record<string, Group>;
}

/** The npm ecosystem's groups, in file order. */
function npmGroups(): Record<string, Group> {
    const doc = yaml.load(raw()) as { updates: Update[] };
    const npm = doc.updates.find((u) => u['package-ecosystem'] === 'npm');
    if (!npm?.groups) throw new Error('no npm ecosystem with groups');
    return npm.groups;
}

describe('the extractor this file depends on', () => {
    // An empty selection passes every assertion below that takes one, so the
    // extractor is proved before anything is asserted with it.
    it('finds the npm groups, including the pre-existing ones', () => {
        const g = npmGroups();
        expect(Object.keys(g).length).toBeGreaterThan(2);
        // Controls: groups that existed before this guard did.
        expect(g).toHaveProperty('production');
        expect(g).toHaveProperty('dev-dependencies');
    });
});

describe('dependabot groups the typescript-eslint family as one unit', () => {
    it('a dedicated group exists', () => {
        expect(npmGroups()).toHaveProperty('typescript-eslint');
    });

    it('it matches BOTH the meta-package and the scoped members', () => {
        const patterns = npmGroups()['typescript-eslint'].patterns ?? [];
        // The bare name and the scope are different strings: `@typescript-eslint/*`
        // does NOT match the meta-package `typescript-eslint`, which is the exact
        // omission that caused the incident.
        expect(patterns).toContain('typescript-eslint');
        expect(patterns).toContain('@typescript-eslint/*');
    });

    it('the group sits ABOVE dev-dependencies — first match wins', () => {
        // Asserted twice, on purpose: once on parsed key order and once on raw
        // byte offsets. The parsed check reads what dependabot reads; the text
        // check cannot be fooled by any object-key reordering in the loader.
        const keys = Object.keys(npmGroups());
        expect(keys.indexOf('typescript-eslint')).toBeGreaterThan(-1);
        expect(keys.indexOf('dev-dependencies')).toBeGreaterThan(-1);
        expect(keys.indexOf('typescript-eslint')).toBeLessThan(
            keys.indexOf('dev-dependencies'),
        );

        const text = raw();
        const tsPos = text.indexOf('\n      typescript-eslint:');
        const devPos = text.indexOf('\n      dev-dependencies:');
        expect(tsPos).toBeGreaterThan(-1);
        expect(devPos).toBeGreaterThan(-1);
        expect(tsPos).toBeLessThan(devPos);
    });

    it('dev-dependencies still selects by type, which is why order is load-bearing', () => {
        // If this ever gains explicit `patterns`, the ordering argument above
        // changes and this guard's reasoning needs revisiting rather than
        // silently continuing to pass.
        const dev = npmGroups()['dev-dependencies'];
        expect(dev['dependency-type']).toBe('development');
        expect(dev.patterns).toBeUndefined();
    });

    it('the reason is written down where the next editor will look', () => {
        const text = raw();
        expect(text).toMatch(/ORDER MATTERS/);
        expect(text).toMatch(/ERESOLVE/);
    });
});
