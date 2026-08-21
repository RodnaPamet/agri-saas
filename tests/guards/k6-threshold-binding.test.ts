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
 * 3. Every `checks{...}` threshold carries a **`count>0`** clause. That is
 *    the part that survives being wrong: k6 is not installable in this dev
 *    loop, so the rename to `check_group` could not be executed locally.
 *    `count>0` makes the next nightly go RED if the tag still fails to bind,
 *    rather than quietly green again. A gate that cannot distinguish
 *    "everything passed" from "nothing ran" is the bug, not the tag name.
 *
 * This guard reads source text, so it proves the shape and not the runtime.
 * The runtime proof is `count>0` firing in CI — which is exactly why rule 3
 * is here rather than left to reviewer discipline.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOAD_DIR = path.resolve(__dirname, '..', '..', 'tests', 'load');

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

        // 3. A checks{...} threshold with no count>0 floor.
        const thr = code.match(/['"`](checks\{[^}]*\})['"`]\s*:\s*\[([^\]]*)\]/);
        if (thr && !/count\s*>\s*0/.test(thr[2])) {
            problems.push(
                `${at} — \`${thr[1]}\` has no \`count>0\`; with zero samples k6 passes it vacuously`,
            );
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
export const options = {
    thresholds: {
        'checks{check_group:login_ok}': ['rate>0.99', 'count>0'],
    },
};
check(r, { 'login 200': (x) => x.status === 200 }, { check_group: 'login_ok' });
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

        it('rejects a checks threshold with no count>0 floor', () => {
            // The regression that matters most: someone "tidies away" the
            // count clause because it looks redundant next to a rate.
            const src = GOOD.replace("['rate>0.99', 'count>0']", "['rate>0.99']");
            const out = findThresholdBindingProblems('probe.js', src);
            expect(out).toHaveLength(1);
            expect(out[0]).toContain('vacuously');
        });

        it('does not trip on a comment that quotes the broken form', () => {
            // These guards' own docblocks name `checks{check:...}` to explain
            // it. A grep-shaped detector would flag its own documentation.
            const src = `${GOOD}\n// was: 'checks{check:login_ok}': ['rate>0.99'],\n`;
            expect(findThresholdBindingProblems('probe.js', src)).toEqual([]);
        });
    });
});
