#!/usr/bin/env node
/**
 * Per-advisory exemption gate for `npm audit`.
 *
 * The CI security job runs the real gate verbatim:
 *
 *     npm audit --omit=dev --audit-level=moderate
 *
 * and only falls through to this script when that FAILS. The global
 * threshold is untouched — `tests/guardrails/security-gate-strictness.test.ts`
 * still sees the literal command and still fails CI if anyone weakens it.
 * What this adds is the narrow escape hatch the CI comment already
 * prescribes: "add a tracked exemption with a written rationale +
 * upgrade plan rather than relaxing the global gate."
 *
 * Rules, deliberately strict:
 *
 *   1. An advisory is exempt ONLY by its GHSA id. Not by package, not
 *      by severity — so a NEW advisory on the same package still
 *      blocks the merge.
 *   2. Every entry carries a written `reason` and a `review` date. A
 *      reason like "not fixed yet" is not a reason; say why it cannot
 *      hurt this codebase.
 *   3. A STALE entry fails the build. When upstream ships a fix and
 *      the advisory stops appearing, the exemption must be deleted in
 *      the same PR that upgrades — otherwise the list rots into a
 *      permanent blind spot.
 *   4. An EXPIRED entry fails the build too. `review` used to be
 *      write-only — printed on a passing run, never compared against
 *      today — so an exemption could outlive the date its own author
 *      promised to revisit it, and an accepted-for-now risk quietly
 *      became a forgotten one. Once `review` has passed AND the
 *      advisory still appears, the build fails until someone either
 *      re-argues the exemption (delete + re-add with a new `review`
 *      date) or removes it and fixes the advisory for real.
 *
 * Exit 0 = every remaining moderate+ advisory is exempt AND every
 *          exemption's review date is still in the future.
 * Exit 1 = something is not exempt, an exemption is stale, or an
 *          exemption's review date has passed.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @type {Array<{id: string, package: string, reason: string, review: string}>}
 */
const REAL_EXEMPT = [
    // Intentionally empty.
    //
    // The two `image-size` advisories (GHSA-w3rx-r6r6-pgpr,
    // GHSA-5p2g-fcmc-qvqq) that lived here reached the production tree
    // only through `pptxgenjs`, which existed for a single consumer:
    // `renderPptx()` in the risk report. The risk-quantification uproot
    // deleted that renderer, so the dependency was dropped rather than
    // exempted — `npm ls image-size --omit=dev` is now empty and
    // `npm audit --omit=dev --audit-level=moderate` reports zero
    // vulnerabilities without any exemption at all.
    //
    // Removing a vulnerable package beats arguing it unreachable, and
    // rule 3 above requires the entry to go in the same PR. Note the
    // stale check that would have caught this only runs when `npm audit`
    // FAILS — with the advisories gone the gate passes, this script never
    // executes, and a stale entry would have sat here unexercised.
    // `tests/guardrails/pptx-no-image-embedding.test.ts` now holds the
    // invariant instead: the dependency may not come back silently.
];

// Test-only override, same shape as `AUDIT_JSON_OVERRIDE` below — lets
// `tests/unit/audit-exemptions.test.ts` exercise the stale / expired /
// valid classification against a fixture exemption list (a future
// `review` date, a past one, an advisory that's since been fixed)
// without touching `REAL_EXEMPT`, which stays empty. Never set outside
// a test.
const EXEMPT = process.env.EXEMPT_OVERRIDE
    ? JSON.parse(readFileSync(process.env.EXEMPT_OVERRIDE, 'utf8'))
    : REAL_EXEMPT;

/**
 * Refuse, loudly, with a message that can never be misread as a clean bill.
 *
 * Every path into this function means "the audit did not produce a usable
 * answer" — NOT "the audit found nothing". Those two were folded together
 * once already, and the whole of this file is the cost of that.
 */
function unusable(what, details = []) {
    console.error(`\n✖ npm audit is UNUSABLE — ${what}.\n`);
    for (const d of details) console.error(`    ${d}`);
    console.error(
        '\n  REFUSING to report "clean": nothing was checked, so this run\n' +
            '  proves nothing about the dependency tree. This is not a finding\n' +
            '  about a vulnerability — it is the absence of a verdict.\n',
    );
    process.exit(1);
}

function auditJson() {
    // NOT test-only any more — this is now the PRIMARY path.
    //
    // CI captures one report (`npm audit … --json > audit.json || true`) and
    // points this at it, so the gate and the exemption logic judge the SAME
    // bytes. Previously CI ran `npm audit … || node scripts/audit-exemptions.mjs`
    // — two separate audits — and a registry that degraded between them let a
    // real-advisory failure be overwritten by a clean second read.
    //
    // The unit test uses the same door with fixture files, which is what makes
    // the tested path and the production path identical rather than parallel.
    if (process.env.AUDIT_JSON_OVERRIDE) {
        // CI now captures the report to a file (`npm audit ... --json >
        // audit.json || true`) and points this at it, so the file is
        // whatever npm managed to write — which on a network failure
        // mid-write is empty or truncated. An exception here must NOT fall
        // through to "no vulnerabilities key ⇒ nothing blocking"; that is
        // the whole bug this file now exists to prevent.
        let raw;
        try {
            raw = readFileSync(process.env.AUDIT_JSON_OVERRIDE, 'utf8');
        } catch (err) {
            unusable('could not read the audit report file', [
                `${process.env.AUDIT_JSON_OVERRIDE}: ${err.message}`,
            ]);
        }
        if (!raw.trim()) {
            unusable('the audit report file is EMPTY', [
                `${process.env.AUDIT_JSON_OVERRIDE} has ${raw.length} byte(s)`,
                'npm wrote nothing — it failed before producing a report.',
            ]);
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            unusable('the audit report file is not valid JSON (truncated?)', [
                `${err.message}`,
                `first 200 bytes: ${raw.slice(0, 200)}`,
            ]);
        }
        return assertIsAuditReport(parsed);
    }
    try {
        // Non-zero exit is expected here — we are parsing the report,
        // not gating on it. The gate already ran and failed upstream.
        return assertIsAuditReport(
            JSON.parse(
                execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
            ),
        );
    } catch (err) {
        if (err.stdout) return assertIsAuditReport(JSON.parse(err.stdout));
        throw err;
    }
}

/**
 * Refuse anything that is not an actual audit report.
 *
 * ## What this cost
 *
 * `npm audit --json` writes its ERRORS to stdout as valid JSON. When npm's
 * advisory endpoint failed, `JSON.parse` therefore SUCCEEDED on a payload
 * like:
 *
 *     { "message": "400 Bad Request - POST .../security/audits/quick",
 *       "statusCode": 400, "error": {...}, "uri": ..., "headers": ... }
 *
 * `findAdvisories` then read `report.vulnerabilities ?? {}`, got `{}`, found
 * nothing blocking, and this script exited 0 — printing "every remaining
 * moderate+ advisory is tracked and exempt". A gate that asserts safety
 * while checking nothing, in the reassuring voice.
 *
 * `ci.yml` runs this as `npm audit ... || node scripts/audit-exemptions.mjs`,
 * so the fallback fires EXACTLY when audit fails. The failure was pointed
 * toward green at two independent seams.
 *
 * **The failure got quieter as the outage got better.** While the endpoint
 * HUNG, jobs died on `timeout-minutes` and somebody looked. Once it answered
 * 400 promptly, the job passed silently. Do not "simplify" this back into a
 * truthiness check.
 *
 * ## Why a POSITIVE shape check
 *
 * `?? {}` erased the difference between two opposite facts: an ABSENT
 * `vulnerabilities` key means "I could not check", an EMPTY one means "I
 * checked and found nothing". Measured, a genuinely clean report carries
 * `auditReportVersion`, `metadata` AND `vulnerabilities: {}` — the key is
 * present and empty. npm's error payload carries none of the three.
 *
 * So this asserts the shape a real report HAS, rather than sniffing for the
 * error markers npm happens to use today. A new npm error shape is caught by
 * construction; an error-marker denylist would have to be updated for it.
 *
 * ## Why `metadata.dependencies.total` is the load-bearing one
 *
 * The shape check alone still cannot tell a report over OUR tree from a
 * report over NOTHING. `vulnerabilities: {}` is a legitimate value — it is
 * exactly what a clean tree returns — so "zero advisories" and "zero packages
 * examined" produce identical output and mean opposite things.
 *
 * `metadata.dependencies.total` is non-zero only if npm actually walked a
 * dependency tree, which makes it a POSITIVE CONTROL: an absence is only
 * evidence once you have proved you were looking at something. Measured, a
 * report over a package with no dependencies carries `total: 0` (and
 * `prod: 1`, the root itself) — so this repo, with ~2000 production+dev
 * dependencies, resolving to 0 means the audit examined nothing and must not
 * be read as "clean".
 */
export function assertIsAuditReport(report) {
    const looksReal =
        report !== null &&
        typeof report === 'object' &&
        typeof report.auditReportVersion === 'number' &&
        report.vulnerabilities !== null &&
        typeof report.vulnerabilities === 'object';
    if (looksReal) {
        // Positive control — see above. Only enforced for a report that is
        // otherwise well-formed, so the message below stays specific.
        const total = report.metadata?.dependencies?.total;
        if (typeof total !== 'number' || total <= 0) {
            console.error('\n✖ npm audit examined NO dependencies — REFUSING to report "clean".\n');
            console.error(`    metadata.dependencies.total = ${JSON.stringify(total)}\n`);
            console.error(
                '  A report over an empty tree and a report over a clean tree both\n' +
                    '  say `vulnerabilities: {}`. They mean opposite things. This repo\n' +
                    '  has thousands of dependencies, so 0 means nothing was checked.\n',
            );
            process.exit(1);
        }
        return report;
    }

    const detail =
        report && typeof report === 'object' && report.message
            ? String(report.message)
            : `keys: ${report && typeof report === 'object' ? Object.keys(report).join(', ') || '(none)' : typeof report}`;
    console.error('\n✖ npm audit did not return a report — REFUSING to report "clean".\n');
    console.error(`    ${detail}\n`);
    console.error(
        '  This is NOT "no vulnerabilities found" — the audit could not run,\n' +
            '  so nothing was checked. Common cause: npm 10 calls the RETIRED\n' +
            '  /-/npm/v1/security/audits/quick endpoint, which answers 400. npm 11\n' +
            '  uses the bulk endpoint instead.\n',
    );
    process.exit(1);
}

const BLOCKING = new Set(['moderate', 'high', 'critical']);

/**
 * Extract every blocking-severity advisory from an `npm audit --json` report.
 *
 * Entries WITHOUT a resolvable GHSA id are recorded under a synthetic
 * `UNNAMED:<pkg>` key rather than skipped. Dropping them was a silent pass:
 * a blocking advisory whose `via` carries no `GHSA-` url simply vanished, so
 * a report could be declared "fully exempted" while real advisories were
 * never compared against the list at all. An advisory we cannot NAME is
 * still an advisory we have not EXEMPTED — and since no exemption can match
 * a synthetic id, it lands in `unexplained` and fails, which is correct.
 */
export function findAdvisories(report) {
    const found = new Map(); // GHSA id → { severity, package }
    for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
        if (!BLOCKING.has(v.severity)) continue;
        let named = false;
        for (const via of v.via ?? []) {
            if (typeof via === 'object' && via.url) {
                const m = via.url.match(/(GHSA-[\w-]+)/);
                if (m) {
                    found.set(m[1], { severity: v.severity, package: pkg });
                    named = true;
                }
            }
        }
        if (!named) found.set(`UNNAMED:${pkg}`, { severity: v.severity, package: pkg });
    }
    return found;
}

/**
 * The advisory feed's own positive control.
 *
 * ## Why a shape check is not enough
 *
 * `{}` is UNFALSIFIABLE on its own. Measured against the real registry, the
 * bulk advisory endpoint answers `200 {}` for a package it does not
 * recognise — byte-identical to what it returns for a package with no
 * advisories. And arborist writes `auditReportVersion`, `vulnerabilities: {}`
 * and the full `metadata` counters UNCONDITIONALLY, before any advisory data
 * is consulted, so a blind report over this repo's 2096-package tree is
 * byte-identical to a genuine clean one. Confirmed on npm 10.9.8 and 11.19.1.
 *
 * So no field npm emits can distinguish "examined, found nothing" from "did
 * not examine". Only external ground truth can: ask the feed something whose
 * answer we already know.
 *
 * Same discipline as `scripts/verify-image-patches.mjs` (assert the
 * fingerprint still matches SOMETHING, so the check cannot fail open) and the
 * basemap scanner treating `blind` as RED rather than as a pass.
 *
 * ## Only consulted when the answer is "clean"
 *
 * A report that CONTAINS advisories has already proved the feed was live.
 * The probe runs only when we are about to certify an empty result, which is
 * the sole answer that can be a lie of omission.
 */
const CANARY = {
    // Chosen for durability, not recency: a prototype-pollution advisory on
    // an enormously-depended-on package, published 2019 and referenced
    // everywhere. Withdrawal or renumbering is implausible — which matters,
    // because if this pin ever stops resolving the build goes red and the
    // next person must not be tempted to "fix" it by deleting the canary.
    pkg: 'lodash',
    version: '4.17.15',
    ghsa: 'GHSA-35jh-r3h4-6jhm',
    url: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
};

async function advisoryFeedProvenLive() {
    // Test-only, same convention as AUDIT_JSON_OVERRIDE above. Never set
    // outside a test — `tests/guards/audit-gate-no-ci-overrides.test.ts`
    // fails CI if any of these appear under .github/.
    if (process.env.AUDIT_CANARY_OVERRIDE) {
        return process.env.AUDIT_CANARY_OVERRIDE === 'live';
    }
    try {
        const res = await fetch(CANARY.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [CANARY.pkg]: [CANARY.version] }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return false;
        return (await res.text()).includes(CANARY.ghsa);
    } catch {
        // A probe that could not complete has not proven anything.
        return false;
    }
}

/**
 * Pure classification, given the currently-found advisories, the exempt
 * list, and "today". Kept separate from `main()`'s I/O + reporting so the
 * decision itself reads in one place; see `EXEMPT_OVERRIDE` /
 * `AUDIT_JSON_OVERRIDE` above for how the unit test drives this end-to-end
 * through the CLI without a real `npm audit` or waiting for the system
 * clock to cross a boundary.
 *
 *   - `unexplained` — a blocking advisory with no matching exemption.
 *   - `stale`       — an exemption for an advisory that no longer appears.
 *   - `expired`     — an exemption whose `review` date has passed AND the
 *                     advisory it covers still appears (a stale entry is
 *                     reported as stale, not also as expired).
 *
 * `review` is parsed as a calendar date (midnight UTC) so "today IS the
 * review date" still passes — the entry is due for review, not yet
 * overdue; it expires the day AFTER.
 */
export function classifyExemptions(exempt, found, today = new Date()) {
    const exemptIds = new Set(exempt.map((e) => e.id));
    const unexplained = [...found.entries()].filter(([id]) => !exemptIds.has(id));
    const stale = exempt.filter((e) => !found.has(e.id));
    // Compare CALENDAR DATES, not instants: `today` is "right now" (some
    // time after 00:00:00 UTC), so comparing it directly against a
    // midnight-anchored `review` date would mark an entry expired the
    // moment the clock ticks past midnight on its own review day — the
    // entry becomes due, not overdue, until the day after.
    const todayDateOnly = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const expired = exempt.filter((e) => found.has(e.id) && new Date(`${e.review}T00:00:00Z`) < todayDateOnly);
    return { unexplained, stale, expired };
}

async function main() {
    const report = auditJson();
    const found = findAdvisories(report);
    const { unexplained, stale, expired } = classifyExemptions(EXEMPT, found, new Date());

    let failed = false;

    if (unexplained.length) {
        failed = true;
        console.error('\n✖ npm audit: moderate+ advisories with NO exemption:\n');
        for (const [id, meta] of unexplained) {
            console.error(`    ${id}  ${meta.severity.padEnd(8)} ${meta.package}`);
        }
        console.error(
            '\n  Fix the vulnerability, or add a tracked entry to EXEMPT in\n' +
            '  scripts/audit-exemptions.mjs with a written reachability argument.\n' +
            '  Do NOT lower --audit-level.\n',
        );
    }

    if (stale.length) {
        failed = true;
        console.error('\n✖ STALE exemptions — these advisories no longer appear:\n');
        for (const e of stale) console.error(`    ${e.id}  (${e.package})`);
        console.error(
            '\n  Upstream fixed them. Delete the entry in the same PR as the\n' +
            '  upgrade, so the list never rots into a permanent blind spot.\n',
        );
    }

    if (expired.length) {
        failed = true;
        console.error('\n✖ EXPIRED exemptions — the review date has passed:\n');
        for (const e of expired) {
            console.error(`    ${e.id}  ${e.package}  (review was due ${e.review})`);
        }
        console.error(
            '\n  Re-argue the exemption (re-check the reachability argument still\n' +
            '  holds, then bump `review` to a new date), or remove the entry and\n' +
            '  fix the advisory for real. An exemption is an accepted risk with a\n' +
            "  promised check-in date, not a permanent pass — don't just push the\n" +
            '  date out without re-checking it.\n',
        );
    }

    if (!failed && found.size === 0) {
        // Nothing found at all — the ONE answer that could be a lie of
        // omission. Prove the feed was live before certifying it. A report
        // that CONTAINED advisories has already proved that by existing.
        if (!(await advisoryFeedProvenLive())) {
            unusable('the advisory feed did not return a known-good result', [
                `probe: ${CANARY.pkg}@${CANARY.version} should report ${CANARY.ghsa}`,
                'The audit reported ZERO advisories, but the feed cannot be shown',
                'to be answering — so "zero" may mean "not examined".',
                '',
                'This does NOT mean a vulnerability was found in that package.',
                'It means this run proved nothing. Re-run once the advisory',
                'service is healthy; do not delete the probe to go green.',
            ]);
        }
    }

    if (!failed) {
        console.log('\n✓ npm audit: every remaining moderate+ advisory is tracked and exempt:\n');
        for (const e of EXEMPT) {
            console.log(`    ${e.id}  ${e.package}  (review by ${e.review})`);
        }
        console.log('');
    }

    process.exit(failed ? 1 : 0);
}

// Only run the CLI when this file is executed directly (`node
// scripts/audit-exemptions.mjs`), guarding against an unconditional
// `process.exit()` (plus a real `npm audit` shell-out) as a side effect
// of merely loading the module. `tests/unit/audit-exemptions.test.ts`
// exercises this script exclusively by spawning it as a subprocess
// (same convention as `tests/unit/sync-chart-version.test.ts` for
// `sync-chart-version.mjs`, the other `import.meta.url` CLI script in
// this repo) rather than importing it — ts-jest's CommonJS transform
// doesn't support `import.meta`, so a direct `import` from a test fails
// with "Cannot use import statement outside a module" regardless of
// which export is consumed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
