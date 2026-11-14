/**
 * An app-layer change derives the INTEGRATION suites that execute it — #3057.
 *
 * ## The gap, measured
 *
 * `verify:changed` is the tool CLAUDE.md tells you to trust instead of
 * hand-picking: *"Do not hand-pick a subset… several guards fire on the SHAPE
 * of a change rather than on the code it touches, so the correct subset is not
 * inferable from reading a diff."*
 *
 * Six rules in `verify-changed.rules.json` could put `tests/integration` in
 * the population, and every one of them was triggered by something other than
 * application source — a schema change, a shared helper, the harness's own
 * `db-helper.ts`, compiler config, one named `sanitize.ts`, or a PDF content
 * match. So `src/app-layer/**` mapped to `tests/integration` through nothing.
 *
 * Measured on main 2026-11-14, before the rule this guard holds:
 *
 *   src/app-layer/**                               442 files
 *     …reaching at least one integration suite     312
 *   tests/integration/*.test.ts                    278 suites
 *     …importing @/app-layer                       195
 *
 * Editing `usecases/channels.ts` derived `tests/unit` ALONE — 1,066 suites,
 * none of them the 278 written to exercise that layer against a real database.
 *
 * ## Why a guard rather than three lines of JSON
 *
 * The rules are DATA and data goes stale. A rule naming `tests/integration`
 * for `^src\/app-layer\/` is correct today and says nothing about the next
 * root those suites move to, or about an app-layer subtree that starts being
 * exercised from somewhere the rule never named. Both changes are SILENT: the
 * rule still matches, still names a live path, and still contributes a
 * population missing a root.
 *
 * So this DERIVES the requirement — who actually imports each app-layer file —
 * and checks the rules against it. Exactly the move its sibling
 * `verify-changed-covers-shared-test-helpers` (#2531) makes for helpers, which
 * is the same gap from the other side: that fix was scoped to the harness, and
 * the symmetric case — a change to the APPLICATION code — was left uncovered.
 *
 * `verify-changed-rules-resolve` is a third axis and is not this one: it asks
 * whether a rule's targets EXIST. A rule can name nothing but live paths and
 * still omit the root that matters.
 *
 * ## The edges are `@/…` as well as relative, and comments are blanked
 *
 * An integration suite reaches a usecase by its ALIAS — `@/app-layer/usecases/
 * channels` — so unlike the helper guard, which deliberately follows relative
 * specifiers only, this one must resolve `@/` into `src/`. The closure is
 * TRANSITIVE because a suite commonly imports a usecase that imports the
 * changed file; a one-hop count would score such a file at zero reach and fail
 * toward green.
 *
 * Comments are blanked first. This file's own docblock names
 * `@/app-layer/usecases/channels` in prose, and an unblanked scan would read
 * that as an edge — the bug being guarded against, committed by the guard.
 * Strings are KEPT, because an import specifier IS a string literal.
 *
 * ## A graph can be INFLATED rather than empty, and the floors miss that
 *
 * `Selector teeth` reported `stemOf()` as SURVIVED on this file's first green
 * run, and it was right. Gutting it to a constant does not empty the graph —
 * it collapses every import target onto ONE map key, so `importersOf` holds a
 * single entry containing every importing file and `reachingTests` answers
 * "nearly everything" for every input. Measured with the gut in place: 441 of
 * 441 app-layer files "reaching" an integration suite, and every root at 441.
 * Every assertion still passed, and the floors passed HARDER — reach went up,
 * not down.
 *
 * That is the shape to remember. A floor separates zero from nonzero and says
 * nothing about whether the derivation DISCRIMINATES, and a collapsed graph is
 * wrong in the direction that reads as more coverage. So the controls below
 * assert the graph tells modules apart: the key count (exactly 1 when
 * collapsed), the spread of reach across files (identical for every file when
 * collapsed), and a named pair whose reach is both non-empty and BOUNDED.
 *
 * ## What this asserts, and what it only REPORTS
 *
 * The assertion is scoped to `tests/integration`, which is #3057's property.
 * The derivation also finds app-layer files reaching `tests/rendered`,
 * `tests/guards`, `tests/guardrails`, `tests/pdf`, `tests/contracts` and
 * `tests/drills`, and the rules select none of those for a source change
 * either. That is a WIDER gap, it is printed on every run rather than left
 * implied, and closing it would make an app-layer change run most of the
 * repository — a cost decision rather than a defect fix. Tracked on #3058.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectTrackedFiles, REPO_ROOT } from '../helpers/collect-files';

type Rule = { when: string; run: string[]; why: string; lintOnly?: boolean };
const RULES = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/verify-changed.rules.json'), 'utf8'),
) as { pathRules: Rule[] };

/** jest collects `*.test.ts(x)`; a `*.spec.ts` under tests/e2e is Playwright's. */
const IS_JEST_TEST = /\.test\.tsx?$/;

function rel(abs: string): string {
    return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

const TREE = collectTrackedFiles({
    roots: ['src', 'tests'],
    extensions: ['.ts', '.tsx'],
    // ~2,900 at the time of writing. The floor separates "no file reaches an
    // integration suite" from "nothing was examined", which is the only way
    // this guard can fail toward green.
    floor: 2000,
}).map(rel);

const TEST_FILES = TREE.filter((f) => IS_JEST_TEST.test(f));
const APP_LAYER = TREE.filter((f) => f.startsWith('src/app-layer/') && !IS_JEST_TEST.test(f));

/** A root is the first two segments, and counts only if jest collects from it. */
function rootOf(file: string): string {
    return file.split('/').slice(0, 2).join('/');
}
const JEST_COLLECTIBLE = new Set(TEST_FILES.map(rootOf));

const stemOf = (f: string): string => f.replace(/\.tsx?$/, '').replace(/\/index$/, '');

/**
 * `from '@/x'`, `from './x'`, `require('./x')`, `import('@/x')` → the
 * repo-relative stem it resolves to. A bare specifier is a package and names
 * no file in this repo.
 */
const SPEC = /(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g;

/** stem → the files that import it. */
const importersOf = new Map<string, string[]>();
for (const f of TREE) {
    const code = blankNonCode(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
    for (const m of code.matchAll(SPEC)) {
        const spec = m[1];
        let target: string;
        if (spec.startsWith('@/')) target = `src/${spec.slice(2)}`;
        else if (spec.startsWith('.')) {
            target = path.normalize(path.join(path.dirname(f), spec)).split(path.sep).join('/');
        } else continue;
        const stem = stemOf(target);
        const list = importersOf.get(stem) ?? [];
        if (!list.includes(f)) list.push(f);
        importersOf.set(stem, list);
    }
}

/** Every jest TEST file that reaches `file`, following source→source edges. */
function reachingTests(file: string): string[] {
    const seen = new Set<string>([file]);
    const queue = [file];
    const tests: string[] = [];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const importer of importersOf.get(stemOf(current)) ?? []) {
            if (seen.has(importer)) continue;
            seen.add(importer);
            if (IS_JEST_TEST.test(importer)) tests.push(importer);
            else queue.push(importer);
        }
    }
    return tests;
}

/**
 * What `verify:changed` would run for this path, from the PATH rules alone.
 *
 * Content rules are excluded deliberately: they fire on the added lines of a
 * diff, which this guard does not have and must not guess at. An importer has
 * to be reachable from the path, because the path is all that is known.
 */
function derivedFor(file: string, rules: Rule[] = RULES.pathRules): string[] {
    return [...new Set(rules.filter((r) => new RegExp(r.when).test(file)).flatMap((r) => r.run))];
}

/** `tests/integration` is covered by `tests/integration` or by `tests`. */
function covers(derived: string[], root: string): boolean {
    return derived.some((d) => d === root || root.startsWith(`${d}/`));
}

/** The reach of every app-layer file, computed once. */
const REACH = APP_LAYER.map((file) => ({
    file,
    tests: reachingTests(file),
}));

/** App-layer files reaching an integration suite the rules do not select. */
function integrationGaps(rules?: Rule[]): { file: string; suites: number }[] {
    const out: { file: string; suites: number }[] = [];
    for (const { file, tests } of REACH) {
        const suites = tests.filter((t) => rootOf(t) === 'tests/integration');
        if (suites.length === 0) continue;
        if (covers(derivedFor(file, rules), 'tests/integration')) continue;
        out.push({ file, suites: suites.length });
    }
    return out.sort((a, b) => b.suites - a.suites);
}

describe('verify:changed covers the app layer (#3057)', () => {
    it('ranges over a real population with real importers', () => {
        const reaching = REACH.filter(
            (r) => r.tests.some((t) => rootOf(t) === 'tests/integration'),
        );
        const integrationSuites = TEST_FILES.filter((f) => rootOf(f) === 'tests/integration');
        console.log(
            `[verify-changed-app-layer] ${APP_LAYER.length} app-layer file(s), `
                + `${reaching.length} reaching at least one of `
                + `${integrationSuites.length} integration suite(s); `
                + `${TREE.length} file(s) scanned`,
        );
        // Floors on both sides: an import pattern that stopped matching, or a
        // renamed root, would empty these and pass every assertion below.
        expect(APP_LAYER.length).toBeGreaterThanOrEqual(300);
        expect(reaching.length).toBeGreaterThanOrEqual(200);
        expect(integrationSuites.length).toBeGreaterThanOrEqual(200);
    });

    it('derives tests/integration for every app-layer file that needs it', () => {
        const gaps = integrationGaps();
        expect(
            gaps.map((g) => `${g.file} — ${g.suites} integration suite(s) not derived`),
        ).toEqual([]);
    });

    it('the rule is load-bearing — the control', () => {
        // Without this, the assertion above passes whether or not any rule
        // supplies `tests/integration`, and a future "tidy the rules" PR that
        // dropped it would be green. Re-derives with the app-layer rules
        // removed and requires the gap to REAPPEAR.
        const withoutAppLayer = RULES.pathRules.filter(
            (r) => !r.when.includes('app-layer'),
        );
        expect(withoutAppLayer.length).toBeLessThan(RULES.pathRules.length);
        const gaps = integrationGaps(withoutAppLayer);
        expect(gaps.length).toBeGreaterThanOrEqual(200);
    });

    it('the import graph TELLS MODULES APART — the stemOf control', () => {
        // `stemOf` SURVIVED a mutation to a constant on the first green run.
        // Collapsed, every target shares one key, so the graph says
        // "everything reaches everything" and every floor above passes by a
        // wider margin. These are the assertions that fail when it does.

        // (a) the function itself, on named inputs.
        expect(stemOf('src/app-layer/usecases/channels.ts')).toBe(
            'src/app-layer/usecases/channels',
        );
        expect(stemOf('src/app-layer/notifications/index.ts')).toBe(
            'src/app-layer/notifications',
        );
        // Injective on two distinct modules — the property a collapse breaks,
        // and the one a `return ''` / `null` / `undefined` gut cannot satisfy.
        expect(stemOf('src/a.ts')).not.toBe(stemOf('src/b.ts'));

        // (b) the KEY COUNT. ~2,077 measured 2026-11-14; exactly 1 when
        // `stemOf` returns a constant.
        expect(importersOf.size).toBeGreaterThanOrEqual(1500);

        // (c) the SPREAD. A collapsed graph gives every app-layer file the
        // same reach, so more than one distinct count is the discriminator.
        // Measured: min 0, median 9, max 805.
        const counts = new Set(REACH.map((r) => r.tests.length));
        expect(counts.size).toBeGreaterThanOrEqual(20);
    });

    it('a named pair reaches, and the reach is BOUNDED', () => {
        // Non-empty proves the edges exist; bounded proves they are the RIGHT
        // edges. A collapsed graph satisfies the first and fails the second.
        const channels = REACH.find((r) => r.file === 'src/app-layer/usecases/channels.ts');
        expect(channels).toBeDefined();
        const integration = (channels as { tests: string[] }).tests.filter(
            (t) => rootOf(t) === 'tests/integration',
        );
        // The suite that asserts this usecase's push-link literal exactly —
        // the one #3030/PR 3056 changed while the tool ran none of it.
        expect(integration).toContain('tests/integration/channel-mention-notifies.test.ts');
        // 12 measured. Bounded well below the 279-suite root, which is what a
        // collapsed graph reports.
        expect(integration.length).toBeLessThan(100);
    });

    it('reports the WIDER gap rather than implying it is covered', () => {
        // Six more roots are reached by app-layer code and selected by no path
        // rule for a source change. Printed, not asserted — closing it would
        // run most of the repo on every app-layer edit, which is a cost
        // decision. #3058.
        const missing = new Map<string, number>();
        let colocated = 0;
        for (const { file, tests } of REACH) {
            const derived = derivedFor(file);
            for (const root of new Set(tests.map(rootOf))) {
                if (!JEST_COLLECTIBLE.has(root)) continue;
                if (covers(derived, root)) continue;
                // A test COLOCATED under `src/**/__tests__` is a different
                // population: jest collects it (the node project's testMatch
                // is repo-wide), but every `run` target in the rules file is a
                // `tests/*` prefix, so no rule can name it at all. Counted
                // apart rather than listed as a missing root, because the fix
                // is a new kind of target rather than another edge. #3059.
                if (!root.startsWith('tests/')) {
                    colocated += 1;
                    continue;
                }
                missing.set(root, (missing.get(root) ?? 0) + 1);
            }
        }
        const rows = [...missing].sort((a, b) => b[1] - a[1]);
        console.log(
            `[verify-changed-app-layer] roots still unreached by a PATH rule (#3058): `
                + (rows.map(([r, c]) => `${r}=${c}`).join(' ') || 'none')
                + `; app-layer file(s) whose only test is colocated under src/ (#3059): `
                + `${colocated}`,
        );
        // `tests/integration` must NOT be among them any more — that is this
        // guard's own subject, and seeing it here would mean the reading and
        // the assertion disagree.
        expect(rows.map(([r]) => r)).not.toContain('tests/integration');
    });
});
