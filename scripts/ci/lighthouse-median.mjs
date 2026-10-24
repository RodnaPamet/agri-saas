#!/usr/bin/env node
/**
 * Print the median Lighthouse metrics from a `.lighthouseci` run.
 *
 * WHY THIS EXISTS (#796)
 *
 * `lighthouserc.json` sets `numberOfRuns: 5` (raised from 3 when two 3-run
 * medians of the SAME commit came back 296 ms apart on `/f/{handle}`) and
 * writes `lhr-<ts>.json` per run
 * into `.lighthouseci`. Nothing ever read them. The workflow's upload step
 * globbed `.lighthouseci/*`, but `.lighthouseci` is a HIDDEN directory and
 * `actions/upload-artifact@v7` defaults `include-hidden-files: false` — so the
 * whole glob was excluded and the artifact contained exactly one file,
 * `tmp/app.log`. Measured on run 33839332043: 12,312 bytes, one entry.
 *
 * The consequence is not "we lacked a nice chart". The repo has a `Gate:
 * Lighthouse mobile budget` that PASSES OR FAILS against thresholds, and no
 * way to see the number behind the verdict. So any performance change — the
 * font preload #796 actually asks for — could not be evidenced either way.
 * You cannot run a before/after on a number nobody can read.
 *
 * NOT A GATE. Lighthouse is absent from main's required status checks
 * (Build, Lint, Typecheck, E2E, Security, CodeQL SAST, Docker Build & Scan,
 * Test, Coverage). This restores VISIBILITY of a number; it adds no
 * enforcement, and it deliberately exits 0 even with nothing to report so it
 * cannot turn an unrelated failure red.
 *
 * VISIBLE NON-EXECUTION. Exiting 0 on an empty directory would reproduce the
 * defect one level up — silence that reads as success. So the empty case
 * prints a `::warning::` annotation naming what it did not find. Same
 * principle as the RLS guardrail's execution-status banner.
 *
 * ONE TABLE PER URL. `lighthouserc.json` collects more than one page as of
 * #1814, and medians from different pages must never share a row — see
 * `groupByUrl`.
 *
 * Per-METRIC median, not Lighthouse's "median run". With 3 runs they usually
 * coincide; where they differ, a per-metric median is the more honest summary
 * of a noisy metric like TBT (which `lighthouserc.json` documents as varying
 * 900-2630ms run to run on shared CI runners).
 *
 * Usage:  node scripts/ci/lighthouse-median.mjs [dir]     (default .lighthouseci)
 */
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** lhci writes exactly this shape — @lhci/utils saved-reports.js: /^lhr-\d+\.json$/ */
const LHR_REGEX = /^lhr-\d+\.json$/;

const METRICS = [
    { key: 'largest-contentful-paint', label: 'LCP', unit: 'ms' },
    { key: 'first-contentful-paint', label: 'FCP', unit: 'ms' },
    { key: 'speed-index', label: 'Speed Index', unit: 'ms' },
    { key: 'total-blocking-time', label: 'TBT', unit: 'ms' },
    { key: 'cumulative-layout-shift', label: 'CLS', unit: '' },
];

export function median(values) {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Reports split by the url they measured — one group per page.
 *
 * Added when P6.5 (#1814) made this a MULTI-url run. Before that
 * `lighthouserc.json` collected only `/login`, so the script medianed every
 * report together and labelled the table with `reports[0]`'s url, which was
 * correct by accident.
 *
 * With two urls that produced the exact defect this script exists to prevent:
 * the first multi-url run reported "6 run(s) — .../login" with an LCP of
 * 4960 ms, a figure that was three runs of a slow page and three of a fast
 * one averaged together and then attributed to one of them. The gate itself
 * was fine — `assertMatrix` evaluates per url — so a number nobody could
 * trust was presented beside a verdict that was.
 */
export function groupByUrl(reports) {
    const groups = new Map();
    for (const r of reports) {
        const url = r?.finalDisplayedUrl ?? r?.finalUrl ?? '(unknown url)';
        if (!groups.has(url)) groups.set(url, []);
        groups.get(url).push(r);
    }
    return groups;
}

export function summarise(reports) {
    const rows = METRICS.map(({ key, label, unit }) => {
        const values = reports
            .map((r) => r?.audits?.[key]?.numericValue)
            .filter((v) => typeof v === 'number' && Number.isFinite(v));
        return {
            label,
            unit,
            value: median(values),
            samples: values.length,
            // Carried alongside the median, because the median ALONE cannot
            // tell a reader whether a verdict near the bound means anything —
            // see `renderSpread`.
            min: values.length ? Math.min(...values) : null,
            max: values.length ? Math.max(...values) : null,
        };
    });
    const scores = reports
        .map((r) => r?.categories?.performance?.score)
        .filter((v) => typeof v === 'number' && Number.isFinite(v));
    return { rows, score: median(scores), scoreSamples: scores.length, runs: reports.length };
}

/**
 * The run-to-run SPREAD, under the table — #2207.
 *
 * ## Why the median alone is not enough
 *
 * The `Gate: Lighthouse mobile budget` turns one of these medians into a
 * pass/fail, and on `/f/{handle}` the headroom is about the size of the
 * instrument's own variation. #2207 records the budget flipping
 * pass -> fail -> pass across three commits of one PR whose rendered page was
 * byte-identical; the measurement that settled it was that the middle commit
 * changed one line in a test file.
 *
 * A median with no spread beside it cannot distinguish those two worlds, and
 * this table was the one place a reader looked. Measured on `/f/lighthouse` in
 * one 5-run job: LCP values 2066, 4105, 4122, 4124, 4282 — a 2,215 ms spread
 * against a 3,800 ms bound. The median was 4,122 ms, and the same page on
 * `main` medianed 3,365 ms the same evening.
 *
 * ## Why a LINE and not two more columns
 *
 * `tests/unit/ci/lighthouse-median.test.ts` pins eleven exact table rows, and
 * those assertions are real controls over the median arithmetic. Widening the
 * table would have rewritten all of them to match new output, which is the
 * shape of change that quietly removes a test's teeth. A line below the table
 * adds the information and leaves every existing assertion measuring what it
 * was written to measure.
 *
 * Spread is reported for metrics with at least TWO samples. With one sample
 * there is no run-to-run variation to report, and printing `0 ms` would state
 * a precision the run never established.
 */
export function renderSpread(summary) {
    const fmtv = (v, unit) => (unit === 'ms' ? `${Math.round(v)}` : v.toFixed(3));
    const parts = summary.rows
        .filter((r) => r.samples >= 2 && r.min !== null && r.max !== null)
        .map(
            (r) =>
                `${r.label} ${fmtv(r.min, r.unit)}-${fmtv(r.max, r.unit)}`
                + `${r.unit === 'ms' ? ' ms' : ''} (spread ${fmtv(r.max - r.min, r.unit)}`
                + `${r.unit === 'ms' ? ' ms' : ''})`,
        );
    if (parts.length === 0) {
        // Said out loud rather than omitted: a reader who knows the line exists
        // must not read its absence as "the runs agreed".
        return '_Spread: not reported — fewer than 2 samples per metric._';
    }
    return (
        `_Spread, min-max: ${parts.join(' · ')}._\n\n`
        + '_A budget breach smaller than the spread above cannot be separated from runner'
        + ' noise by this run (#2207)._'
    );
}

function render(summary, url) {
    const fmt = (row) =>
        row.value === null
            ? 'n/a'
            : row.unit === 'ms'
              ? `${Math.round(row.value)} ms`
              : row.value.toFixed(3);
    const lines = [
        `### Lighthouse median — ${summary.runs} run(s)${url ? ` — ${url}` : ''}`,
        '',
        '| metric | median | samples |',
        '| --- | ---: | ---: |',
        ...summary.rows.map((r) => `| ${r.label} | ${fmt(r)} | ${r.samples} |`),
        `| Performance score | ${
            summary.score === null ? 'n/a' : Math.round(summary.score * 100)
        } | ${summary.scoreSamples} |`,
        '',
        renderSpread(summary),
        '',
        '_Diagnostic only — Lighthouse is not a required status check._',
    ];
    return lines.join('\n');
}

function main() {
    const dir = process.argv[2] ?? '.lighthouseci';

    if (!existsSync(dir)) {
        console.log(`::warning::lighthouse-median: no ${dir} directory — nothing was measured this run.`);
        return;
    }
    const files = readdirSync(dir).filter((f) => LHR_REGEX.test(f));
    if (files.length === 0) {
        // Loud rather than silent: an empty report set and a healthy one must
        // not look the same, which is the whole reason this script exists.
        console.log(
            `::warning::lighthouse-median: ${dir} exists but holds no lhr-*.json — nothing was measured this run.`,
        );
        return;
    }

    const reports = [];
    let unreadable = 0;
    for (const f of files) {
        try {
            reports.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
        } catch {
            unreadable += 1;
        }
    }
    if (unreadable > 0) {
        // Counted, never silently dropped — a partially-read run must not be
        // presented as a complete one.
        console.log(`::warning::lighthouse-median: ${unreadable} of ${files.length} report(s) unreadable.`);
    }

    // One table per url, ordered by url so the output is stable across runs
    // rather than following whatever order the filesystem returned.
    const groups = [...groupByUrl(reports).entries()].sort(([a], [b]) => a.localeCompare(b));
    const out = groups.map(([url, group]) => render(summarise(group), url)).join('\n\n');
    console.log(out);

    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) {
        try {
            appendFileSync(stepSummary, `${out}\n`);
        } catch {
            // A summary-write failure must never fail the build; the numbers
            // are already on stdout.
        }
    }
}

// Only run when invoked directly, so the pure helpers stay importable.
if (process.argv[1] && process.argv[1].endsWith('lighthouse-median.mjs')) main();
