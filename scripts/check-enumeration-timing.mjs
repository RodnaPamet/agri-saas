#!/usr/bin/env node
/**
 * Gate the registration-enumeration timing property on the statistic it is
 * actually about: the separation between the three branch MEDIANS (#1411).
 *
 * ## Why this exists outside the k6 script
 *
 * k6 thresholds are PER METRIC. The quantity that matters —
 * `max(median_i) − min(median_i)` across `enum_branch_{new,pending,taken}_ms`
 * — spans three metrics, so it cannot be written as a threshold at all. The
 * k6 script therefore gates `med(enum_paired_spread_ms)`, which is the same
 * property in its pairwise form and catches the same defect; this checker adds
 * the tighter, more direct statistic on top. Both are live and neither
 * replaces the other.
 *
 * ## Why the statistic changed
 *
 * Measured on main `66688b0a1` (2026-10-08): branch medians 330.2 / 326.1 /
 * 326.0 ms — within 4.2 ms, zero shape mismatches — and the old gate,
 * `p(95)` of the per-trial paired |Δ|, read 78.4 ms against a 50 ms band with
 * a max of 267.5 ms. A 267 ms tail beside a 4.2 ms median separation is a
 * noise distribution. p(95) of the pairwise difference of two
 * identically-distributed samples measures the per-trial variance of a shared
 * CI runner, which is not the quantity this test is about, and it had no
 * margin left for it: 1 in 5 main runs went red while the property held.
 *
 * The defect this exists to catch — a branch that skips `hashPassword` — moves
 * EVERY sample by ~400 ms. So a central statistic reads it with a huge margin
 * (4.2 vs 400 against a band of 50) and a 95th percentile only adds the tail.
 *
 * ## What it refuses, and why absence is not a pass
 *
 * An absent or non-finite median is NOT a separation of zero. A run where a
 * branch never reported would otherwise score a perfect 0 ms and pass — the
 * empty selection reading as success, which is the defect class this repo has
 * shipped most often. Same for a missing or unparseable results file: that is
 * a broken instrument, not a clean run.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RESULTS = process.argv[2] ?? 'tests/load/results/enumeration-timing.json';
const BAND_MS = parseFloat(process.env.MAX_SPREAD_MS ?? '50');

/** The three branch medians, in the order the summary prints them. */
const BRANCHES = [
    ['enum_branch_new_ms', 'A (new)'],
    ['enum_branch_pending_ms', 'B (mid-signup)'],
    ['enum_branch_taken_ms', 'C (taken)'],
];

/**
 * Exported for the test, which must be able to drive every branch of this
 * logic without a k6 run. Returns `{ ok, reason, separation, medians }`.
 */
export function evaluate(metrics, bandMs = BAND_MS) {
    if (!metrics || typeof metrics !== 'object') {
        return { ok: false, reason: 'no metrics object in the results file', separation: NaN, medians: [] };
    }

    const medians = BRANCHES.map(([key, label]) => ({
        key,
        label,
        med: metrics[key]?.values?.med,
    }));

    const missing = medians.filter((m) => typeof m.med !== 'number' || !Number.isFinite(m.med));
    if (missing.length > 0) {
        // Absence is a broken instrument, never a pass. A run missing a branch
        // would otherwise compute a separation of 0 and sail through.
        return {
            ok: false,
            reason:
                `${missing.length} of ${BRANCHES.length} branch medians are absent or non-finite ` +
                `(${missing.map((m) => m.key).join(', ')}). A branch that did not report is not a ` +
                `separation of zero — the run did not measure what this gates.`,
            separation: NaN,
            medians,
        };
    }

    const values = medians.map((m) => m.med);
    const separation = Math.max(...values) - Math.min(...values);

    // A shape mismatch means the three responses were not byte-identical, at
    // which point the timing figure is beside the point. k6 already gates this
    // at 0; re-checked here so this script fails on its own rather than
    // passing a run whose uniformity had already broken.
    const mismatches = metrics['enum_shape_mismatch']?.values?.count ?? 0;
    if (mismatches > 0) {
        return {
            ok: false,
            reason: `${mismatches} shape mismatch(es): the three branches were not byte-identical, so the timing number says nothing.`,
            separation,
            medians,
        };
    }

    if (separation >= bandMs) {
        return {
            ok: false,
            reason:
                `median separation ${separation.toFixed(1)} ms is outside the ${bandMs} ms band. ` +
                `The three registration branches are distinguishable by timing, which is an ` +
                `account-enumeration oracle. Check that hashPassword still runs on EVERY branch, ` +
                `including the two that discard the result.`,
            separation,
            medians,
        };
    }

    return { ok: true, reason: null, separation, medians };
}

/** Separated from `evaluate` so a test can assert on the text it prints. */
export function render(result, bandMs = BAND_MS) {
    const lines = ['', '── enumeration-timing gate (#1411) ──'];
    for (const m of result.medians) {
        const v = typeof m.med === 'number' && Number.isFinite(m.med) ? `${m.med.toFixed(1)} ms` : 'ABSENT';
        lines.push(`  branch ${m.label.padEnd(15)}: ${v}`);
    }
    const sep = Number.isFinite(result.separation) ? `${result.separation.toFixed(1)} ms` : 'n/a';
    lines.push(`  median separation      : ${sep}  (band ${bandMs} ms)`);
    lines.push(result.ok ? '  verdict                : PASS' : `  verdict                : FAIL — ${result.reason}`);
    lines.push('');
    return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────
// The canonical main-module check, not a filename-suffix guess: comparing
// `import.meta.url` against `pathToFileURL(process.argv[1])` is exact, where
// an `endsWith` on the basename would also fire for a different file of the
// same name somewhere else on the path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(RESULTS, 'utf8'));
    } catch (err) {
        // An unreadable results file is the instrument failing, and reporting
        // it as a pass is how a gate goes dark. Exit non-zero.
        console.error(
            `\n── enumeration-timing gate (#1411) ──\n` +
                `  FAIL — could not read ${RESULTS}: ${err.message}\n` +
                `  The k6 run writes this from handleSummary. A missing file means the run did ` +
                `not finish, not that the property holds.\n`,
        );
        process.exit(1);
    }
    const result = evaluate(parsed.metrics, BAND_MS);
    const out = render(result, BAND_MS);
    if (result.ok) {
        console.log(out);
        process.exit(0);
    }
    console.error(out);
    process.exit(1);
}
