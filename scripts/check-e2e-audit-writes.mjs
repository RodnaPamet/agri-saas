/**
 * A green E2E run must not have swallowed a single audit write. (#1289)
 *
 * ## The hole this closes
 *
 * The audit extension's failure path is deliberately fail-safe: it logs
 * `audit.write_failed` and swallows, because the business write has already
 * COMMITTED and failing it afterwards would be worse (#1269). The cost of
 * that correct decision is that **at the CI gate a working audit subsystem
 * and a completely dead one are the same observation** — a green E2E run
 * with 275 swallowed failures and a green E2E run with 275 successes look
 * identical.
 *
 * That is not hypothetical. On main `e1acca2c5` the E2E suite attempted 275
 * audit writes and succeeded at NONE of them, across 28 models, on every
 * run, for an unknown period — and every one of those runs was green. #1288
 * fixed the cause (the bundled runtime resolved the chain writer through a
 * `require()` that the production build could not satisfy). Nothing stopped
 * it recurring, which is what this is.
 *
 * ## Why BOTH halves are mandatory
 *
 *   1. `audit.write_failed` occurrences must be **0**. The signal already
 *      discriminates — 275 on `e1acca2c5`, 0 after #1288 — so this needs no
 *      new instrumentation.
 *   2. `pii.middleware_registered` occurrences must be **> 0**. This is the
 *      POSITIVE CONTROL and it is the half that is easy to omit. The count
 *      alone is satisfied perfectly by an unreadable log, an empty log, a
 *      moved path, or a log format that no longer carries server output —
 *      every one of which reports "0 failures" and passes. Without the
 *      control this check fails toward GREEN the moment its input breaks,
 *      which is precisely the defect class it exists to catch.
 *
 * Measured on a real run (37141398281, shard 1, post-#1288): the tee'd step
 * log carries 2 `[WebServer] … pii.middleware_registered` lines from the
 * server Playwright starts and 0 `audit.write_failed`. The marker reaches
 * this file because `playwright.config.ts` sets `stdout: 'pipe'` on
 * `webServer`, so the Next server's pino stream is forwarded into the step's
 * stdout, which `ci.yml` tees. If that ever changes the control goes to 0
 * and this fails LOUDLY rather than passing vacuously.
 *
 * ## Why a log check and not a row count
 *
 * Counting `AuditLog` after the run was considered and is weaker here, for
 * two measured reasons. `prisma/seed.ts:336` creates audit rows, so a bare
 * count is non-zero on a dead subsystem and the check needs a baseline. And
 * the extension is not the only writer — `src/lib/audit-log.ts`,
 * `src/lib/audit/audit-writer.ts` and three retention/lifecycle jobs insert
 * directly — so a positive row delta does not exclude a dead extension,
 * while `audit.write_failed` observes the failure itself.
 *
 * ## Not reachable from jest
 *
 * `tests/integration/audit-write-failure-is-loud.test.ts` and
 * `before-commit-audit-queue.test.ts` both execute the writer and assert
 * rows appear — and both passed throughout the outage, because jest resolves
 * the module fine. The defect lived ONLY in the bundled runtime. So this has
 * to run against the E2E job's own output or it is blind to its own subject.
 * `tests/guards/e2e-audit-writes-not-silently-zero.test.ts` proves this
 * script's LOGIC (including that it fails on an empty log) and that the step
 * is still wired into the job; it cannot prove the CI wiring runs.
 *
 * Usage:  node scripts/check-e2e-audit-writes.mjs <path-to-e2e-step-log>
 */
import { appendFileSync, readFileSync } from 'node:fs';

// ── The two markers, and where they come from ──
// Both are emitted by `src/lib/prisma.ts` (the audit extension's catch, and
// the once-per-process construction diagnostic). The guard test asserts
// these literals still appear in that file, so a rename reddens a test
// instead of silently emptying this check.
const FAILURE_MARKER = 'audit.write_failed';
const CONTROL_MARKER = 'pii.middleware_registered';

// CSI / OSC escapes. Stripped BEFORE any matching: Playwright's `list`
// reporter colours its output, and a colour code landing inside a marker
// would make a present failure unfindable — an invisible zero.
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

const countOccurrences = (haystack, needle) => {
    // indexOf, not a RegExp: both markers contain `.`, which matches any
    // character unescaped — `audit.write_failed` would then also count
    // `auditXwrite_failed`. Occurrences, not lines, so two markers on one
    // line are two.
    let n = 0;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
        n += 1;
    }
    return n;
};

const logPath = process.argv[2];
const failures = [];

if (!logPath) {
    console.error('usage: node scripts/check-e2e-audit-writes.mjs <path-to-e2e-step-log>');
    process.exit(2);
}

// ── Read the log, and treat every way of not reading it as a FAILURE ──
// "I could not look" must never be reported as "nothing is wrong". A
// missing file is the ordinary shape of a moved path or a renamed step.
//
// ONE filesystem call, deliberately. An earlier version `statSync`'d for the
// size and then `readFileSync`'d the same path, which CodeQL flags as
// `js/file-system-race` (TOCTOU) and is right to: the two calls can see
// different files. The size is derived from the bytes actually read instead.
let raw = null;
let readError = null;
try {
    raw = readFileSync(logPath, 'utf8');
} catch (err) {
    readError = err instanceof Error ? err.message : String(err);
}
const sizeRead = raw === null ? 0 : Buffer.byteLength(raw, 'utf8');

if (readError !== null) {
    failures.push(
        `could not read ${logPath}: ${readError}. The E2E step tees its output there; ` +
            `if the path or the step changed, change it in BOTH places. This is a ` +
            `failure and not a pass because an unreadable log reports zero of everything.`,
    );
}

const text = (raw ?? '').replace(ANSI, '');
const lines = text.split('\n');

if (readError === null && text.trim().length === 0) {
    failures.push(
        `${logPath} is empty (${sizeRead} bytes read). An empty log satisfies ` +
            `"zero audit failures" and proves nothing — the suite's output did not reach it.`,
    );
}

const failureCount = countOccurrences(text, FAILURE_MARKER);
const controlCount = countOccurrences(text, CONTROL_MARKER);
const failureLines = lines.filter((l) => l.includes(FAILURE_MARKER));

// ── Half 2 first: the control decides whether half 1 means anything ──
if (controlCount === 0) {
    failures.push(
        `positive control absent: 0 occurrences of "${CONTROL_MARKER}" in ${logPath}. ` +
            `That line is emitted once per process by src/lib/prisma.ts and reaches this log ` +
            `through playwright.config.ts's \`webServer.stdout: 'pipe'\`. Zero of it means the ` +
            `server's output is no longer in this file — so the ${FAILURE_MARKER} count below ` +
            `is not evidence of anything, whatever it says.`,
    );
}

// ── Half 1: the thing the issue is actually about ──
if (failureCount > 0) {
    failures.push(
        `${failureCount} occurrence(s) of "${FAILURE_MARKER}" in the E2E run. Every one is a ` +
            `business write that COMMITTED while its hash-chained audit row was lost, and the ` +
            `suite stayed green because the audit path swallows by design. This is #1289/#1288 ` +
            `recurring: find what broke audit row writes in the BUNDLED runtime (jest will not ` +
            `reproduce it — it resolves the module fine).`,
    );
}

// ── Report: both numbers, side by side, always ──
// The count and its control printed together, so a reader never sees a
// reassuring zero without the figure that says whether it was measured.
const width = 44;
console.log('');
console.log(`  ${'e2e audit-write check'.padEnd(width)} ${'actual'.padStart(8)} ${'required'.padStart(10)}`);
console.log(`  ${'-'.repeat(width)} ${'-'.repeat(8)} ${'-'.repeat(10)}`);
console.log(`  ${`log lines read (${logPath})`.padEnd(width)} ${String(raw === null ? 0 : lines.length).padStart(8)} ${'>0'.padStart(10)}`);
console.log(`  ${`control "${CONTROL_MARKER}"`.padEnd(width)} ${String(controlCount).padStart(8)} ${'>0'.padStart(10)}`);
console.log(`  ${`failures "${FAILURE_MARKER}"`.padEnd(width)} ${String(failureCount).padStart(8)} ${'0'.padStart(10)}`);
console.log('');

if (failureLines.length > 0) {
    console.log(`  first ${Math.min(10, failureLines.length)} of ${failureLines.length} failing line(s):`);
    for (const line of failureLines.slice(0, 10)) {
        console.log(`    ${line.trim().slice(0, 300)}`);
    }
    console.log('');
}

// GitHub annotations + job summary. Best-effort: a broken summary file must
// not change the verdict, and the verdict is already on stdout.
if (failures.length > 0) {
    for (const f of failures) console.error(`::error::audit-write gate: ${f}`);
    try {
        if (process.env.GITHUB_STEP_SUMMARY) {
            appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                [
                    `### :rotating_light: E2E audit-write gate FAILED`,
                    '',
                    `| measurement | actual | required |`,
                    `| --- | --- | --- |`,
                    `| control \`${CONTROL_MARKER}\` | ${controlCount} | > 0 |`,
                    `| failures \`${FAILURE_MARKER}\` | ${failureCount} | 0 |`,
                    '',
                    ...failures.map((f) => `- ${f}`),
                    '',
                ].join('\n'),
            );
        }
    } catch {
        // Reporting must not become the failure.
    }
    console.error(`  e2e audit-write check: FAIL (${failures.length})`);
    for (const f of failures) console.error(`    - ${f}`);
    console.error('');
    process.exit(1);
}

console.log(
    `  e2e audit-write check: PASS — 0 swallowed audit writes, control seen ${controlCount}x`,
);
