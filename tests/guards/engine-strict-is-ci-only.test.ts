/**
 * The Node-version guarantee lives where it is reachable — #2230.
 *
 * ## What moved, and why
 *
 * `.npmrc` used to carry `engine-strict=true`, for a good reason: without it npm
 * downgrades an engine mismatch to an `EBADENGINE` warning that scrolls past, so
 * a local Node 23/24 install silently produces a tree never validated against
 * what CI and production run.
 *
 * What a setting in `.npmrc` cannot do is tell WHO is installing. On 2026-10-23
 * Dependabot's updater image moved to node 24.22.1 / npm 12.2.1, so
 * `corepack npm@12 install … --package-lock-only` became a hard `notsup` error
 * against `engines.node: ">=22.0.0 <23.0.0"` and **every security-update job
 * failed** — silently, because `Dependabot Updates` is GitHub-native and the
 * failure notifier had no workflow file to watch.
 *
 * Both settings were right. So the policy moved off npm's global config and
 * onto the two places it applies:
 *
 *   1. `.husky/pre-commit` → `scripts/check-node-version.mjs`. LOCAL, which is
 *      the only place a wrong-node tree can be produced, since every CI job
 *      installs through `setup-node-prisma` and that pins `node-version`.
 *      Dependabot never runs a git hook.
 *   2. that action's install step sets `npm_config_engine_strict`, as belt and
 *      braces — a pinned version is a claim about configuration, engine-strict
 *      is a check on what is running.
 *
 * ## Why a guard rather than trusting the diff
 *
 * Each of the three facts below is one line in one file, and losing any of them
 * is invisible: the hook keeps passing, the install keeps succeeding, and the
 * guarantee is simply gone. Re-adding `engine-strict` to `.npmrc` would also
 * break Dependabot again — in a way that reports nothing until somebody reads
 * the Actions tab.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ACTION = '.github/actions/setup-node-prisma/action.yml';
const CHECKER = 'scripts/check-node-version.mjs';

/** Lines that are not comments — `.npmrc` comments start with `#` or `;`. */
const npmrcSettings = () =>
    read('.npmrc')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith(';'));

describe('the node-version guarantee is not in .npmrc (#2230)', () => {
    it('.npmrc sets no engine-strict', () => {
        // The whole point: this file is read by every npm on earth, including a
        // third party's runner whose node version is not ours to choose.
        for (const line of npmrcSettings()) {
            expect(line).not.toMatch(/^engine[-_]strict\s*=/i);
        }
    });

    it('CONTROL: the comment filter can still SEE a setting', () => {
        // `.npmrc` is now entirely prose — it held one setting and that setting
        // moved — so asserting the real file has a setting would be wrong. What
        // has to be true is that the filter would NOTICE one, otherwise the
        // assertion above passes over an empty list for the wrong reason.
        //
        // Proved against literals rather than the file, because the file is the
        // thing under test.
        const parse = (text: string) =>
            text
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith(';'));
        expect(parse('# a comment\nengine-strict=true\n')).toEqual(['engine-strict=true']);
        expect(parse('; also a comment\n\n')).toEqual([]);
        expect(npmrcSettings()).toEqual([]);
    });

    it('.npmrc still EXPLAINS where the guarantee went', () => {
        // A file emptied of its setting and of its reasoning is a file the next
        // person re-adds `engine-strict` to.
        const raw = read('.npmrc');
        expect(raw).toContain('engine-strict');
        expect(raw).toContain('#2230');
        expect(raw).toContain(CHECKER);
    });
});

describe('it lives in the two places that can enforce it (#2230)', () => {
    it('the pre-commit hook runs the checker', () => {
        const hook = read('.husky/pre-commit');
        expect(hook).toContain(CHECKER);
        // Ordering compared over EXECUTABLE lines only. The hook's docblock
        // names `scripts/detect-secrets.sh` while explaining what it does, so a
        // raw `indexOf` finds the PROSE and reports an order that is not the
        // one that runs — which is how this assertion failed when written.
        const lines = hook
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== '' && !l.startsWith('#'));
        const checkerAt = lines.findIndex((l) => l.includes(CHECKER));
        const secretsAt = lines.findIndex((l) => l.includes('detect-secrets.sh'));
        expect(checkerAt).toBeGreaterThanOrEqual(0);
        expect(secretsAt).toBeGreaterThanOrEqual(0);
        // Cheapest first: a wrong-node developer is told immediately rather
        // than after a secret scan and an i18n parse.
        expect(checkerAt).toBeLessThan(secretsAt);
    });

    it('the shared CI action sets npm_config_engine_strict on its install step', () => {
        const doc = yaml.load(read(ACTION)) as {
            runs: { steps: Array<{ name?: string; env?: Record<string, string> }> };
        };
        const install = doc.runs.steps.find((s) => s.name === 'Install dependencies');
        expect(install).toBeDefined();
        expect(install!.env?.npm_config_engine_strict).toBe('true');
    });

    it('that action still PINS a node version — the belt the braces assume', () => {
        // engine-strict on CI is belt and braces precisely because the version
        // is pinned. If the pin went, engine-strict would be the only thing
        // left and this file's reasoning would be wrong.
        const doc = yaml.load(read(ACTION)) as {
            inputs?: Record<string, { default?: string }>;
            runs: { steps: Array<{ uses?: string; with?: Record<string, string> }> };
        };
        expect(doc.inputs?.['node-version']?.default).toBe('22');
        const setup = doc.runs.steps.find((s) => (s.uses ?? '').startsWith('actions/setup-node'));
        expect(setup?.with?.['node-version']).toContain('node-version');
    });
});

describe('the checker actually rejects the versions it must (#2230)', () => {
    /** Driven as a subprocess: jest's `node` project is CJS and cannot import an `.mjs`. */
    function satisfies(version: string, range: string) {
        const r = spawnSync(
            'node',
            [
                '--input-type=module',
                '-e',
                `import {satisfies} from ${JSON.stringify(path.join(ROOT, CHECKER))};`
                + `process.stdout.write(String(satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)})));`,
            ],
            { encoding: 'utf8' },
        );
        return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
    }

    const RANGE = '>=22.0.0 <23.0.0';

    it('accepts the pinned major', () => {
        expect(satisfies('v22.23.2', RANGE).out).toBe('true');
    });

    it("rejects node 24 — the version Dependabot's updater moved to", () => {
        // The exact input that broke every security-update run.
        expect(satisfies('v24.22.1', RANGE).out).toBe('false');
    });

    it('rejects a major BELOW the floor too', () => {
        // Without this, a range check that only ever compared the upper bound
        // would pass every assertion above.
        expect(satisfies('v21.9.0', RANGE).out).toBe('false');
    });

    it('THROWS on a comparator it does not understand, rather than passing', () => {
        // A parser that returned `true` for a form it cannot read would report
        // a clean result about a constraint it never applied.
        const r = satisfies('v22.0.0', '^22.0.0');
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('unsupported range comparator');
    });

    it('reads its range from package.json engines, not a copy', () => {
        const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
        expect(pkg.engines?.node).toBeTruthy();
        // The checker must not hold a second copy of the range: two spellings
        // of one constraint is how they end up disagreeing.
        //
        // Comments BLANKED first. The docblock quotes the range verbatim while
        // explaining Dependabot's failure, so a raw-text assertion fails on the
        // explanation — the same mistake the hook-ordering case above records.
        const src = read(CHECKER);
        expect(src).toContain('engines.node');
        expect(blankNonCode(src)).not.toContain('>=22.0.0 <23.0.0');
        // Not vacuous: the prose really does quote it.
        expect(src).toContain('>=22.0.0 <23.0.0');
    });
});
