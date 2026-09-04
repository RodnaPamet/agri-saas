#!/usr/bin/env node
/**
 * Print the median Lighthouse metrics from a `.lighthouseci` run.
 *
 * WHY THIS EXISTS (#796)
 *
 * `lighthouserc.json` sets `numberOfRuns: 3` and writes `lhr-<ts>.json` per run
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

export function summarise(reports) {
    const rows = METRICS.map(({ key, label, unit }) => {
        const values = reports
            .map((r) => r?.audits?.[key]?.numericValue)
            .filter((v) => typeof v === 'number' && Number.isFinite(v));
        return { label, unit, value: median(values), samples: values.length };
    });
    const scores = reports
        .map((r) => r?.categories?.performance?.score)
        .filter((v) => typeof v === 'number' && Number.isFinite(v));
    return { rows, score: median(scores), scoreSamples: scores.length, runs: reports.length };
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

    const summary = summarise(reports);
    const out = render(summary, reports[0]?.finalDisplayedUrl ?? reports[0]?.finalUrl);
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
