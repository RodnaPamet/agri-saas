/**
 * A shared test HELPER derives the roots that import it — #2531.
 *
 * ## The gap, measured
 *
 * `verify:changed` has one rule for everything under `tests/`:
 *
 *   {"when": "^tests\\/", "run": ["tests/guards", "tests/guardrails"]}
 *
 * That is right as far as it goes — a change under `tests/` puts the
 * META-guards in scope, the ones that grade the SHAPE of test code — and #2330
 * already added the other half it was missing, running the changed TEST file
 * itself. What neither covers is a changed file under `tests/` that is **not a
 * test**: a shared helper, whose whole purpose is to be imported by suites
 * living somewhere else.
 *
 * Measured on this repo (the numbers this guard re-derives on every run):
 *
 *   tests/helpers/blank-non-code.ts     265 importers across 5 roots
 *   tests/helpers/make-context.ts       212 importers — 128 unit, 83 integration
 *   tests/integration/db-helper.ts      197 importers — 193 integration
 *   tests/helpers/collect-files.ts      153 importers across 6 roots
 *   tests/helpers/db.ts                  57 importers —  53 integration
 *
 * So editing `make-context.ts` — the helper CLAUDE.md names as the canonical
 * way to build a `RequestContext`, and which is read by more suites than any
 * other file in the repo bar one — derived `tests/guards` + `tests/guardrails`
 * and ran **none** of its 211 importing suites.
 *
 * I hit it on #2545: I replaced two steps of `db-helper.ts` with a
 * `refuse(): never` and exported `resolveDbUrlFrom` for testing, ran a
 * hand-picked subset, and the derived population contained zero of the 193
 * integration suites that import the file I had just rewritten. The tool
 * reported on the change without running anything that consumes it, which is
 * the failure `verify:changed` exists to remove — one level up, and in its own
 * mapping.
 *
 * ## Why this guard rather than three more lines of JSON
 *
 * The rules are DATA and the data can go stale. A rule listing
 * `["tests/integration"]` for `tests/integration/db-helper.ts` is correct
 * today and says nothing about the next helper somebody adds beside it, or
 * about a helper that starts being imported from a root the rule never named.
 * Both of those changes are silent: the rule still matches, still names a real
 * path, and still contributes a population that is missing a root.
 *
 * So this guard DERIVES the requirement — who actually imports each helper —
 * and checks the rules against it, the same move
 * `pg-pool-size-fits-pgbouncer` makes rather than trusting a comment.
 * `verify-changed-rules-resolve` is the other axis and is not this one: it
 * asks whether a rule's targets EXIST. A rule can name nothing but live paths
 * and still omit the root that matters.
 *
 * ## Two traps this encodes, both of which produce a silent pass
 *
 * **`tests/e2e` must never be a `run` entry.** All 65 files there are
 * `*.spec.ts`, and jest's `node` project matches `**'/'*.test.ts` only — so
 * the directory is Playwright's and jest collects nothing from it. A `run`
 * entry naming it would pass `verify-changed-rules-resolve` (the directory
 * exists) and contribute zero tests. This guard therefore requires only roots
 * it has PROVED are jest-collectible, by finding a `*.test.ts` inside them.
 *
 * **A helper that imports a helper.** `i18n-key-resolver.ts` is imported by
 * another file under `tests/helpers`, not by a test, so a direct-importer
 * count scores it at zero reach. The closure below is transitive for that
 * reason: an edit to such a file reaches every suite that imports its
 * importer.
 *
 * ## The second axis: jest.config.js is an edge the import graph cannot see
 *
 * Six files under `tests/` are reached by CONFIG rather than by `import`, and
 * an import-derived reach scores every one of them at **zero** while they are
 * the files with the widest blast radius in the repo:
 *
 *   tests/setup/globalSetup.ts          globalSetup      — the whole run
 *   tests/setup/teardown.ts             globalTeardown   — the whole run
 *   tests/reporters/denominator-summary.cjs  reporters   — the whole run
 *   tests/mocks/env.ts                  moduleNameMapper `^@/env$`, BOTH projects
 *   tests/setup/jsdom-shims.ts          setupFilesAfterEnv, node project
 *   tests/setup/disconnect-after-suite.ts  setupFilesAfterEnv, node project
 *   tests/rendered/setup.ts             setupFilesAfterEnv, jsdom project
 *
 * `tests/rendered/setup.ts` is the one CLAUDE.md names as the reason every
 * rendered test runs as a PHONE — change its `matchMedia` stub and the branch
 * 271 suites execute changes, with nothing in the derivation saying so.
 *
 * So the requirement for these is read from `jest.config.js` itself, which
 * this guard can `require` because it is CJS and so is jest's `node` project.
 * Reading the real object rather than grepping the file means a renamed key or
 * a moved setup file cannot leave the requirement quietly behind.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectTrackedFiles, REPO_ROOT } from '../helpers/collect-files';

type Rule = { when: string; run: string[]; why: string; lintOnly?: boolean };
const RULES = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/verify-changed.rules.json'), 'utf8'),
) as { pathRules: Rule[] };

/**
 * `.spec.` as well as `.test.`, and that is not cosmetic: all 65 files under
 * `tests/e2e` are `*.spec.ts`, so a `.test.`-only pattern classifies every
 * Playwright spec as a shared HELPER and inflates the population this guard
 * floors itself against. Measured while writing this — 120 "helpers" where
 * there are 55.
 */
const IS_TEST = /\.(test|spec)\.tsx?$/;
/** jest collects `*.test.ts(x)` only — a `*.spec.ts` is Playwright's. */
const IS_JEST_TEST = /\.test\.tsx?$/;

/** Repo-relative, POSIX-separated, which is what the rules' regexes match. */
function rel(abs: string): string {
    return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

const TESTS_TREE = collectTrackedFiles({
    roots: ['tests'],
    extensions: ['.ts', '.tsx'],
    floor: 900,
}).map(rel);

const TEST_FILES = TESTS_TREE.filter((f) => IS_JEST_TEST.test(f));
const HELPERS = TESTS_TREE.filter((f) => !IS_TEST.test(f));

/**
 * A root is the first two segments (`tests/integration`), and it counts only
 * if jest can collect from it — see the `tests/e2e` trap in the docblock.
 */
function rootOf(file: string): string {
    return file.split('/').slice(0, 2).join('/');
}
const JEST_COLLECTIBLE = new Set(TEST_FILES.map(rootOf));

/**
 * The files `jest.config.js` wires in, and which roots each one therefore
 * reaches. Required by the second axis in the docblock.
 *
 * `require`d rather than grepped: the keys are what jest reads, and a rename
 * (`setupFiles` → `setupFilesAfterEnv`, a project gaining a mapper entry)
 * would silently stop matching a regex while still changing what runs.
 */
const JEST_CONFIG = require('../../jest.config.js') as {
    globalSetup?: string;
    globalTeardown?: string;
    reporters?: unknown[];
    projects?: {
        displayName?: string;
        setupFilesAfterEnv?: string[];
        moduleNameMapper?: Record<string, string>;
    }[];
};

/** `<rootDir>/tests/x.ts` → `tests/x.ts`; anything else → null. */
function underTests(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const stripped = value.replace(/^<rootDir>\//, '');
    return stripped.startsWith('tests/') ? stripped : null;
}

const ALL_COLLECTIBLE = [...JEST_COLLECTIBLE].sort();

/** repo-relative path → the roots an edit to it can change the behaviour of. */
const CONFIG_WIRED = new Map<string, string[]>();
function wire(value: unknown, roots: string[]): void {
    const file = underTests(value);
    if (!file) return;
    CONFIG_WIRED.set(file, [...new Set([...(CONFIG_WIRED.get(file) ?? []), ...roots])].sort());
}
// Top-level wiring runs for every project, so its reach is the whole run.
wire(JEST_CONFIG.globalSetup, ALL_COLLECTIBLE);
wire(JEST_CONFIG.globalTeardown, ALL_COLLECTIBLE);
for (const r of JEST_CONFIG.reporters ?? []) wire(Array.isArray(r) ? r[0] : r, ALL_COLLECTIBLE);
for (const project of JEST_CONFIG.projects ?? []) {
    // The `node` project's testMatch is repo-wide, so its setup reaches every
    // collectible root; `jsdom` collects only tests/rendered (plus
    // src/**/__tests__, which is not a root under tests/).
    const reach = project.displayName === 'jsdom' ? ['tests/rendered'] : ALL_COLLECTIBLE;
    for (const f of project.setupFilesAfterEnv ?? []) wire(f, reach);
    for (const target of Object.values(project.moduleNameMapper ?? {})) wire(target, reach);
}

/**
 * `from './x'` / `require('./x')` → the repo-relative stem it resolves to.
 *
 * Only RELATIVE specifiers, deliberately. `@/…` resolves into `src/`, and a
 * bare specifier is a package; neither can name a file under `tests/`, so
 * widening the pattern would add false edges rather than coverage.
 */
const SPEC = /(?:from|require\s*\()\s*['"](\.[^'"]*)['"]/g;

/** stem (no extension) → the files that import it. */
const importersOf = new Map<string, string[]>();
for (const f of TESTS_TREE) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    for (const m of src.matchAll(SPEC)) {
        const stem = path
            .normalize(path.join(path.dirname(f), m[1]))
            .split(path.sep)
            .join('/')
            .replace(/\/index$/, '');
        const list = importersOf.get(stem) ?? [];
        if (!list.includes(f)) list.push(f);
        importersOf.set(stem, list);
    }
}

function stemOf(file: string): string {
    return file.replace(/\.tsx?$/, '');
}

/** Every TEST file that reaches `helper`, following helper→helper edges. */
function reachingTests(helper: string): string[] {
    const seen = new Set<string>([helper]);
    const queue = [helper];
    const tests: string[] = [];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const importer of importersOf.get(stemOf(current)) ?? []) {
            if (seen.has(importer)) continue;
            seen.add(importer);
            if (IS_TEST.test(importer)) tests.push(importer);
            else queue.push(importer);
        }
    }
    return tests;
}

/**
 * What `verify:changed` would run for this path, from the path rules alone.
 *
 * Content rules are deliberately excluded: they fire on the ADDED LINES of a
 * diff, which this guard does not have and must not guess at. A helper's
 * importers have to be reachable from the path, because that is the only axis
 * available when all that is known is which file was touched.
 */
function derivedFor(file: string, rules: Rule[] = RULES.pathRules): string[] {
    return [...new Set(rules.filter((r) => new RegExp(r.when).test(file)).flatMap((r) => r.run))];
}

/** `tests/integration` is covered by `tests/integration` or by `tests`. */
function covers(derived: string[], root: string): boolean {
    return derived.some((d) => d === root || root.startsWith(`${d}/`));
}

/** Helpers whose importing roots the rules do not reach. */
function gaps(rules?: Rule[]): { helper: string; missing: string[]; suites: number }[] {
    const out: { helper: string; missing: string[]; suites: number }[] = [];
    for (const helper of HELPERS) {
        const tests = reachingTests(helper);
        const wired = CONFIG_WIRED.get(helper) ?? [];
        if (tests.length === 0 && wired.length === 0) continue;
        const required = [...new Set([...tests.map(rootOf), ...wired])]
            .filter((r) => JEST_COLLECTIBLE.has(r))
            .sort();
        const derived = derivedFor(helper, rules);
        const missing = required.filter((r) => !covers(derived, r));
        if (missing.length > 0) out.push({ helper, missing, suites: tests.length });
    }
    return out.sort((a, b) => b.suites - a.suites);
}

describe('verify:changed covers shared test helpers (#2531)', () => {
    it('ranges over a real helper population with real importers', () => {
        const withImporters = HELPERS.filter((h) => reachingTests(h).length > 0);
        const reach = withImporters.map((h) => reachingTests(h).length);
        console.log(
            `[verify-changed-helpers] ${HELPERS.length} non-test file(s) under tests/, `
                + `${withImporters.length} imported by at least one suite`,
        );
        console.log(
            `[verify-changed-helpers] widest reach ${Math.max(...reach)} suite(s); `
                + `${TEST_FILES.length} test file(s) scanned across `
                + `${[...JEST_COLLECTIBLE].sort().join(', ')}`,
        );
        // Floors, because every assertion below ranges over these two sets and
        // an import pattern that stopped matching would empty them silently.
        expect(HELPERS.length).toBeGreaterThanOrEqual(45);
        expect(withImporters.length).toBeGreaterThanOrEqual(30);
        expect(Math.max(...reach)).toBeGreaterThanOrEqual(150);
    });

    it('reads the config-wired files out of jest.config.js, not out of a list', () => {
        const rows = [...CONFIG_WIRED.entries()].sort();
        console.log(
            `[verify-changed-helpers] ${rows.length} file(s) wired by jest.config.js, `
                + `invisible to the import graph`,
        );
        for (const [file, roots] of rows) {
            console.log(`[verify-changed-helpers]   ${file} -> ${roots.join(', ')}`);
        }
        // The six in the docblock. A key rename in jest.config.js would empty
        // this map and every requirement derived from it, silently.
        expect(rows.length).toBeGreaterThanOrEqual(6);
        expect(CONFIG_WIRED.get('tests/mocks/env.ts')).toEqual(
            expect.arrayContaining(['tests/unit', 'tests/integration']),
        );
        expect(CONFIG_WIRED.get('tests/rendered/setup.ts')).toEqual(['tests/rendered']);
    });

    it('never requires a root jest cannot collect from — tests/e2e is Playwright', () => {
        // The trap in the docblock: 65 `*.spec.ts` files, zero collectible by
        // jest's `node` project, and a directory that exists. Requiring it
        // would make this guard demand a rule that contributes no tests.
        expect([...JEST_COLLECTIBLE]).not.toContain('tests/e2e');
        const e2eHelpers = HELPERS.filter((h) => h.startsWith('tests/e2e/'));
        expect(e2eHelpers.length).toBeGreaterThan(0);
        for (const h of e2eHelpers) {
            const required = [...new Set(reachingTests(h).map(rootOf))].filter((r) =>
                JEST_COLLECTIBLE.has(r),
            );
            expect(required).not.toContain('tests/e2e');
        }
    });

    it('CAN report a gap — the rules without the helper rules leave one', () => {
        // A positive control, and not a synthetic one: it removes the real
        // rules this issue adds and asserts the detector names what it then
        // cannot reach. Without this, an import pattern that matched nothing
        // would satisfy the assertion below perfectly.
        const BARE_TESTS_RULE = '^tests\\/';
        const withoutHelperRules = RULES.pathRules.filter(
            (r) => !r.when.startsWith(BARE_TESTS_RULE) || r.when === BARE_TESTS_RULE,
        );
        const control = gaps(withoutHelperRules);
        expect(control.length).toBeGreaterThan(0);
        expect(control.map((g) => g.helper)).toContain('tests/integration/db-helper.ts');
    });

    it('every imported helper derives the roots that import it', () => {
        const found = gaps();
        expect(
            found.map((g) => `${g.helper} (${g.suites} suites) misses ${g.missing.join(', ')}`),
        ).toEqual([]);
    });
});
