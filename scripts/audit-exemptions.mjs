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
 *
 * Exit 0 = every remaining moderate+ advisory is exempt.
 * Exit 1 = something is not exempt, or an exemption is stale.
 */
import { execSync } from 'node:child_process';

/**
 * @type {Array<{id: string, package: string, reason: string, review: string}>}
 */
const EXEMPT = [
    {
        id: 'GHSA-w3rx-r6r6-pgpr',
        package: 'image-size',
        reason:
            'Reachability verified NIL. image-size arrives only via pptxgenjs, whose sole consumer is renderPptx() in src/app-layer/reports/risk-report-render.ts — which builds text and table slides and calls addImage() nowhere, so the vulnerable ICNS parser is never invoked on any input, let alone attacker-supplied. Enforced by tests/guardrails/pptx-no-image-embedding.test.ts: the day someone adds image embedding, that guard fails and this exemption must be re-argued. No upstream fix exists (image-size@1.2.1 is the latest published version and is the vulnerable one); npm\'s only proposed remedy is a THREE-major downgrade of pptxgenjs 4.0.1 → 1.1.5, which trades an unreachable DoS for real regressions in a working export path.',
        review: '2026-11-01',
    },
    {
        id: 'GHSA-5p2g-fcmc-qvqq',
        package: 'image-size',
        reason:
            'Same dependency path, same nil reachability, same absent upstream fix as GHSA-w3rx-r6r6-pgpr above — this advisory covers the JXL/HEIF parsers rather than ICNS. renderPptx() embeds no images at all.',
        review: '2026-11-01',
    },
];

function auditJson() {
    try {
        // Non-zero exit is expected here — we are parsing the report,
        // not gating on it. The gate already ran and failed upstream.
        return JSON.parse(
            execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
        );
    } catch (err) {
        if (err.stdout) return JSON.parse(err.stdout);
        throw err;
    }
}

const BLOCKING = new Set(['moderate', 'high', 'critical']);

const report = auditJson();
const found = new Map(); // GHSA id → { severity, package }

for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    if (!BLOCKING.has(v.severity)) continue;
    for (const via of v.via ?? []) {
        if (typeof via === 'object' && via.url) {
            const m = via.url.match(/(GHSA-[\w-]+)/);
            if (m) found.set(m[1], { severity: v.severity, package: pkg });
        }
    }
}

const exemptIds = new Set(EXEMPT.map((e) => e.id));
const unexplained = [...found.entries()].filter(([id]) => !exemptIds.has(id));
const stale = EXEMPT.filter((e) => !found.has(e.id));

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

if (!failed) {
    console.log('\n✓ npm audit: every remaining moderate+ advisory is tracked and exempt:\n');
    for (const e of EXEMPT) {
        console.log(`    ${e.id}  ${e.package}  (review by ${e.review})`);
    }
    console.log('');
}

process.exit(failed ? 1 : 0);
