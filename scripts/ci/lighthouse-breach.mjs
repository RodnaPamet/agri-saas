#!/usr/bin/env node
/**
 * Say what the budget actually measured when it fails — #2207.
 *
 * ## The message this replaces
 *
 * The gate's budget-failure branch annotates:
 *
 *     Lighthouse BUDGET failed (attempt 1/3, exit 1).
 *     Not retried — this is a verdict about the page, not a lost measurement.
 *
 * The "not retried" policy behind it is right: retrying a verdict until it
 * passes is not a budget. But the sentence asserts a CAUSE — that the page
 * regressed — which a single 5-run median on a shared runner cannot establish,
 * and the annotation is the only thing most readers see. #2207 records the
 * cost: the budget flipped pass -> fail -> pass across three commits of one PR
 * whose rendered page was byte-identical, and the investigation started by
 * looking for a way a font change had slowed `/f/` — which it had not.
 *
 * ## What this prints instead
 *
 * The numbers that are already in the lhci log, in the annotation where they
 * can be read: the metric, its median, the bound, the breach, and the
 * run-to-run spread. Then one factual comparison — breach against spread —
 * because that is the thing a reader needs and cannot get from a verdict:
 *
 *     LCP: 4122 ms vs bound <=3800 ms, over by 322 ms. 5-run spread 2215 ms
 *     (2066-4282 ms). The spread is 6.9x the breach, so this run cannot
 *     separate a regression from instrument noise.
 *
 * ## It is a REPORTER, not a gate
 *
 * It does not change the verdict and it never fails: the gate's own exit code
 * decides the job, and a reporter that could turn a pass red — or mask a
 * failure with its own crash — would be a worse bug than the message it fixes.
 * Every path here exits 0, and an unparseable log prints a warning saying so
 * rather than inventing figures, which is the visible-non-execution rule
 * `lighthouse-median.mjs` already follows.
 *
 * Whether a breach SMALLER than the spread should still fail is a policy
 * question and #2207 asks for a ruling on it. This answers only the half that
 * needs no ruling: the reader is told what was measured.
 *
 * Usage:  node scripts/ci/lighthouse-breach.mjs /tmp/lhci.log
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Normalise a line before matching: drop the ANSI colour codes, and drop a
 * leading ISO-8601 timestamp if one is present.
 *
 * **ANSI**, because lhci colourises its assertion table and the escape codes
 * sit BETWEEN the words you want to match — the same trap that made a
 * `grep -c 'error TS'` read 0 against 39 real errors. Written as `\u001b`
 * rather than a literal escape byte: a control character in a source file is
 * invisible in every diff and review that would otherwise catch it.
 *
 * **Timestamps**, because the gate feeds this `/tmp/lhci.log`, which has none,
 * but `gh api .../actions/jobs/<id>/logs` prefixes every line with one — and
 * downloading a past failure's log is exactly how a human re-runs this script
 * to see what a red run would have said. Measured: without this, the
 * timestamp is consumed by the header pattern, the metric parses as the tick
 * glyph and every block is then discarded for having no bound. It failed
 * loudly rather than lying, but it failed on the one input a reader would
 * reach for.
 */
export const normalise = (s) =>
    s.replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/gm, '');

/** `expected: <=3800` / `found: 4121.923` / `all values: 1, 2, 3` */
const EXPECTED = /^\s*expected:\s*([<>]=?)\s*([\d.]+)\s*$/;
const FOUND = /^\s*found:\s*([\d.]+)\s*$/;
const ALL_VALUES = /^\s*all values:\s*(.+?)\s*$/;
/**
 * The row heading, for a FAILURE or a WARNING — #2207, and the distinction is
 * the whole point of this patch.
 *
 * lhci prints both levels in one table:
 *
 *     X   largest-contentful-paint failure for maxNumericValue assertion
 *           expected: <=3800
 *              found: 4133.156
 *         all values: 4027.303, 4170.728, 4124.582, 4142.91, 4133.156
 *     !   categories.performance warning for minScore assertion
 *           expected: >=0.8
 *              found: 0.77
 *         all values: 0.73, 0.76, 0.77, 0.78, 0.78
 *
 * The first version matched only `failure for`, so the WARNING never started a
 * block and its `expected`/`found`/`all values` overwrote the failure's.
 * Measured on run 40096890340: the annotation read
 * `largest-contentful-paint: 0.770 vs bound >=0.800` — the failure's name
 * carrying the warning's numbers — and it inverted the verdict. The real
 * figures were 4133 ms against 3800 with a 143 ms spread, so the breach was
 * 2.3x the spread; what it printed said the spread was 1.7x the breach and the
 * run could not tell a regression from noise.
 *
 * The metric is `(.+?)` rather than `\S+` because a warning's subject can be
 * several words, and a name this cannot parse is worse than useless — it gets
 * attributed to whatever block came before.
 */
const HEADER = /^\s*\S*\s*(.+?)\s+(failure|warning) for\s+(\S+)\s+assertion\s*$/;

/**
 * Parse the failed-assertion blocks out of an lhci `assert` log.
 *
 * Deliberately tolerant: a block missing `all values` (lhci omits it when an
 * assertion has a single sample) still yields its bound and value, and an
 * unrecognised line is skipped rather than ending the block. The alternative —
 * a strict grammar over another tool's human-readable output — fails closed on
 * a cosmetic upstream change, in a code path that only ever runs when
 * something is already wrong.
 */
export function parseBreaches(text) {
    const lines = normalise(text).split('\n');
    const breaches = [];
    let cur = null;
    for (const line of lines) {
        const header = HEADER.exec(line);
        if (header) {
            if (cur) breaches.push(cur);
            cur = {
                metric: header[1],
                level: header[2],
                assertion: header[3],
                values: [],
            };
            continue;
        }
        if (!cur) continue;
        const expected = EXPECTED.exec(line);
        if (expected) {
            /**
             * A SECOND `expected:` inside one block means a header this parser
             * did not recognise sat between them. Start a fresh block rather
             * than overwrite, and mark it unnamed — the safety net behind the
             * header pattern above, because the failure mode is not a missing
             * line but a correct line attributed to the wrong metric.
             */
            if (Number.isFinite(cur.bound)) {
                breaches.push(cur);
                cur = { metric: '(unnamed assertion)', level: 'unknown', values: [] };
            }
            cur.comparator = expected[1];
            cur.bound = Number(expected[2]);
            continue;
        }
        const found = FOUND.exec(line);
        if (found) {
            cur.found = Number(found[1]);
            continue;
        }
        const all = ALL_VALUES.exec(line);
        if (all) {
            cur.values = all[1]
                .split(',')
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v));
        }
    }
    if (cur) breaches.push(cur);
    return breaches.filter((b) => Number.isFinite(b.bound) && Number.isFinite(b.found));
}

/**
 * Only the FAILURES, which are what the gate's exit code is about.
 *
 * A warning is real information and is counted in the output, but it must
 * never be the headline of a message explaining why the job failed — that is
 * the defect this split exists to prevent.
 */
export function failuresOnly(breaches) {
    return breaches.filter((b) => b.level !== 'warning');
}

/** ms for a timing metric, 3 decimals for a unitless one like CLS. */
const fmt = (v, ms) => (ms ? `${Math.round(v)} ms` : v.toFixed(3));

/**
 * One sentence per breach.
 *
 * The spread comparison is stated only when there IS a spread to state: with
 * fewer than two samples there is no run-to-run variation measured, and
 * printing "spread 0 ms" would read as a precision claim the run never made.
 */
export function describe(breach) {
    // Keyed off the BOUND rather than a metric list, so a metric added to
    // `lighthouserc` later formats correctly without being enumerated here. A
    // sub-10 bound is not a millisecond budget — CLS is the only unitless
    // metric in the current matrix and its bound is 0.1.
    const ms = breach.bound >= 10;
    const over = Math.abs(breach.found - breach.bound);
    const head = `${breach.metric}: ${fmt(breach.found, ms)} vs bound ${
        breach.comparator ?? '<='
    }${fmt(breach.bound, ms)}, over by ${fmt(over, ms)}.`;

    if (breach.values.length < 2) return head;

    const min = Math.min(...breach.values);
    const max = Math.max(...breach.values);
    const spread = max - min;
    const parts = [
        head,
        `${breach.values.length}-run spread ${fmt(spread, ms)} `
            + `(${ms ? Math.round(min) : min.toFixed(3)}-${fmt(max, ms)}).`,
    ];
    if (over > 0 && spread > 0) {
        const ratio = spread / over;
        parts.push(
            ratio >= 1
                ? `The spread is ${ratio.toFixed(1)}x the breach, so this run cannot separate a`
                  + ' regression from instrument noise.'
                : `The breach is ${(1 / ratio).toFixed(1)}x the spread, so it is larger than this`
                  + " page's measured run-to-run variation.",
        );
    }
    return parts.join(' ');
}

function main() {
    const logPath = process.argv[2];
    if (!logPath || !existsSync(logPath)) {
        console.log(
            `::warning::lighthouse-breach: no log at ${logPath ?? '(no path given)'} —`
                + ' the budget failure is reported without its numbers.',
        );
        return;
    }
    let breaches = [];
    try {
        breaches = parseBreaches(readFileSync(logPath, 'utf8'));
    } catch (err) {
        console.log(`::warning::lighthouse-breach: could not read ${logPath}: ${err.message}`);
        return;
    }
    const failures = failuresOnly(breaches);
    const warnings = breaches.filter((b) => b.level === 'warning');

    if (breaches.length === 0) {
        // Loud, not silent. The gate reaches this script only because lhci
        // printed an assertion table, so finding no assertion in it means the
        // parse has gone stale — which must not look like a clean run.
        console.log(
            '::warning::lighthouse-breach: the log holds an assertion table but no'
                + ' assertion was parsed from it — the format may have changed.',
        );
        return;
    }

    // FAILURES as errors, warnings as warnings, and never the other way round.
    // A warning's numbers appearing under a failure's name is the defect this
    // separation exists for.
    for (const f of failures) console.log(`::error::Lighthouse budget — ${describe(f)}`);
    for (const w of warnings) {
        console.log(`::warning::Lighthouse budget, a WARNING and not the failure — ${describe(w)}`);
    }
    if (failures.length === 0) {
        console.log(
            `::warning::lighthouse-breach: parsed ${warnings.length} warning(s) and NO failure,`
                + ' yet the gate treated this as a budget failure — the format may have changed.',
        );
    }
}

if (process.argv[1] && process.argv[1].endsWith('lighthouse-breach.mjs')) main();
