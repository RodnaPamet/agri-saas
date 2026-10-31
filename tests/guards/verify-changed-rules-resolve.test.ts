/**
 * `verify:changed`'s rules name test paths that exist — #2018.
 *
 * ## Why this guard and not a smoke test of the script
 *
 * The script's value is entirely in its RULES: a mapping from "what did you
 * change" to "what therefore has to run". A rule naming a path that has been
 * renamed or deleted contributes **zero tests** and the run still reports a
 * pass — which is the exact failure this tool was written to remove, now one
 * level up. `collectSourceFiles` throws on a renamed root for the same reason
 * (#875).
 *
 * So the assertion is on the rules' targets, not on the script's output. A
 * smoke test would prove it runs; this proves it runs the right things.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { collectTrackedFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Read as DATA, not imported from the script. Jest's `node` project is CJS and
 * cannot import `scripts/verify-changed.mjs` at all — "Must use import to load
 * ES Module" — which is why the rules live in a JSON file that both the script
 * and this test can read.
 */
type Rule = { when: string; run: string[]; why: string; lintOnly?: boolean };
const RULES = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/verify-changed.rules.json'), 'utf8'),
) as { pathRules: Rule[]; contentRules: Rule[]; noTestsNeeded?: Rule[] };

const PATH_RULES = RULES.pathRules;
const CONTENT_RULES = RULES.contentRules;
const NO_TESTS_NEEDED = RULES.noTestsNeeded ?? [];
const allRules: Rule[] = [...PATH_RULES, ...CONTENT_RULES];

describe('verify:changed rules (#2018)', () => {
    it('ranges over a real rule set — not vacuously passing', () => {
        // A rules array emptied by a refactor would make every assertion below
        // pass over nothing.
        console.log(
            `[verify-changed] ${PATH_RULES.length} path rule(s), `
                + `${CONTENT_RULES.length} content rule(s)`,
        );
        expect(PATH_RULES.length).toBeGreaterThanOrEqual(8);
        expect(CONTENT_RULES.length).toBeGreaterThanOrEqual(4);
    });

    it.each(allRules.flatMap((r) => r.run.map((p) => [p, r.when] as const)))(
        '%s exists (named by %s)',
        (target) => {
            // One assertion carrying both, so the failure says which rule to fix
            // rather than printing `false`.
            expect({ target, exists: existsSync(path.join(REPO_ROOT, target)) }).toEqual({
                target,
                exists: true,
            });
        },
    );

    it('every rule carries a reason long enough to be one', () => {
        // Same discipline as the exemption lists elsewhere: a rule with no
        // argument is indistinguishable from a guess, and this file is where
        // the knowledge that used to live only in failure messages now lives.
        for (const rule of allRules) {
            expect({ when: rule.when, long: rule.why.length > 80 }).toEqual({
                when: rule.when,
                long: true,
            });
        }
    });

    it('a content rule either runs something or is explicitly advisory', () => {
        // The `eslint-disable` rule runs no suite — it prints a warning about
        // the lint ceiling being stale. That is legitimate, and `lintOnly`
        // says so; an empty `run` without it is a rule that does nothing.
        for (const rule of CONTENT_RULES) {
            expect({
                when: rule.when,
                actionable: rule.run.length > 0 || rule.lintOnly === true,
            }).toEqual({ when: rule.when, actionable: true });
        }
    });

    it('every test-free declaration carries a reason, and runs nothing', () => {
        // `noTestsNeeded` is what keeps the empty-population REFUSAL safe to
        // make loud: without it, editing a README would exit 1. So it is a hole
        // in a check, and the same discipline applies — a reason per entry, and
        // no `run`, because an entry that ran something would be a path rule
        // wearing the wrong label.
        expect(NO_TESTS_NEEDED.length).toBeGreaterThan(0);
        for (const r of NO_TESTS_NEEDED) {
            expect({ when: r.when, explained: (r.why ?? '').length > 40 })
                .toEqual({ when: r.when, explained: true });
            expect({ when: r.when, runs: (r as { run?: string[] }).run ?? null })
                .toEqual({ when: r.when, runs: null });
        }
    });

    it('no path is BOTH covered and declared test-free', () => {
        // An ambiguous path would resolve by whichever check ran first, and the
        // two answers are opposites: run these suites, versus run nothing. The
        // probes are the real paths the categories were added for.
        const probes = [
            'README.md',
            'docs/implementation-notes/x.md',
            '.gitignore',
            'public/sw.js',
            '.github/workflows/ci.yml',
            '.github/dependabot.yml',
            'infra/alerts/external-uptime.yml',
            'src/env.ts',
        ];
        const both = probes.filter(
            (f) =>
                PATH_RULES.some((r) => new RegExp(r.when).test(f))
                && NO_TESTS_NEEDED.some((r) => new RegExp(r.when).test(f)),
        );
        expect(both).toEqual([]);
    });

    it('the paths that cost a real miss are COVERED, not test-free', () => {
        // Regression pins, each for a gap that was found by hitting it:
        // `public/sw.js` is the outbox's hand-mirrored reimplementation with
        // eight test files reading it, and `.github/workflows` carries the
        // guard that DERIVES the failure notifier's watch list. Both derived
        // NOTHING before #2018's follow-up, which meant a bare `jest` ran the
        // entire suite.
        for (const f of ['public/sw.js', '.github/workflows/ci-failure-issue.yml', 'infra/alerts/external-uptime.yml']) {
            const hits = PATH_RULES.filter((r) => new RegExp(r.when).test(f));
            expect({ f, covered: hits.length > 0 }).toEqual({ f, covered: true });
        }
    });

    /**
     * Every tracked file at the repository ROOT is classified — #2566.
     *
     * The INDEX rather than a directory walk, and deliberately: the question is
     * what this repository SHIPS at the root. A walk would also descend into
     * `.claude/worktrees/`, which holds 24 full copies of the repo — a mistake
     * I made in #2537 and caught only from the printed denominator.
     *
     * Through `collectTrackedFiles` rather than a hand-rolled `git ls-files`,
     * which `file-collection-is-not-silently-empty` correctly refused when I
     * wrote it by hand. `extensions` is omitted on purpose: the helper then
     * returns EVERY tracked file, which is what this needs — `Dockerfile` and
     * `nul` have no extension, so an extension filter cannot express this
     * population at all. The helper's floor is what makes the filter below
     * safe: an emptied index throws there rather than passing here.
     */
    const ROOT_FILES = collectTrackedFiles({ roots: ['.'], floor: 1000 })
        .map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'))
        .filter((f) => !f.includes('/'));

    it('every tracked ROOT file is covered by a rule or declared test-free', () => {
        // #2566: `jest.setup.js`, `jest.config.js`, `jest.thresholds.json`,
        // `tsconfig.json` and `playwright.config.ts` were NEITHER, so editing
        // any of them hit the script's own empty-population refusal. Those are
        // among the widest-blast-radius files in the repo — jest.setup.js is
        // the node project's setupFilesAfterEnv, so it decides the behaviour of
        // every suite.
        //
        // 32 of 46 root files were unclassified when this was written. The
        // refusal is loud rather than silent, which is why this was friction
        // rather than a false pass — but a classification nobody can be
        // prompted to add is a rule that never arrives.
        console.log(`[verify-changed] ${ROOT_FILES.length} tracked root file(s)`);
        const unclassified = ROOT_FILES.filter(
            (f) =>
                !PATH_RULES.some((r) => new RegExp(r.when).test(f))
                && !NO_TESTS_NEEDED.some((r) => new RegExp(r.when).test(f)),
        );
        expect(unclassified).toEqual([]);
        // A floor, because an empty population passes the assertion above for
        // free — a `git ls-files` that stopped returning root files would.
        expect(ROOT_FILES.length).toBeGreaterThanOrEqual(30);
    });

    it('nothing declared test-free is actually READ from disk by a test', () => {
        // The biconditional that keeps `noTestsNeeded` honest. Three entries
        // were false when this was written, each asserting in its own `why`
        // that nothing reads the file:
        //
        //   README.md  read by b8-landing-no-passwords-grc
        //   .nvmrc     read by deterministic-install
        //   .npmrc     read by engine-strict-is-ci-only
        //
        // A path declared test-free derives NOTHING, so editing it reads as a
        // pass — the failure #2018 exists to prevent, occurring inside these
        // rules. Without this test the claim is prose.
        const testFiles = collectTrackedFiles({
            roots: ['tests'],
            extensions: ['.test.ts', '.test.tsx'],
            floor: 1500,
        });
        const sources = testFiles.map((f) => readFileSync(f, 'utf8'));

        /**
         * A READ, not a mention. The distinction cost four measurements:
         * `expect(ext('.gitignore'))` passes a filename as an ARGUMENT,
         * `anchors: ['.nvmrc']` is a token searched FOR inside other files,
         * and `writeFileSync(path.join(dir, 'README.md'))` writes a fixture
         * into a temp directory. None of the three reads the root file, and a
         * substring or quoted-token match counts all of them.
         *
         * Its limit, stated because it is the direction that fails toward
         * green: a guard that DERIVES its population — `collectTrackedFiles`
         * over `.example`, say — names no literal and is invisible here. So
         * this is necessary and not sufficient, and the `.env*.example` rule
         * exists because of a reader exactly like that.
         */
        const readsFromDisk = (file: string): boolean => {
            const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(
                String.raw`(?:readFileSync|readRepoFile|readFile|\bread)\s*\(\s*`
                    + String.raw`(?:path\.join\(\s*[A-Za-z_$][\w$]*\s*,\s*)?['"\`]`
                    + escaped
                    + String.raw`['"\`]`,
            );
            return sources.some((s2) => re.test(s2));
        };

        const contradictions = ROOT_FILES.filter(
            (f) => NO_TESTS_NEEDED.some((r) => new RegExp(r.when).test(f)) && readsFromDisk(f),
        );
        expect(contradictions).toEqual([]);

        // Positive control: the detector finds a read that IS there. Without
        // it, a regex that stopped matching would report every declaration
        // honest, over a population of 46.
        expect(readsFromDisk('README.md')).toBe(true);
        expect(readsFromDisk('this-file-does-not-exist.md')).toBe(false);
    });

    it('the tests/ rule selects BOTH guard directories', () => {
        // The specific omission that cost a CI cycle twice: `tests/guards` run
        // without `tests/guardrails`. They are different roots and the
        // meta-guards are split across them.
        const rule = PATH_RULES.find((r) => new RegExp(r.when).test('tests/unit/example.test.ts'));
        expect(rule).toBeDefined();
        expect(rule!.run).toEqual(expect.arrayContaining(['tests/guards', 'tests/guardrails']));
    });
});
