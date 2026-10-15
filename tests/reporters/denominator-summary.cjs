/**
 * Jest reporter: collect the DENOMINATORS guards print, and put them where CI
 * can be read (#1879).
 *
 * ## The defect this exists for
 *
 * Jest's default reporter drops `console.log` output entirely once a run has
 * more than one test suite. Measured on this repo, same file, same assertion:
 * 1 suite prints, 2 suites print nothing, `--verbose` restores it. CI runs
 * `--shard=i/6` over the whole tree with no `--verbose`, so every guard that
 * prints its population printed to nobody — 34 files at the time of writing.
 *
 * That matters because "print the denominator" is a deliberate convention
 * here, and the reason is written into the guards themselves.
 * `social-routes-flag-gated` prints its population precisely because that
 * population is ZERO until P2, and a guard over an empty population is
 * indistinguishable from one that is working. `floor:` arguments still hold —
 * but a floor separates zero from nonzero, not 220 from 6, so the reading that
 * shows a population quietly shrinking while still above its floor was the
 * thing being thrown away.
 *
 * Owner ruling 2026-10-15: the numbers go to the CI step summary rather than
 * into the log via `--verbose`, which would also print every test name on a
 * shard of hundreds of suites.
 *
 * ## The convention it reads
 *
 * A line whose first non-space characters are `[kebab-tag]`. That is what the
 * existing guards already emit (`[audit-details] 2189 src files, 220 logEvent
 * calls scanned`), so no guard has to change for this to work, and a guard
 * that prints something else is simply not collected rather than breaking.
 *
 * ## Why it cannot break a run
 *
 * Every hook is wrapped. A reporter that throws fails the jest process, which
 * would turn an instrumentation change into a CI outage — the exact shape
 * #1269 describes for telemetry inside a committed write. The worst outcome
 * here is that the summary is missing, which is where this started.
 *
 * ## Where it writes
 *
 *   - `GITHUB_STEP_SUMMARY` when GitHub sets it — one section per shard job,
 *     which is correct: each shard ran a different subset.
 *   - `DENOMINATOR_SUMMARY_FILE` when set, so a local run can get the same
 *     reading, and so this file is testable without a GitHub runner.
 *   - nothing otherwise. A local `npx jest <one file>` already prints them.
 */
'use strict';

const fs = require('node:fs');

/** `[kebab-tag] rest of the line` — anchored, so prose is not collected. */
const DENOMINATOR = /^\s*(\[[a-z0-9][a-z0-9-]*\])\s*(.+)$/;

/**
 * Pull denominator lines out of one suite's console buffer.
 *
 * Exported for the test, because a reporter whose extraction is only
 * exercised through a real jest run is the kind of thing that silently stops
 * matching — `a-needle-loses-the-thread-at-a-rename`.
 *
 * @param {Array<{message?: string}>|undefined} buffer
 * @returns {string[]}
 */
function extractDenominators(buffer) {
    if (!Array.isArray(buffer)) return [];
    const out = [];
    for (const entry of buffer) {
        const message = entry && typeof entry.message === 'string' ? entry.message : '';
        // A single console.log can carry several lines.
        for (const line of message.split('\n')) {
            const m = DENOMINATOR.exec(line);
            if (m !== null) out.push(`${m[1]} ${m[2].trim()}`);
        }
    }
    return out;
}

/**
 * The markdown section, or '' when there is nothing to say.
 *
 * Returns '' rather than an empty-section heading on purpose: a "Guard
 * denominators" heading with no rows under it reads as "the guards found
 * nothing", which is the opposite of what an empty collection means (nothing
 * was COLLECTED). Say nothing instead of saying something false.
 *
 * @param {string[]} lines
 * @param {string} [label]
 */
function formatSummary(lines, label) {
    if (lines.length === 0) return '';
    const unique = Array.from(new Set(lines)).sort();
    const heading = label ? `### Guard denominators — ${label}` : '### Guard denominators';
    return [
        heading,
        '',
        `${unique.length} reading(s). A population that shrinks while staying above its floor`,
        'is what these numbers are for — a floor separates zero from nonzero, not 220 from 6.',
        '',
        '```',
        ...unique,
        '```',
        '',
    ].join('\n');
}

class DenominatorSummaryReporter {
    constructor(globalConfig, options) {
        this._lines = [];
        this._label = (options && options.label) || process.env.DENOMINATOR_SUMMARY_LABEL || '';
    }

    onTestResult(_test, testResult) {
        try {
            this._lines.push(...extractDenominators(testResult && testResult.console));
        } catch {
            // Never let instrumentation fail a run.
        }
    }

    onRunComplete() {
        try {
            const body = formatSummary(this._lines, this._label);
            if (body === '') return;
            for (const target of [process.env.GITHUB_STEP_SUMMARY, process.env.DENOMINATOR_SUMMARY_FILE]) {
                if (typeof target === 'string' && target.length > 0) {
                    fs.appendFileSync(target, body, 'utf8');
                }
            }
        } catch {
            // As above.
        }
    }
}

module.exports = DenominatorSummaryReporter;
module.exports.extractDenominators = extractDenominators;
module.exports.formatSummary = formatSummary;
