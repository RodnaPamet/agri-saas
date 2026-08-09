/**
 * Guard — the pure-re-export barrel exclusion stays honest AND stays
 * effective.
 *
 * `jest.config.js` drops a small list of barrel files from the coverage
 * denominator. The justification is narrow: TypeScript compiles
 * `export { X } from './m'` into
 *
 *     Object.defineProperty(exports, 'X', { get: function () { return m_1.X; } })
 *
 * and istanbul counts each getter as a FUNCTION. A barrel with no logic
 * therefore contributes permanently-uncovered "functions" that exist only
 * in emitted JavaScript — there is nothing in the source to test.
 *
 * This guard defends two different things, and it needs both:
 *
 *   1. PURITY — the exclusion cannot become a place to hide untested
 *      logic. A listed file that grows a `const` / `function` / arrow /
 *      `class` fails CI.
 *
 *   2. EFFECT — the exclusion actually removes the file from the emitted
 *      report. This half exists because the first implementation did not.
 *      It appended `!`-prefixed negations to a project-level
 *      `collectCoverageFrom`, which jest reads from the GLOBAL config
 *      only (`jest-runner` hands `globalConfig.collectCoverageFrom` to
 *      the runtime; `@jest/reporters` reads the same field when adding
 *      untested files). Written inside a `projects:` entry it is inert.
 *      Every listed barrel stayed in the denominator at full function
 *      count, and the old guard passed the whole time — it asserted the
 *      pattern was PRESENT IN THE CONFIG, never that a file had LEFT THE
 *      REPORT. Shape, not outcome.
 *
 * The effect half runs a real instrumented Jest pass over a probe that
 * imports one of the excluded barrels, then reads the emitted
 * `coverage-summary.json`. Three assertions, and the middle one is the
 * one that matters most:
 *
 *   - a sibling of the barrel IS in the report  (the run collected real
 *     coverage — without this, "absent" is vacuously true for any file
 *     the run never loaded, which is exactly how the broken exclusion
 *     was mis-verified)
 *   - the barrel is NOT in the report            (the exclusion works)
 *   - with the barrel patterns stripped, it IS   (the assertion has
 *     teeth, and this is precisely the old, broken config's behaviour)
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** Fixture that loads a barrel so the exclusion has something to remove. */
const PROBE = 'tests/fixtures/coverage/barrel-probe.ts';
/** The barrel that probe imports. */
const PROBE_BARREL = 'src/lib/observability/index.ts';
/** A sibling the barrel re-exports — the anti-vacuity practice. */
const PROBE_CONTROL = 'src/lib/observability/context.ts';

interface ProjectConfig {
    displayName?: string;
    coveragePathIgnorePatterns?: string[];
    collectCoverageFrom?: string[];
    [key: string]: unknown;
}

/** The live config, exactly as jest resolves it — not a re-typed copy. */
function jestConfig(): { projects: ProjectConfig[]; [key: string]: unknown } {
    return require(path.join(ROOT, 'jest.config.js'));
}

/**
 * A `coveragePathIgnorePatterns` entry is a regex against the absolute
 * filename. The barrel entries are single anchored files
 * (`/src/…/index\.ts$`); directory filters like `/node_modules/` are not.
 * Recover the repo-relative path of every entry that names a real file.
 */
function barrelsFromPatterns(patterns: readonly string[]): string[] {
    const files: string[] = [];
    for (const pattern of patterns) {
        if (!pattern.endsWith('$')) continue;
        const rel = pattern
            .slice(0, -1) // drop the `$` anchor
            .replace(/\\(.)/g, '$1') // un-escape `\.` etc.
            .replace(/^\//, ''); // drop the leading path anchor
        const abs = path.join(ROOT, rel);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push(rel);
    }
    return files;
}

/** Union of the excluded barrel files across every project. */
function excludedBarrels(): string[] {
    const seen = new Set<string>();
    for (const project of jestConfig().projects ?? []) {
        for (const rel of barrelsFromPatterns(project.coveragePathIgnorePatterns ?? [])) {
            seen.add(rel);
        }
    }
    return [...seen].sort();
}

/**
 * Run a real instrumented Jest pass over the probe and return the set of
 * repo-relative files in the emitted `coverage-summary.json`.
 *
 * The child config is the REAL config with the real project spread into
 * it — only `globalSetup` / `globalTeardown` (DB bootstrap, irrelevant to
 * instrumentation) and `testMatch` are overridden. Critically it keeps
 * the `projects: [...]` SHAPE, because that shape is the whole bug: jest
 * normalises each project standalone, so an option's global-vs-project
 * placement decides whether it is honoured. A child config flattened to a
 * single project would honour a top-level `coveragePathIgnorePatterns`
 * that the real multi-project config ignores, and would report a pass on
 * a config that is broken in CI.
 */
function coveredFiles(options: { keepBarrelPatterns: boolean }): string[] {
    const real = jestConfig();
    const node = (real.projects ?? []).find((p) => p.displayName === 'node');
    if (!node) throw new Error('jest.config.js has no project named "node"');

    const patterns = node.coveragePathIgnorePatterns ?? [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barrel-coverage-'));

    const childConfig = {
        ...real,
        rootDir: ROOT,
        coverageDirectory: dir,
        coverageReporters: ['json-summary'],
        projects: [
            {
                ...node,
                // Each `projects:` entry is normalised STANDALONE, so it
                // needs its own rootDir — it does not inherit the one
                // above, and would otherwise default to the temp dir the
                // child config is written into.
                rootDir: ROOT,
                globalSetup: undefined,
                globalTeardown: undefined,
                // A one-file run sits far below every floor. Today this
                // would not fail the child — jest ignores a project-level
                // `coverageThreshold` in multi-project mode, which is the
                // whole reason CI passes it via `--coverageThreshold`
                // instead — but depending on that bug to keep this guard
                // green is not a contract. Drop it: floors are irrelevant
                // to whether a file is in the report.
                coverageThreshold: undefined,
                testMatch: [`<rootDir>/${PROBE}`],
                coveragePathIgnorePatterns: options.keepBarrelPatterns
                    ? patterns
                    : // Reproduce the pre-fix denominator: keep the
                      // directory filters, drop the per-file barrel ones.
                      patterns.filter((p) => !p.endsWith('$')),
            },
        ],
    };

    const configPath = path.join(dir, 'jest.config.json');
    fs.writeFileSync(configPath, JSON.stringify(childConfig));

    try {
        execFileSync(
            process.execPath,
            [
                path.join(ROOT, 'node_modules/jest/bin/jest.js'),
                '--config',
                configPath,
                '--coverage',
                '--runInBand',
                '--forceExit',
                '--silent',
            ],
            { cwd: ROOT, stdio: 'pipe', timeout: 180_000 },
        );
    } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer };
        throw new Error(
            `probe jest run failed:\n${e.stderr?.toString() ?? ''}\n${e.stdout?.toString() ?? ''}`,
        );
    }

    const summaryPath = path.join(dir, 'coverage-summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    const files = Object.keys(summary)
        .filter((k) => k !== 'total')
        .map((abs) => path.relative(ROOT, abs));
    fs.rmSync(dir, { recursive: true, force: true });
    return files;
}

/**
 * Strip comments before scanning. Without this, prose in a barrel's
 * docblock ("...return the typed facade...") would read as executable
 * code and the guard would fire on its own documentation.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const EXECUTABLE = /(^|\s)(const|let|var|function|class|if|return|switch|for|while)\s|=>/;

function executableLines(src: string): string[] {
    return stripComments(src)
        .split('\n')
        .filter((l) => EXECUTABLE.test(l));
}

describe('Guard: pure-re-export barrel coverage exclusion', () => {
    const barrels = excludedBarrels();

    describe('the list stays honest', () => {
        it('excludes at least one barrel (the list did not silently empty)', () => {
            expect(barrels.length).toBeGreaterThan(0);
        });

        it.each(barrels)('%s exists on disk', (rel) => {
            // A stale path excludes nothing and hides a rename.
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        });

        it.each(barrels)('%s contains no executable code', (rel) => {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            const offenders = executableLines(src);
            expect(offenders).toEqual([]);
        });

        it('detects a barrel that grows real logic', () => {
            // Regression proof for the detector itself: without this, a
            // broken regex would pass every file above and the guard would
            // be decorative.
            const withLogic = `
                export { Foo } from './foo';
                export const helper = (n: number) => n + 1;
            `;
            expect(executableLines(withLogic)).not.toEqual([]);
        });

        it('does not mistake documentation prose for code', () => {
            // The failure this actually prevents: a docblock containing a
            // word like "return" tripping the scan.
            const proseOnly = `
                /**
                 * Module entry. Consumers should return to the typed facade
                 * rather than importing internals. For each widget, if you
                 * need the class, import it directly.
                 */
                export { Foo } from './foo';
                export type { Bar } from './bar';
            `;
            expect(executableLines(proseOnly)).toEqual([]);
        });
    });

    describe('the exclusion is wired where jest reads it', () => {
        it('every barrel is excluded in EVERY project', () => {
            // The report is merged across projects. A barrel excluded in
            // `node` but not `jsdom` is still in the denominator — the UI
            // barrels are loaded by `tests/rendered/**`, the app-layer ones
            // by the node suite.
            const projects = jestConfig().projects ?? [];
            expect(projects.length).toBeGreaterThan(1);
            for (const project of projects) {
                expect({
                    project: project.displayName,
                    barrels: barrelsFromPatterns(project.coveragePathIgnorePatterns ?? []).sort(),
                }).toEqual({ project: project.displayName, barrels });
            }
        });

        it('no project declares collectCoverageFrom (jest ignores it there)', () => {
            // The original defect. `collectCoverageFrom` is a GLOBAL-config
            // option; inside a `projects:` entry it is silently inert, so
            // `!`-negations written there exclude nothing. Keep the
            // placement mistake from coming back.
            for (const project of jestConfig().projects ?? []) {
                expect({
                    project: project.displayName,
                    collectCoverageFrom: project.collectCoverageFrom,
                }).toEqual({
                    project: project.displayName,
                    collectCoverageFrom: undefined,
                });
            }
        });
    });

    describe('the exclusion actually removes the file from the report', () => {
        // One instrumented Jest pass per branch; ~5s each.
        jest.setTimeout(300_000);

        let withExclusion: string[];
        let withoutExclusion: string[];

        beforeAll(() => {
            withExclusion = coveredFiles({ keepBarrelPatterns: true });
            withoutExclusion = coveredFiles({ keepBarrelPatterns: false });
        });

        it('the probe run collected real coverage (not a vacuous pass)', () => {
            // If the probe stops loading the barrel — an import removed, a
            // rename, a mock — every "absent" assertion below becomes
            // trivially true. This is the assertion the original
            // verification was missing.
            expect(withExclusion).toContain(PROBE_CONTROL);
            expect(withoutExclusion).toContain(PROBE_CONTROL);
        });

        it(`${PROBE_BARREL} is absent from the emitted coverage-summary.json`, () => {
            // Outcome first, deliberately: this must fail because the file
            // is STILL IN THE REPORT, not because a list lookup missed.
            // The pre-fix config fails exactly here.
            expect(withExclusion).not.toContain(PROBE_BARREL);
            // …and the probe target really is one of the excluded barrels,
            // so a future edit cannot satisfy the line above by pointing
            // the probe at a file nobody excluded.
            expect(barrels).toContain(PROBE_BARREL);
        });

        it('and is present once the barrel patterns are stripped', () => {
            // Proves the absence above is caused by the exclusion rather
            // than by the probe never touching the file. This branch is
            // the behaviour of the pre-fix config, so this guard fails
            // against it — which is the whole point.
            expect(withoutExclusion).toContain(PROBE_BARREL);
        });
    });
});
