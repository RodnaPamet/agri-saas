/**
 * The coverage-gate tooling, EXECUTED — for the first time.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `scripts/merge-coverage.mjs`, `scripts/diff-coverage.mjs`,
 * `scripts/check-coverage-thresholds.mjs` and `scripts/lib/coverage-groups.mjs`
 * are 675 lines that decide whether the coverage gate passes. Every test that
 * mentioned them was a GUARD — `readFileSync` + regex/YAML over source TEXT —
 * which per CLAUDE.md contributes zero runtime coverage.
 *
 * Measured 2026-08-22, by neutering both seams at once:
 *
 *   • diff-coverage.mjs  → always print "PARITY PROVEN", exit 0
 *   • merge-coverage.mjs → ignore --expect, so a MISSING SHARD passes silently
 *
 * **28 of 28 tests still passed.** Nothing in the repository executed either
 * decision. That is the same shape the peer lane hit in #723 (replacing
 * `buildEmailContent(type, payload, locale)` with a hardcoded `'en'` left all 34
 * tests green — the builders were covered, the seam was not), and the same shape
 * as the bullmq-real-api gap already documented in CLAUDE.md.
 *
 * ── Why these two seams specifically ──
 *
 * Both fail in the direction nobody investigates: TOWARD GREEN.
 *
 * `--expect` is the only thing standing between a dead shard and a passing gate.
 * istanbul's merge UNIONS the file set, so a missing shard does not depress
 * coverage — it removes files from the DENOMINATOR and the percentages RISE.
 * Measured elsewhere in this work: dropping 3 of 315 files from `./src/lib/`
 * moved it statements 84.96 → 85.06. A gate that is green over less code is
 * strictly worse than the dark gate this replaced, because darkness at least
 * prompts someone to look.
 *
 * `diff-coverage` is the evidence for turning enforcement back on. If it can
 * only say PROVEN, it is not evidence of anything.
 *
 * These tests spawn the real scripts as child processes rather than importing
 * them: they are CLIs that read `process.argv` and call `process.exit`, and the
 * exit CODE is half the contract.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

/** Minimal-but-real istanbul FileCoverage. `covered` is how many statements are hit. */
function fileCoverage(absPath: string, total: number, covered: number) {
    const statementMap: Record<string, unknown> = {};
    const s: Record<string, number> = {};
    for (let i = 0; i < total; i++) {
        statementMap[String(i)] = {
            start: { line: i + 1, column: 0 },
            end: { line: i + 1, column: 10 },
        };
        s[String(i)] = i < covered ? 1 : 0;
    }
    return { path: absPath, statementMap, fnMap: {}, branchMap: {}, s, f: {}, b: {} };
}

/** A coverage map keyed on ABSOLUTE paths under the repo root — jest resolves
 *  threshold keys against cwd, so foreign-rooted paths would miss every group. */
function makeMap(files: Array<{ rel: string; total: number; covered: number }>) {
    const map: Record<string, unknown> = {};
    for (const f of files) {
        const abs = path.join(ROOT, f.rel);
        map[abs] = fileCoverage(abs, f.total, f.covered);
    }
    return map;
}

let tmp: string;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-tooling-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, data: unknown): string {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
}

/**
 * Run a script and return its exit code plus BOTH streams.
 *
 * `spawnSync`, not `execFileSync`: the latter returns only stdout on success and
 * throws on failure, so the stderr of a run that EXITS 0 is discarded. That is
 * exactly the `--report-only` case — shadow mode prints its failures to stderr
 * and exits 0 — and it silently broke the assertion that shadow mode still
 * reports. The exit code and stderr are both half the contract here.
 */
function run(script: string, args: string[]): { status: number; out: string } {
    const r = spawnSync('node', [path.join(ROOT, script), ...args], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('merge-coverage.mjs — a missing shard must REFUSE, not quietly pass', () => {
    it('merges shards into one map, unioning files and summing hits', () => {
        write('s1/coverage-final.json', makeMap([{ rel: 'src/lib/a.ts', total: 10, covered: 5 }]));
        write('s2/coverage-final.json', makeMap([{ rel: 'src/lib/b.ts', total: 10, covered: 8 }]));

        const r = run('scripts/merge-coverage.mjs', ['--expect', '2', '--out', path.join(tmp, 'out'), tmp]);

        expect(r.status).toBe(0);
        const merged = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'coverage-final.json'), 'utf8'));
        expect(Object.keys(merged).sort()).toEqual(
            [path.join(ROOT, 'src/lib/a.ts'), path.join(ROOT, 'src/lib/b.ts')].sort(),
        );
    });

    it('REFUSES when a shard is missing — the failure that would otherwise raise coverage', () => {
        // Only 1 of the 2 expected shards is present. Without --expect this
        // merges happily and reports a number over half the code.
        write('s1/coverage-final.json', makeMap([{ rel: 'src/lib/a.ts', total: 10, covered: 5 }]));

        const r = run('scripts/merge-coverage.mjs', ['--expect', '2', '--out', path.join(tmp, 'out'), tmp]);

        expect(r.status).not.toBe(0);
        expect(r.out).toMatch(/expected 2 shard/i);
    });

    it('says WHY a missing shard matters, because the number would look better not worse', () => {
        write('s1/coverage-final.json', makeMap([{ rel: 'src/lib/a.ts', total: 10, covered: 5 }]));
        const r = run('scripts/merge-coverage.mjs', ['--expect', '3', '--out', path.join(tmp, 'out'), tmp]);
        expect(r.out).toMatch(/RAISES|shrinks the/i);
    });
});

describe('diff-coverage.mjs — must be able to say NO', () => {
    const A = [
        { rel: 'src/lib/a.ts', total: 10, covered: 5 },
        { rel: 'src/components/w.tsx', total: 10, covered: 4 },
    ];

    it('proves parity for two identical maps', () => {
        const a = write('a.json', makeMap(A));
        const b = write('b.json', makeMap(A));

        const r = run('scripts/diff-coverage.mjs', ['--a', a, '--b', b, '--thresholds', 'jest.thresholds.json']);

        expect(r.status).toBe(0);
        expect(r.out).toContain('PARITY PROVEN');
    });

    it('catches a DROPPED FILE — the dead-shard signature percentages cannot see', () => {
        const a = write('a.json', makeMap(A));
        const b = write('b.json', makeMap(A.slice(0, 1))); // src/components/w.tsx missing

        const r = run('scripts/diff-coverage.mjs', ['--a', a, '--b', b, '--thresholds', 'jest.thresholds.json']);

        expect(r.status).toBe(1);
        expect(r.out).toContain('COVERAGE PARITY FAILED');
        expect(r.out).toMatch(/file set differs/i);
        expect(r.out).toContain('src/components/w.tsx');
    });

    it('catches ONE flipped statement when the file set is identical', () => {
        const a = write('a.json', makeMap(A));
        const b = write('b.json', makeMap([{ ...A[0], covered: 4 }, A[1]]));

        const r = run('scripts/diff-coverage.mjs', ['--a', a, '--b', b, '--thresholds', 'jest.thresholds.json']);

        expect(r.status).toBe(1);
        expect(r.out).toContain('src/lib/a.ts');
        expect(r.out).toMatch(/5\/10.*4\/10|4\/10.*5\/10/s);
    });

    it('refuses an EMPTY map instead of comparing it equal to another empty map', () => {
        const a = write('a.json', {});
        const b = write('b.json', makeMap(A));

        const r = run('scripts/diff-coverage.mjs', ['--a', a, '--b', b, '--thresholds', 'jest.thresholds.json']);

        expect(r.status).toBe(2);
        expect(r.out).toMatch(/no files/i);
    });

    it('tells the reader NOT to re-floor — the wrong fix is the tempting one', () => {
        const a = write('a.json', makeMap(A));
        const b = write('b.json', makeMap(A.slice(0, 1)));
        const r = run('scripts/diff-coverage.mjs', ['--a', a, '--b', b, '--thresholds', 'jest.thresholds.json']);
        expect(r.out).toMatch(/Do NOT re-floor/i);
    });
});

describe('check-coverage-thresholds.mjs — enforces, and shadow-mode does not', () => {
    const thresholds = { global: { statements: 50, branches: 0, lines: 50, functions: 0 } };

    it('exits 0 when the floor is met', () => {
        const cov = write('c.json', makeMap([{ rel: 'src/components/w.tsx', total: 10, covered: 9 }]));
        const th = write('th.json', thresholds);

        const r = run('scripts/check-coverage-thresholds.mjs', ['--coverage', cov, '--thresholds', th]);

        expect(r.status).toBe(0);
        expect(r.out).toContain('All coverage thresholds met');
    });

    it('exits 1 and names the metric when the floor is missed', () => {
        const cov = write('c.json', makeMap([{ rel: 'src/components/w.tsx', total: 10, covered: 1 }]));
        const th = write('th.json', thresholds);

        const r = run('scripts/check-coverage-thresholds.mjs', ['--coverage', cov, '--thresholds', th]);

        expect(r.status).toBe(1);
        expect(r.out).toMatch(/does not meet "global" threshold/);
    });

    it('--report-only prints the SAME failure but exits 0 — shadow mode is not enforcement', () => {
        // This is the flag that will be removed once parity is proven. If it ever
        // stops being a pure no-op on the exit code, the gate silently changes
        // meaning in whichever direction the bug went.
        const cov = write('c.json', makeMap([{ rel: 'src/components/w.tsx', total: 10, covered: 1 }]));
        const th = write('th.json', thresholds);

        const r = run('scripts/check-coverage-thresholds.mjs', [
            '--coverage', cov, '--thresholds', th, '--report-only',
        ]);

        expect(r.status).toBe(0);
        expect(r.out).toMatch(/does not meet "global" threshold/);
        expect(r.out).toMatch(/SHADOW MODE/);
    });

    it('scores a path group SEPARATELY from global — the 2026-08-20 re-flooring trap', () => {
        // A file under ./src/lib/ is REMOVED from `global`. If that ever stops
        // being true, `global` silently starts being scored over the whole map,
        // which is the ~4.45-point difference that broke main.
        const cov = write('c.json', makeMap([
            { rel: 'src/lib/a.ts', total: 10, covered: 10 },
            { rel: 'src/components/w.tsx', total: 10, covered: 1 },
        ]));
        const th = write('th.json', {
            global: { statements: 50 },
            './src/lib/': { statements: 50 },
        });

        const r = run('scripts/check-coverage-thresholds.mjs', ['--coverage', cov, '--thresholds', th, '--report-only']);

        // global sees ONLY the components file (1/10 = 10%), not the 11/20 average.
        expect(r.out).toMatch(/global\s+files=\s*1\b/);
        expect(r.out).toMatch(/\.\/src\/lib\/\s+files=\s*1\b/);
        expect(r.out).toMatch(/Coverage for statements \(10%\) does not meet "global"/);
    });
});
