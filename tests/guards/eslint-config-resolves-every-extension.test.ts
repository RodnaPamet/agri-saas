/**
 * The ESLint config must RESOLVE for every extension ESLint lints (#1284).
 *
 * ## The defect
 *
 * The cross-cutting block in `eslint.config.mjs` carries no `files:` key, so
 * in flat config it applies to every linted file. It names ten
 * `react-hooks/*` rules plus `react/no-find-dom-node`, and BOTH of those
 * plugins come from `eslint-config-next`, which registers them in a block
 * whose glob covers `.js .jsx .mjs .ts .tsx .mts .cts` — and not `.cjs`,
 * which ESLint lints out of the box. So one `.cjs` file anywhere in the tree
 * made ESLint abort the WHOLE run:
 *
 *     A configuration object specifies rule "react-hooks/set-state-in-effect",
 *     but could not find plugin "react-hooks".
 *
 * Not a lint error on one file — no findings at all, exit 2, and a message
 * about React hooks that reads as cache corruption or lockfile drift long
 * before it reads as config scoping. Measured on the unfixed tree with the
 * CONTENT held constant, so the result is about the extension and not the
 * file: `repro.cjs` exit 2, byte-identical `repro.js` exit 0.
 *
 * ## Why this EXECUTES eslint
 *
 * A plugin-resolution failure is invisible in the config source. "the block
 * lists `plugins: { 'react-hooks': … }`" and "the rules resolve for this
 * file" are different claims: the other half of the second one is the Next
 * preset's own glob, which lives in `node_modules`. A `toContain` cannot see
 * it, and the failure it would miss takes the entire `Lint` gate down.
 *
 * It SHELLS OUT rather than importing the ESLint API because the flat config
 * is `.mjs` and ESLint loads it by dynamic import, which jest's CJS runtime
 * refuses without `--experimental-vm-modules`. Same reasoning, same shape as
 * `tests/guards/lint-gate-can-fail.test.ts`, which this file is modelled on.
 *
 * ## Why ONE eslint run covers all the fixtures
 *
 * An unresolvable plugin aborts the RUN, not the file, so a single
 * invocation over every extension is the faithful shape of the defect. It is
 * also the affordable one: a cold ESLint boot with this config measures ~14s,
 * so a run per extension would cost two minutes for no extra information.
 *
 * ## The premise is MEASURED, not assumed
 *
 * The first test derives the preset's glob and asserts there is still an
 * extension outside it. If a future `eslint-config-next` widens the glob to
 * cover everything ESLint lints, that test FAILS instead of passing over an
 * empty selection — a probe aimed at an extension the preset now covers
 * proves nothing, and being told so beats going quietly green.
 *
 * The third test is the positive control: the same invocation with a rule
 * from a plugin that genuinely does not exist must come back non-zero with
 * the "could not find plugin" text. Without it, "exit 0" could mean the
 * fixtures were never linted at all (an ignored path exits 0 too), and the
 * guard would be incapable of expressing the failure it exists to catch.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The installed ESLint's own CLI entry, run under `process.execPath`.
 *
 * NOT `npx eslint`: in a worktree whose `node_modules` is absent or partial,
 * npx silently fetches the registry's newest CLI instead of the repo's pin,
 * and this test's whole subject is how the PINNED versions interact.
 */
const ESLINT_BIN = (() => {
    const manifestPath = require.resolve('eslint/package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        bin: string | Record<string, string>;
    };
    const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.eslint;
    return path.join(path.dirname(manifestPath), rel);
})();

/**
 * Written at the repo root so the config cascade resolves exactly as it does
 * in CI, and gitignored. NOT added to `ignores` in `eslint.config.mjs`: an
 * ignored path makes ESLint exit 0 WITHOUT linting, which is the one way this
 * guard could pass while seeing nothing.
 */
const PROBE_DIR = path.join(ROOT, '.eslint-extension-probe');

/**
 * ESLint 9's built-in default config lints these three with no `files:` of
 * ours — so a file in any of them can reach the cross-cutting block.
 */
const ESLINT_DEFAULT_EXTENSIONS = ['js', 'mjs', 'cjs'] as const;

/** `.cjs` needs CommonJS source; everything else takes the ESM form. */
function fixtureSource(ext: string): string {
    return ext === 'cjs' ? 'module.exports = { ok: 1 };\n' : 'export const ok = 1;\n';
}

interface Run {
    status: number;
    stdout: string;
    stderr: string;
}

function runEslint(args: string[]): Run {
    try {
        const stdout = execFileSync(process.execPath, [ESLINT_BIN, ...args], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, ESLINT_USE_FLAT_CONFIG: 'true' },
            // Explicit, so the positive control's expected abort is CAPTURED
            // rather than echoed through the jest reporter as if it were a
            // real failure. Without this `stdio[2]` passes through.
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, stdout, stderr: '' };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
}

/**
 * The `files` globs of the preset block that registers `react-hooks` — read
 * from the INSTALLED preset, in a child process, because
 * `eslint-config-next/core-web-vitals` is ESM and jest's CJS runtime cannot
 * import it.
 */
function presetPluginGlobs(plugin: string): string[] {
    const script = [
        "import c from 'eslint-config-next/core-web-vitals';",
        `const b = c.find((x) => x?.plugins?.[${JSON.stringify(plugin)}]);`,
        'process.stdout.write(JSON.stringify(b?.files ?? null));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    const globs = JSON.parse(out) as string[] | null;
    if (!globs) {
        throw new Error(
            `eslint-config-next no longer registers a '${plugin}' plugin in any config object. ` +
                'eslint.config.mjs sources it from there, so it would now throw at config load. ' +
                'Refs #1284.',
        );
    }
    return globs;
}

/** A trailing `.{a,b}` brace set, or a trailing `.c`, becomes `['a','b','c']`. */
function extensionsFromGlobs(globs: string[]): Set<string> {
    const found = new Set<string>();
    for (const glob of globs) {
        const brace = /\.\{([^}]+)\}$/.exec(glob);
        if (brace) {
            for (const ext of brace[1].split(',')) found.add(ext.trim());
            continue;
        }
        const single = /\.([A-Za-z0-9]+)$/.exec(glob);
        if (single) found.add(single[1]);
    }
    return found;
}

const PRESET_GLOBS = presetPluginGlobs('react-hooks');
const PRESET_EXTENSIONS = extensionsFromGlobs(PRESET_GLOBS);

/**
 * Every extension that can reach the cross-cutting block: the ones the
 * preset's glob names, plus ESLint's own defaults. Derived, so a widened
 * preset glob widens the probe instead of leaving it behind.
 */
const PROBE_EXTENSIONS = [
    ...new Set<string>([...PRESET_EXTENSIONS, ...ESLINT_DEFAULT_EXTENSIONS]),
].sort();

/** The extensions whose plugin resolution the Next preset does NOT supply. */
const UNCOVERED = PROBE_EXTENSIONS.filter((ext) => !PRESET_EXTENSIONS.has(ext));

const fixturePaths = PROBE_EXTENSIONS.map((ext) => path.join(PROBE_DIR, `probe.${ext}`));

describe("eslint's config resolves for every extension it lints", () => {
    jest.setTimeout(180_000);

    beforeAll(() => {
        // An interrupted earlier run can leave the directory behind.
        fs.rmSync(PROBE_DIR, { recursive: true, force: true });
        fs.mkdirSync(PROBE_DIR, { recursive: true });
        for (const ext of PROBE_EXTENSIONS) {
            fs.writeFileSync(path.join(PROBE_DIR, `probe.${ext}`), fixtureSource(ext), 'utf8');
        }
    });

    afterAll(() => {
        fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    });

    it('the premise holds: some extension ESLint lints is outside the preset glob', () => {
        // Two directions, and BOTH have to hold for the run below to mean
        // anything. A preset that one day covered everything would leave it
        // probing only extensions whose plugins are already registered —
        // green, and about nothing. And a derivation that silently produced
        // NO extensions is the same defect wearing the opposite mask: every
        // extension then reads as "uncovered" while the probe set collapses
        // to ESLint's three built-in defaults.
        expect({
            presetGlobs: PRESET_GLOBS,
            probed: PROBE_EXTENSIONS,
            uncoveredByPreset: UNCOVERED,
            presetCoversSomething: PRESET_EXTENSIONS.size > 0,
            someExtensionIsUncovered: UNCOVERED.length > 0,
        }).toEqual({
            presetGlobs: PRESET_GLOBS,
            probed: PROBE_EXTENSIONS,
            uncoveredByPreset: UNCOVERED,
            presetCoversSomething: true,
            someExtensionIsUncovered: true,
        });
    });

    it('lints one file per extension in a single run and exits 0', () => {
        // The fixtures have to be REAL source in the right module system
        // first. An empty file still reaches config resolution, so "exit 0
        // over eight empty files" would look identical to the thing this
        // test claims — and a `.cjs` holding ESM syntax would fail for a
        // reason that has nothing to do with plugin scope.
        const malformed = PROBE_EXTENSIONS.filter((ext) => {
            const text = fs.readFileSync(path.join(PROBE_DIR, `probe.${ext}`), 'utf8');
            return !text.includes(ext === 'cjs' ? 'module.exports' : 'export const');
        });
        expect({ fixtures: PROBE_EXTENSIONS.length, malformed }).toEqual({
            fixtures: PROBE_EXTENSIONS.length,
            malformed: [],
        });

        const run = runEslint(['-f', 'json', ...fixturePaths]);

        // The abort prints to stderr and leaves stdout empty, so report it.
        expect({ status: run.status, stderr: run.stderr.trim().slice(0, 400) }).toEqual({
            status: 0,
            stderr: '',
        });

        const results = JSON.parse(run.stdout) as Array<{
            filePath: string;
            messages: Array<{ message: string }>;
        }>;

        // Control on the control: exit 0 is also what an IGNORED path returns,
        // and an ignored fixture is linted by nothing at all.
        expect({
            inspected: results.length,
            expected: fixturePaths.length,
            ignored: results.flatMap((r) =>
                r.messages.filter((m) => /File ignored/i.test(m.message)).map(() => r.filePath),
            ),
        }).toEqual({
            inspected: fixturePaths.length,
            expected: fixturePaths.length,
            ignored: [],
        });
    });

    it('...and the probe WOULD report an unresolvable plugin (positive control)', () => {
        // Same invocation, same fixtures, one difference: a rule whose plugin
        // is not registered anywhere — the exact failure shape #1284 was.
        const run = runEslint([
            '-f',
            'json',
            '--rule',
            JSON.stringify({ 'no-such-plugin/no-such-rule': 'warn' }),
            ...fixturePaths,
        ]);

        expect({
            nonZero: run.status !== 0,
            namesTheCause: /could not find plugin "no-such-plugin"/.test(run.stderr),
        }).toEqual({ nonZero: true, namesTheCause: true });
    });
});
