/**
 * A test colocated under `src/**\/__tests__` is SELECTABLE by `verify:changed` —
 * #3059.
 *
 * ## The gap, measured
 *
 * jest collects these files twice over: the `node` project's `testMatch` is
 * `**\/*.test.ts`, which is repo-wide, and the `jsdom` project names
 * `<rootDir>/src/**\/__tests__/**\/*.test.{ts,tsx}` explicitly. They run, and
 * they pass.
 *
 * But every `run` target in `verify-changed.rules.json` was a `tests/*`
 * prefix — 17 of them, zero naming anything under `src/` — so no rule, path or
 * content, could put a colocated test in the derived population. Four real
 * suites were unreachable by the tool whose whole job is deciding what to run:
 *
 *   src/app-layer/utils/__tests__/cadence.test.ts
 *   src/components/ui/hooks/__tests__/use-threshold-load-more.test.tsx
 *   src/components/ui/hooks/__tests__/use-toast-with-undo.test.ts
 *   src/lib/hooks/__tests__/use-zod-form.test.tsx
 *
 * Measured 2026-11-14, before the rules this guard holds: editing
 * `utils/cadence.ts` derived `tests/integration` + `tests/unit`,
 * `use-toast-with-undo.ts` derived four `tests/*` roots, and
 * `use-zod-form.ts` derived `tests/unit` — none of them containing that
 * subject's own test.
 *
 * **`cadence.ts` is the sharp case**: nothing under `tests/` imports it, so the
 * colocated suite is its ONLY test, and the tool reported success having run
 * nothing that executes it. That is the failure #2018 exists to remove, for a
 * file whose test exists and passes.
 *
 * `use-toast-with-undo` is the one worth naming for consequence rather than
 * mechanism: CLAUDE.md makes that hook mandatory for every destructive flow in
 * the product, and its hardening test was in this unreachable class. The
 * `tests/rendered` suites it DID derive are the baseline and UI tests, which
 * are different files.
 *
 * ## Why a guard rather than three lines of JSON
 *
 * The rules are DATA and data goes stale. Three rules naming three directories
 * are correct today and say nothing about the fourth `__tests__` directory
 * somebody adds next to a new hook — and that addition is SILENT, because the
 * existing rules still match, still name live paths, and still contribute a
 * population missing the new suite.
 *
 * So this DERIVES the requirement from the filesystem: every `__tests__`
 * directory under `src/` must be named by some rule whose `when` matches a
 * file in its PARENT. A fifth one fails this until it is wired, which is the
 * same move its siblings `verify-changed-covers-shared-test-helpers` (#2531)
 * and `verify-changed-covers-app-layer` (#3057) make on their own axes.
 *
 * `verify-changed-rules-resolve` is a different axis: it asks whether a `run`
 * target EXISTS. A rule can name nothing but live paths and still leave a
 * whole class of test files unselectable — which is exactly what happened.
 *
 * ## The edge is parent → parent/__tests__, deliberately
 *
 * Not one broad `^src\/` rule, and that is a change of mind from the issue,
 * which guessed the broad form would cost "almost nothing". Measured: the
 * three directories are 4 suites / 40 tests and about 40 s above jest's ~10 s
 * fixed floor, because the hook tests run under jsdom. Only one of the three
 * is ever relevant to a given change, and a colocated test sits beside its
 * subject precisely BECAUSE it tests that subject — so the parent directory is
 * the exact edge, and a change elsewhere under `src/` pays nothing. Verified
 * in both directions: `src/lib/storage.ts` still derives `tests/unit` alone.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectTrackedFiles, REPO_ROOT } from '../helpers/collect-files';

type Rule = { when: string; run: string[]; why: string; lintOnly?: boolean };
const RULES = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/verify-changed.rules.json'), 'utf8'),
) as { pathRules: Rule[]; contentRules: Rule[] };

const IS_JEST_TEST = /\.test\.tsx?$/;

function rel(abs: string): string {
    return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

const SRC = collectTrackedFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
    // ~2,600 at the time of writing. A pattern that stopped matching would
    // empty the population and pass every assertion below.
    floor: 1500,
}).map(rel);

/** Every colocated test file, derived — never listed. */
const COLOCATED = SRC.filter((f) => IS_JEST_TEST.test(f) && f.includes('/__tests__/'));

/** `src/lib/hooks/__tests__/x.test.ts` → `src/lib/hooks/__tests__`. */
function testsDirOf(file: string): string {
    const i = file.lastIndexOf('/__tests__/');
    return `${file.slice(0, i)}/__tests__`;
}

/** The directory whose changes that colocated suite exists to cover. */
function subjectDirOf(testsDir: string): string {
    return testsDir.slice(0, testsDir.length - '/__tests__'.length);
}

const TESTS_DIRS = [...new Set(COLOCATED.map(testsDirOf))].sort();

/**
 * A representative SOURCE file in the subject directory, used to evaluate the
 * rules the way the script does — against a path, not against a directory.
 *
 * Derived rather than synthesised: a made-up filename could match a rule whose
 * `when` pins an extension or a name, and would then prove nothing about the
 * real files beside it.
 */
function subjectFilesOf(testsDir: string): string[] {
    const dir = subjectDirOf(testsDir);
    return SRC.filter(
        (f) =>
            f.startsWith(`${dir}/`)
            && !f.includes('/__tests__/')
            && !IS_JEST_TEST.test(f),
    );
}

/** What `verify:changed` would run for this path, from the PATH rules alone. */
function derivedFor(file: string, rules: Rule[] = RULES.pathRules): string[] {
    return [...new Set(rules.filter((r) => new RegExp(r.when).test(file)).flatMap((r) => r.run))];
}

/** Colocated directories no rule selects for a change beside them. */
function gaps(rules?: Rule[]): { testsDir: string; subject: string; suites: number }[] {
    const out: { testsDir: string; subject: string; suites: number }[] = [];
    for (const testsDir of TESTS_DIRS) {
        const subjects = subjectFilesOf(testsDir);
        if (subjects.length === 0) continue;
        // EVERY source file beside the tests must select them — one that does
        // not is a file whose edit runs none of its own suite.
        const uncovered = subjects.filter((f) => !derivedFor(f, rules).includes(testsDir));
        if (uncovered.length === 0) continue;
        out.push({
            testsDir,
            subject: uncovered[0],
            suites: COLOCATED.filter((c) => testsDirOf(c) === testsDir).length,
        });
    }
    return out;
}

describe('a colocated test is selectable by verify:changed (#3059)', () => {
    it('ranges over a real population of colocated tests', () => {
        console.log(
            `[colocated-selectable] ${COLOCATED.length} colocated test file(s) in `
                + `${TESTS_DIRS.length} __tests__ director(ies): ${TESTS_DIRS.join(' ')}; `
                + `${SRC.length} src file(s) scanned`,
        );
        // Floors: a derivation that stopped finding colocated tests would pass
        // every assertion below over an empty set.
        expect(COLOCATED.length).toBeGreaterThanOrEqual(4);
        expect(TESTS_DIRS.length).toBeGreaterThanOrEqual(3);
        // Each directory must contain a test AND have a subject beside it, or
        // the mapping this guard checks is vacuous for it.
        for (const dir of TESTS_DIRS) {
            expect(subjectFilesOf(dir).length).toBeGreaterThan(0);
        }
    });

    it('every colocated directory is selected by a change beside it', () => {
        expect(
            gaps().map(
                (g) => `${g.testsDir} (${g.suites} suite(s)) not derived by editing ${g.subject}`,
            ),
        ).toEqual([]);
    });

    it('the rules are load-bearing — the control', () => {
        // Without this, the assertion above passes whether or not any rule
        // supplies a colocated directory, so a later "tidy the rules" PR could
        // drop all three and stay green. Re-derives with every
        // `__tests__`-naming rule removed and requires the gap to REAPPEAR.
        const without = RULES.pathRules.filter(
            (r) => !r.run.some((t) => t.includes('__tests__')),
        );
        expect(without.length).toBeLessThan(RULES.pathRules.length);
        expect(gaps(without).length).toBe(TESTS_DIRS.length);
    });

    it('no rule target names a colocated path that has gone', () => {
        // The mirror of the derivation: a `run` entry naming a `__tests__`
        // directory that no longer holds a test contributes zero suites and
        // still reads as coverage. `verify-changed-rules-resolve` asserts the
        // path EXISTS; an empty directory passes that and nothing else.
        const named = [...RULES.pathRules, ...RULES.contentRules]
            .flatMap((r) => r.run)
            .filter((t) => t.includes('__tests__'));
        expect(named.length).toBeGreaterThan(0);
        for (const target of new Set(named)) {
            expect({
                target,
                holdsATest: COLOCATED.some((c) => testsDirOf(c) === target),
            }).toEqual({ target, holdsATest: true });
        }
    });

    it('jest really collects these, and the config says so', () => {
        // The premise the whole guard rests on. If the jsdom project stopped
        // naming `src/**/__tests__`, these suites would be collected by the
        // node project only — a different population, and the `.tsx` ones
        // would fail outright for want of a DOM.
        const config = require('../../jest.config.js') as {
            projects?: { displayName?: string; testMatch?: string[] }[];
        };
        const jsdom = (config.projects ?? []).find((p) => p.displayName === 'jsdom');
        expect(jsdom).toBeDefined();
        expect((jsdom as { testMatch?: string[] }).testMatch ?? []).toEqual(
            expect.arrayContaining([expect.stringContaining('src/**/__tests__')]),
        );
    });
});
