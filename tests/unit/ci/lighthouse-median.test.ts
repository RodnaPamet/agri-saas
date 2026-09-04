/**
 * Executes `scripts/ci/lighthouse-median.mjs` against real fixture directories.
 *
 * Spawned as a child process rather than imported, following
 * `tests/unit/coverage-tooling/coverage-scripts.test.ts`: the CLI surface —
 * argv handling, exit code, the `::warning::` annotations GitHub actually
 * renders — is part of what is being tested, and an import exercises none of it.
 *
 * The case that matters most is the EMPTY one. This script exists because
 * `.lighthouseci` reports were silently discarded for the life of the
 * workflow: a hidden directory excluded by `upload-artifact`'s default, with
 * no signal anywhere that anything was missing. A reporter that printed
 * nothing on an empty directory would reproduce that defect one level up —
 * so "nothing to report" must be loud, and this file pins that it is.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/ci/lighthouse-median.mjs');

function lhr(lcp: number, fcp: number, cls: number, score: number) {
    return {
        finalDisplayedUrl: 'http://localhost:3006/login',
        categories: { performance: { score } },
        audits: {
            'largest-contentful-paint': { numericValue: lcp },
            'first-contentful-paint': { numericValue: fcp },
            'speed-index': { numericValue: fcp * 1.2 },
            'total-blocking-time': { numericValue: 900 },
            'cumulative-layout-shift': { numericValue: cls },
        },
    };
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function makeDir(files: Record<string, string>): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lhci-'));
    dirs.push(d);
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(d, name), body);
    }
    return d;
}

function run(dir: string, env: NodeJS.ProcessEnv = {}) {
    const r = spawnSync('node', [SCRIPT, dir], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('lighthouse-median', () => {
    it('reports the per-metric median across the three runs lhci writes', () => {
        const dir = makeDir({
            'lhr-1.json': JSON.stringify(lhr(6100, 2000, 0.01, 0.5)),
            'lhr-2.json': JSON.stringify(lhr(6150, 2400, 0.02, 0.46)),
            'lhr-3.json': JSON.stringify(lhr(6900, 2200, 0.03, 0.44)),
        });
        const { code, out } = run(dir);
        expect(code).toBe(0);
        // Median of 6100/6150/6900 is 6150 — NOT the mean (6383) and not the
        // first value, so this separates median from both plausible mistakes.
        expect(out).toContain('| LCP | 6150 ms | 3 |');
        expect(out).toContain('| FCP | 2200 ms | 3 |');
        expect(out).toContain('| CLS | 0.020 | 3 |');
        expect(out).toContain('| Performance score | 46 | 3 |');
        expect(out).toContain('3 run(s)');
    });

    it('averages the two middle values on an even sample', () => {
        const dir = makeDir({
            'lhr-1.json': JSON.stringify(lhr(1000, 100, 0, 0.5)),
            'lhr-2.json': JSON.stringify(lhr(2000, 100, 0, 0.5)),
        });
        expect(run(dir).out).toContain('| LCP | 1500 ms | 2 |');
    });

    it('is LOUD about an empty directory rather than printing nothing', () => {
        // The defect this script exists to fix was silence that read as
        // success. A reporter that reproduced it would be worse than none.
        const { code, out } = run(makeDir({}));
        expect(code).toBe(0);
        expect(out).toContain('::warning::');
        expect(out).toContain('holds no lhr-*.json');
        expect(out).not.toContain('| LCP |');
    });

    it('is LOUD about a missing directory', () => {
        const { code, out } = run(path.join(os.tmpdir(), 'lhci-definitely-absent-xyz'));
        expect(code).toBe(0);
        expect(out).toContain('::warning::');
        expect(out).toContain('no ');
        expect(out).not.toContain('| LCP |');
    });

    it('ignores files lhci did not write, and says when one is unreadable', () => {
        const dir = makeDir({
            'lhr-1.json': JSON.stringify(lhr(5000, 1000, 0, 0.6)),
            'lhr-2.json': '{ not json',
            'manifest.json': '{"ignored": true}',
            'assertion-results.json': '[]',
        });
        const { code, out } = run(dir);
        expect(code).toBe(0);
        // manifest/assertion-results must not be counted as runs...
        expect(out).toContain('1 run(s)');
        // ...and the broken lhr must be REPORTED, not silently dropped.
        expect(out).toContain('1 of 2 report(s) unreadable');
    });

    it('renders n/a for a metric no report carried, instead of crashing', () => {
        const partial = lhr(5000, 1000, 0, 0.6) as Record<string, unknown>;
        delete (partial.audits as Record<string, unknown>)['speed-index'];
        const dir = makeDir({ 'lhr-1.json': JSON.stringify(partial) });
        const { code, out } = run(dir);
        expect(code).toBe(0);
        expect(out).toContain('| Speed Index | n/a | 0 |');
    });

    it('appends the table to GITHUB_STEP_SUMMARY when the runner provides one', () => {
        const dir = makeDir({ 'lhr-1.json': JSON.stringify(lhr(4000, 900, 0, 0.7)) });
        const summary = path.join(dir, 'summary.md');
        const { code } = run(dir, { GITHUB_STEP_SUMMARY: summary });
        expect(code).toBe(0);
        expect(fs.readFileSync(summary, 'utf8')).toContain('| LCP | 4000 ms | 1 |');
    });

    it('never fails the build when the summary path is unwritable', () => {
        const dir = makeDir({ 'lhr-1.json': JSON.stringify(lhr(4000, 900, 0, 0.7)) });
        const { code, out } = run(dir, { GITHUB_STEP_SUMMARY: '/proc/nonexistent/x' });
        expect(code).toBe(0);
        expect(out).toContain('| LCP | 4000 ms | 1 |');
    });
});
