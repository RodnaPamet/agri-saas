/**
 * k6 thresholds must be able to bind to data (issues #660, #653).
 *
 * ── The defect this exists for ───────────────────────────────────────
 *
 * `auth.js` and `lists.js` each declared correctness gates like
 *
 *     'checks{check:login_ok}': ['rate>0.99']
 *
 * and tagged the corresponding `check()` call with `{ check: 'login_ok' }`.
 *
 * **`check` is a tag k6 sets itself**, to the individual check's *name*
 * (`'login 200'`, `'evidence is JSON'`, …). A user tag with the same key does
 * not survive, so those sub-metrics never received a single sample — and **k6
 * passes a threshold that has no samples.**
 *
 * Measured across eleven consecutive nightly artifacts (2026-08-10 → 08-20):
 *
 *     metric                          samples/run   threshold
 *     checks (parent, auth.js)              2,340   —
 *     checks{check:csrf_ok}                     0   ok
 *     checks{check:login_ok}                    0   ok
 *     checks{check:session_ok}                  0   ok
 *     checks (parent, lists.js)       12,000–22,000 —
 *     checks{check:evidence_ok}                 0   ok
 *
 * Four correctness gates, 44 threshold evaluations, **never once evaluated
 * against data** — green for their entire life. This is the load-tier
 * instance of CLAUDE.md's "green is not the same as executed".
 *
 * ── What this guard enforces ─────────────────────────────────────────
 *
 * 1. No load script tags a `check()` with the reserved key `check`.
 * 2. No threshold is keyed on `checks{check:...}`.
 * 3. Every threshold uses an aggregation its metric's TYPE supports.
 *
 * ── Rule 3 replaces one that was actively harmful ─────────────────────
 *
 * The first version of rule 3 required a `count>0` clause on every
 * `checks{...}` threshold. **`checks` is a Rate, and k6 permits only `rate`
 * on a Rate**, so that made every load script a hard parse error: k6 exited
 * at init and the Load Smoke job never ran. It took main red across three
 * consecutive merges, and nothing noticed, because the job is
 * `if: github.event_name == 'push'` and structurally cannot run on a PR.
 *
 * The reasoning behind that rule was still right — a Rate submetric with no
 * samples DOES pass vacuously. What was wrong was the instrument. Measured
 * with k6 v1.4.0 locally:
 *
 *     checks{check_group:never_tagged}   ✓ 'rate>0.99'  rate=0.00%
 *     check_runs{check_group:unbound}    ✗ 'count>0'    count=0
 *
 * A zero-percent rate passing a >99% gate, beside a Counter submetric that
 * correctly fails. The difference is structural, not luck: a submetric is
 * created lazily from the threshold, so with no matching samples there is no
 * sink and k6 skips it — whereas a custom metric is registered at INIT, so
 * its sink always exists with a defined value. Hence the floor now lives on
 * a `check_runs` **Counter**, not on `checks`.
 *
 * The aggregation table below was MEASURED against k6 v1.4.0, not recalled —
 * one probe script per (type, method) pair. Note `Trend` rejects `count`,
 * which is a common mistaken belief.
 *
 * This guard reads source text, so it proves the shape and not the runtime.
 * It runs on PRs, which is the point: Load Smoke cannot.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOAD_DIR = path.resolve(__dirname, '..', '..', 'tests', 'load');

/**
 * Which aggregation methods k6 accepts per metric type.
 *
 * MEASURED against k6 v1.4.0 — one probe script per (type, method) pair, run
 * locally — not recalled from documentation. `Trend` rejecting `count` is the
 * entry most likely to be assumed otherwise.
 */
const ALLOWED_AGGREGATIONS: Readonly<Record<string, readonly string[]>> = {
    Counter: ['count', 'rate'],
    Gauge: ['value'],
    Rate: ['rate'],
    Trend: ['avg', 'med', 'min', 'max', 'p()'],
};

/**
 * k6's built-in metrics, by type. Only the ones these scripts threshold on —
 * an unknown metric is SKIPPED rather than guessed at, so the guard cannot
 * invent a violation.
 */
const BUILTIN_METRIC_TYPES: Readonly<Record<string, string>> = {
    checks: 'Rate',
    http_req_failed: 'Rate',
    http_req_duration: 'Trend',
    http_req_waiting: 'Trend',
    http_req_connecting: 'Trend',
    iteration_duration: 'Trend',
    http_reqs: 'Counter',
    iterations: 'Counter',
    data_sent: 'Counter',
    data_received: 'Counter',
    dropped_iterations: 'Counter',
    vus: 'Gauge',
    vus_max: 'Gauge',
};

/**
 * Every metric this source declares, by type: `new Counter('foo')` → Counter.
 * Merged over the built-ins so a script-local metric wins.
 */
export function resolveMetricTypes(source: string): Map<string, string> {
    const types = new Map<string, string>(Object.entries(BUILTIN_METRIC_TYPES));
    const re = /new\s+(Counter|Gauge|Rate|Trend)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) types.set(m[2], m[1]);
    return types;
}

/** k6 sets these tag keys itself; a user tag with the same key is dropped. */
const RESERVED_TAG_KEYS = ['check', 'group', 'scenario'] as const;

function loadScripts(): string[] {
    return fs
        .readdirSync(LOAD_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.js'))
        .map((e) => path.join(LOAD_DIR, e.name));
}

/** Pure detector, so the mutation proofs below can feed it synthetic files. */
export function findThresholdBindingProblems(
    displayPath: string,
    source: string,
): string[] {
    const problems: string[] = [];
    const metricTypes = resolveMetricTypes(source);
    const lines = source.split('\n');

    lines.forEach((line, i) => {
        const at = `${displayPath}:${i + 1}`;
        // Strip line comments so the docblocks above (which quote the broken
        // form on purpose) do not trip the guard describing them.
        const code = line.replace(/\/\/.*$/, '');

        // 1. A check() tagged with a reserved key.
        for (const key of RESERVED_TAG_KEYS) {
            const re = new RegExp(`\\{\\s*${key}\\s*:\\s*['"\`]`);
            if (re.test(code)) {
                problems.push(
                    `${at} — tags a check with the reserved k6 key \`${key}\`; it will be silently dropped`,
                );
            }
        }

        // 2. A threshold keyed on the reserved `check` tag.
        if (/['"`]checks\{check:/.test(code)) {
            problems.push(
                `${at} — threshold keyed on \`checks{check:…}\`; that sub-metric never receives samples`,
            );
        }

        // 3. An aggregation the metric's TYPE does not support.
        const thr = code.match(/['"`]([a-z_][a-z0-9_]*)(\{[^}]*\})?['"`]\s*:\s*\[([^\]]*)\]/i);
        if (thr) {
            const metric = thr[1];
            const type = metricTypes.get(metric);
            if (type) {
                const allowed = ALLOWED_AGGREGATIONS[type];
                for (const raw of thr[3].split(',')) {
                    const expr = raw.trim().replace(/^['"`]|['"`]$/g, '');
                    if (!expr) continue;
                    const method = expr.match(/^([a-z_]+(?:\(\d+(?:\.\d+)?\))?)/i)?.[1];
                    if (!method) continue;
                    const norm = /^p\(/i.test(method) ? 'p()' : method;
                    if (!allowed.includes(norm)) {
                        problems.push(
                            `${at} — \`${expr}\` on \`${metric}\` (${type}); ` +
                                `k6 supports only [${allowed.join(', ')}] there, and rejects the script at init`,
                        );
                    }
                }
            }
        }
    });

    return problems;
}

describe('k6 threshold binding', () => {
    test('no load script has a threshold that cannot bind to data', () => {
        const scripts = loadScripts();

        // Resolving power: an empty scan would be green for the wrong reason.
        expect(scripts.length).toBeGreaterThanOrEqual(2);

        const problems = scripts.flatMap((f) =>
            findThresholdBindingProblems(
                path.relative(path.resolve(__dirname, '..', '..'), f),
                fs.readFileSync(f, 'utf-8'),
            ),
        );

        expect(problems).toEqual([]);
    });

    test('the scripts really do declare checks{...} thresholds', () => {
        // Without this, rule 3 above would be satisfied by a file that
        // declares no check thresholds at all.
        const declared = loadScripts()
            .map((f) => fs.readFileSync(f, 'utf-8'))
            .join('\n')
            .match(/['"`]checks\{[^}]*\}['"`]\s*:/g);
        expect(declared?.length ?? 0).toBeGreaterThanOrEqual(4);
    });

    describe('findThresholdBindingProblems — mutation proofs', () => {
        const GOOD = `
import { Counter } from 'k6/metrics';
const checkRuns = new Counter('check_runs');
export const options = {
    thresholds: {
        'checks{check_group:login_ok}': ['rate>0.99'],
        'check_runs{check_group:login_ok}': ['count>0'],
    },
};
check(r, { 'login 200': (x) => x.status === 200 }, { check_group: 'login_ok' });
checkRuns.add(1, { check_group: 'login_ok' });
`;

        it('accepts the corrected form', () => {
            expect(findThresholdBindingProblems('probe.js', GOOD)).toEqual([]);
        });

        it('rejects a check tagged with the reserved key', () => {
            const src = GOOD.replace("{ check_group: 'login_ok' }", "{ check: 'login_ok' }");
            const out = findThresholdBindingProblems('probe.js', src);
            expect(out.some((p) => p.includes('reserved k6 key'))).toBe(true);
        });

        it('rejects a threshold keyed on checks{check:…}', () => {
            const src = GOOD.replace('checks{check_group:login_ok}', 'checks{check:login_ok}');
            const out = findThresholdBindingProblems('probe.js', src);
            expect(out.some((p) => p.includes('never receives samples'))).toBe(true);
        });

        it('rejects count>0 on `checks`, the exact form that took CI down', () => {
            // `checks` is a Rate; k6 permits only `rate` there. This shipped
            // and made every load script a hard parse error, so the Load
            // Smoke job exited at init across three merges to main.
            const src = GOOD.replace(
                "'checks{check_group:login_ok}': ['rate>0.99'],",
                "'checks{check_group:login_ok}': ['rate>0.99', 'count>0'],",
            );
            const out = findThresholdBindingProblems('probe.js', src);
            expect(out).toHaveLength(1);
            expect(out[0]).toContain('(Rate)');
            expect(out[0]).toContain('rejects the script at init');
        });

        it('rejects count>0 on a Trend — the belief most likely to be wrong', () => {
            const src = `
import { Trend } from 'k6/metrics';
const t = new Trend('login_ms');
export const options = { thresholds: { 'login_ms': ['p(95)<500', 'count>0'] } };
`;
            const out = findThresholdBindingProblems('probe.js', src);
            expect(out.some((p) => p.includes('(Trend)'))).toBe(true);
        });

        it('accepts every aggregation each type really supports', () => {
            // The positive half. Without it the rule could be satisfied by a
            // detector that rejects everything.
            const src = `
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
const c = new Counter('c_m'); const g = new Gauge('g_m');
const r = new Rate('r_m'); const t = new Trend('t_m');
export const options = { thresholds: {
    'c_m': ['count>0', 'rate>1'],
    'g_m': ['value>0'],
    'r_m': ['rate>0.99'],
    't_m': ['avg<100', 'med<100', 'min>0', 'max<999', 'p(95)<500'],
} };
`;
            expect(findThresholdBindingProblems('probe.js', src)).toEqual([]);
        });

        it('skips a metric it cannot type, rather than guessing', () => {
            const src = `export const options = { thresholds: { 'some_plugin_metric': ['count>0'] } };`;
            expect(findThresholdBindingProblems('probe.js', src)).toEqual([]);
        });

        it('does not trip on a comment that quotes the broken form', () => {
            // These guards' own docblocks name `checks{check:...}` to explain
            // it. A grep-shaped detector would flag its own documentation.
            const src = `${GOOD}\n// was: 'checks{check:login_ok}': ['rate>0.99'],\n`;
            expect(findThresholdBindingProblems('probe.js', src)).toEqual([]);
        });
    });
});
