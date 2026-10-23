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
) as { pathRules: Rule[]; contentRules: Rule[] };

const PATH_RULES = RULES.pathRules;
const CONTENT_RULES = RULES.contentRules;
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

    it('the tests/ rule selects BOTH guard directories', () => {
        // The specific omission that cost a CI cycle twice: `tests/guards` run
        // without `tests/guardrails`. They are different roots and the
        // meta-guards are split across them.
        const rule = PATH_RULES.find((r) => new RegExp(r.when).test('tests/unit/example.test.ts'));
        expect(rule).toBeDefined();
        expect(rule!.run).toEqual(expect.arrayContaining(['tests/guards', 'tests/guardrails']));
    });
});
