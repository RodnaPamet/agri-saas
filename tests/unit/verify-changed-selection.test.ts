/**
 * `verify:changed` runs the test you just changed — #2330.
 *
 * ## The gap
 *
 * `^tests/` in `verify-changed.rules.json` maps to `tests/guards` and
 * `tests/guardrails` only. That is correct as far as it goes — a change under
 * `tests/` puts META-guards in scope, ones that grade the SHAPE of test code.
 * But it was the only thing the rule did, so the changed test was never run.
 *
 * Measured on the branch that filed this: five changed files including a brand
 * new `tests/unit/backup-exists-probe.test.ts`, derived population
 * `tests/guards` + `tests/guardrails`, and zero occurrences of the new test's
 * name in the run's output.
 *
 * ## Why the two helpers are tested TOGETHER
 *
 * Adding the changed test is only safe because the dedupe collapses it into a
 * directory that already covers it. Tested apart, each looks fine and the
 * interesting property — that a `tests/guards` change costs nothing while a
 * `tests/unit` change gains a path — belongs to the pair.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * The script is `.mjs`, and jest here cannot `require` an ES module — the
 * existing `verify-changed-rules-resolve` guard sidesteps this by reading the
 * rules JSON and never importing the script at all.
 *
 * Re-implementing the two functions in this file would test nothing: a copy
 * agrees with itself. So they are called for real, in a Node child that CAN
 * import ESM, and the answer comes back as JSON. Same pattern as the shell
 * probes' tests, for the same reason — exercise the shipped artefact.
 */
function callScript(fn: 'changedTestFiles' | 'dedupeAgainstDirectories', arg: string[]): string[] {
    const src = `
import { ${fn} } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/verify-changed.mjs'))};
process.stdout.write(JSON.stringify(${fn}(${JSON.stringify(arg)})));
`;
    const out = execFileSync('node', ['--input-type=module', '-e', src], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
    });
    return JSON.parse(out);
}

const changedTestFiles = (files: string[]) => callScript('changedTestFiles', files);
const dedupeAgainstDirectories = (paths: string[]) => callScript('dedupeAgainstDirectories', paths);

/** What the `^tests/` rule contributes, so the pair is exercised as it runs. */
const META_DIRS = ['tests/guards', 'tests/guardrails'];

const populationFor = (files: string[], ruleDirs: string[] = META_DIRS) =>
    dedupeAgainstDirectories([...ruleDirs, ...changedTestFiles(files)]).sort();

describe('changedTestFiles', () => {
    it('finds test files anywhere under tests/', () => {
        expect(
            changedTestFiles([
                'tests/unit/a.test.ts',
                'tests/guards/b.test.ts',
                'tests/rendered/c.test.tsx',
                'tests/integration/deep/nested/d.test.ts',
            ]),
        ).toEqual([
            'tests/unit/a.test.ts',
            'tests/guards/b.test.ts',
            'tests/rendered/c.test.tsx',
            'tests/integration/deep/nested/d.test.ts',
        ]);
    });

    it.each([
        ['src/lib/a.test.ts', 'a test outside tests/'],
        ['tests/helpers/catalogue.ts', 'a helper, not a test'],
        ['tests/unit/fixtures/data.json', 'a fixture'],
        ['tests/README.md', 'prose'],
        ['tests/unit/a.test.ts.snap', 'a snapshot'],
        ['tests/a.test.ts.bak', 'a backup file'],
    ])('excludes %s (%s)', (file) => {
        expect(changedTestFiles([file])).toEqual([]);
    });

    it('is empty for an empty diff rather than throwing', () => {
        expect(changedTestFiles([])).toEqual([]);
    });
});

describe('the pair: a changed test reaches the population only where it adds something', () => {
    it('ADDS a changed tests/unit test — the gap this closes', () => {
        // `tests/unit` is not among the directories `^tests/` selects, so
        // without this the test written for the change is not run.
        expect(populationFor(['tests/unit/backup-exists-probe.test.ts']))
            .toEqual(['tests/guardrails', 'tests/guards', 'tests/unit/backup-exists-probe.test.ts']);
    });

    it('COLLAPSES a changed tests/guards test into the directory already selected', () => {
        // Costs nothing: handing jest both the directory and a file inside it
        // overstates the population without widening it.
        expect(populationFor(['tests/guards/wif-workflows-declare-id-token.test.ts']))
            .toEqual(['tests/guardrails', 'tests/guards']);
    });

    it('adds one path per distinct uncovered test, and none for covered ones', () => {
        expect(
            populationFor([
                'tests/unit/a.test.ts',
                'tests/rendered/b.test.tsx',
                'tests/guards/c.test.ts',
                'tests/guardrails/d.test.ts',
            ]),
        ).toEqual([
            'tests/guardrails',
            'tests/guards',
            'tests/rendered/b.test.tsx',
            'tests/unit/a.test.ts',
        ]);
    });

    it('leaves the rule directories alone when no test changed', () => {
        expect(populationFor(['src/lib/thing.ts'])).toEqual(['tests/guardrails', 'tests/guards']);
    });
});

describe('dedupeAgainstDirectories', () => {
    it('treats .tsx as a file, not a directory', () => {
        // The original checked only `.ts`, so a `.tsx` path was classified as a
        // DIRECTORY and would have swallowed any path beneath it. Nothing lives
        // beneath a .tsx file, so it never bit — but it is wrong, and a rule
        // that is wrong for a reason nobody has hit yet is still wrong.
        expect(dedupeAgainstDirectories(['tests/rendered', 'tests/rendered/a.test.tsx']))
            .toEqual(['tests/rendered']);
    });

    it('does not drop a path that merely SHARES A PREFIX with a directory', () => {
        // `tests/unit-helpers` starts with `tests/unit` as a string but is not
        // inside it. The boundary is the slash, which is why the check appends
        // one rather than comparing raw prefixes.
        expect(dedupeAgainstDirectories(['tests/unit', 'tests/unit-helpers/a.test.ts']).sort())
            .toEqual(['tests/unit', 'tests/unit-helpers/a.test.ts']);
    });

    it('keeps a directory itself when it is the only entry', () => {
        expect(dedupeAgainstDirectories(['tests/guards'])).toEqual(['tests/guards']);
    });
});
