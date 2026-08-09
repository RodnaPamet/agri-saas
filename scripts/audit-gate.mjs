#!/usr/bin/env node
/**
 * npm audit gate with TRACKED per-advisory exemptions.
 *
 * ════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════
 *
 *  `npm audit --omit=dev --audit-level=moderate` blocks merge on any
 *  moderate-or-higher advisory in the PRODUCTION dependency tree. That
 *  gate is correct and must not be weakened — `.github/workflows/ci.yml`
 *  says so, and `tests/guardrails/security-gate-strictness.test.ts`
 *  fails CI if the level is raised back to high/critical.
 *
 *  But npm's gate is all-or-nothing: it has no way to say "this ONE
 *  advisory has no upstream fix and is unreachable in our code, while
 *  every other advisory still blocks". Without that, a single unfixable
 *  transitive advisory blocks EVERY merge in the repo indefinitely —
 *  which in practice pressures someone into lowering the global level,
 *  turning one accepted risk into a blanket one.
 *
 *  So this script keeps the global gate at moderate+ and carries a
 *  short, explicitly-reviewed exemption list instead. It is STRICTER
 *  than a lowered gate in three ways:
 *
 *    1. Exemptions are per-ADVISORY (GHSA id), not per-severity. A new
 *       advisory against the same package still fails.
 *    2. Every exemption carries a rationale, the condition that voids
 *       it, and a `reviewBy` date. Past that date the gate FAILS — an
 *       exemption cannot outlive its review by neglect.
 *    3. An exemption that no longer matches any advisory FAILS too, so
 *       dead entries are deleted rather than accumulating. (Same
 *       "no stale entries" convention as the repo's other allowlists.)
 *
 *  Adding an exemption is a security decision, not a build fix. Do it
 *  only when there is genuinely no fixed version to move to, and record
 *  WHY the advisory cannot reach us.
 * ════════════════════════════════════════════════════════════════════
 */
import { execFileSync } from 'node:child_process';

/**
 * Tracked exemptions. One entry per ADVISORY, each with a written
 * rationale, the fact that voids it, and a review date.
 *
 * @type {ReadonlyArray<{
 *   ghsa: string, package: string, reason: string,
 *   voidedIf: string, reviewBy: string,
 * }>}
 */
const EXEMPTIONS = [
    {
        ghsa: 'GHSA-w3rx-r6r6-pgpr',
        package: 'image-size',
        reason:
            'DoS via an infinite loop in the ICNS parser. Reached only through ' +
            "pptxgenjs's image-sizing path, which runs exclusively from addImage/" +
            'addMedia. Our only pptxgenjs caller is renderPptx in ' +
            'src/app-layer/reports/risk-report-render.ts, which builds slides from ' +
            'addText + addTable and embeds no images at all — so no image, malformed ' +
            'or otherwise, reaches the parser. There is NO fixed version to upgrade ' +
            'to: the advisory range is <= 2.0.2 with first_patched = none, and ' +
            '`npm audit fix --force` would downgrade pptxgenjs 4.x -> 1.1.5, ' +
            'breaking PPTX export outright.',
        voidedIf:
            'renderPptx (or any other pptxgenjs caller) starts embedding images — ' +
            'enforced by tests/guards/report-renderer-no-images.test.ts, which fails ' +
            'CI if addImage/addMedia appears in the report renderer.',
        reviewBy: '2026-11-09',
    },
    {
        ghsa: 'GHSA-5p2g-fcmc-qvqq',
        package: 'image-size',
        reason:
            'DoS via infinite loops in the JXL and HEIF parsers. Same package, same ' +
            'unreachable code path, and the same absence of any fixed version as ' +
            'GHSA-w3rx-r6r6-pgpr above — see that entry for the full reasoning.',
        voidedIf: 'Same as GHSA-w3rx-r6r6-pgpr.',
        reviewBy: '2026-11-09',
    },
];

const AUDIT_LEVEL = 'moderate';
const BLOCKING = new Set(['moderate', 'high', 'critical']);

/** Run npm audit, returning parsed JSON. Exits non-zero on findings, so capture stdout either way. */
function runAudit() {
    // The gate itself: npm audit --omit=dev --audit-level=moderate
    // (kept verbatim so security-gate-strictness.test.ts can assert it).
    const args = ['audit', '--omit=dev', `--audit-level=${AUDIT_LEVEL}`, '--json'];
    try {
        return JSON.parse(execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    } catch (err) {
        if (typeof err.stdout === 'string' && err.stdout.trim()) return JSON.parse(err.stdout);
        throw err;
    }
}

/**
 * Every GHSA id a vulnerability rests on, resolved TRANSITIVELY.
 *
 * npm reports two shapes in `via`: an advisory object (the package is
 * directly vulnerable) or a bare package-name string (the package is
 * vulnerable only because a dependency is). The string form carries no
 * GHSA id of its own, so a dependent of an exempt package would look
 * like an unexemptable finding and block forever — `pptxgenjs` via
 * `image-size` is exactly that case. Follow the strings to the
 * advisories they stand for.
 *
 * `seen` guards against a cyclic `via` graph.
 */
function advisoryIds(vuln, all, seen = new Set()) {
    const ids = new Set();
    if (seen.has(vuln.name)) return ids;
    seen.add(vuln.name);

    for (const via of vuln.via ?? []) {
        if (typeof via === 'object' && typeof via.url === 'string') {
            const m = via.url.match(/GHSA-[0-9a-z-]+/i);
            if (m) ids.add(m[0]);
        } else if (typeof via === 'string' && all[via]) {
            for (const id of advisoryIds(all[via], all, seen)) ids.add(id);
        }
    }
    return ids;
}

function main() {
    const today = new Date().toISOString().slice(0, 10);
    const report = runAudit();
    const all = report.vulnerabilities ?? {};
    const vulns = Object.values(all);

    const exemptByGhsa = new Map(EXEMPTIONS.map((e) => [e.ghsa, e]));
    const used = new Set();
    const blocking = [];

    for (const v of vulns) {
        if (!BLOCKING.has(v.severity)) continue;
        const ids = advisoryIds(v, all);
        const covered = [...ids].filter((id) => exemptByGhsa.has(id));
        covered.forEach((id) => used.add(id));
        // Block unless EVERY advisory behind this package is exempt. A
        // package carrying one exempt and one new advisory still fails.
        if (ids.size === 0 || covered.length !== ids.size) {
            blocking.push({ name: v.name, severity: v.severity, ids: [...ids] });
        }
    }

    const expired = EXEMPTIONS.filter((e) => e.reviewBy < today);
    const stale = EXEMPTIONS.filter((e) => !used.has(e.ghsa));

    for (const e of EXEMPTIONS) {
        if (used.has(e.ghsa)) {
            process.stdout.write(`exempt  ${e.ghsa}  ${e.package}  (review by ${e.reviewBy})\n`);
        }
    }

    let failed = false;

    if (blocking.length > 0) {
        failed = true;
        process.stderr.write(`\nnpm audit gate FAILED — ${blocking.length} unexempted advisory group(s):\n`);
        for (const b of blocking) {
            process.stderr.write(`  ${b.severity.padEnd(8)} ${b.name}  ${b.ids.join(', ') || '(no GHSA id)'}\n`);
        }
        process.stderr.write(
            '\nFix it by upgrading. Only if there is genuinely NO fixed version, add a\n' +
                'tracked exemption to EXEMPTIONS in scripts/audit-gate.mjs with a written\n' +
                'rationale, the condition that voids it, and a reviewBy date.\n',
        );
    }

    if (expired.length > 0) {
        failed = true;
        process.stderr.write('\nEXPIRED exemptions (past reviewBy — re-review or remove):\n');
        for (const e of expired) process.stderr.write(`  ${e.ghsa}  ${e.package}  reviewBy ${e.reviewBy}\n`);
    }

    if (stale.length > 0) {
        failed = true;
        process.stderr.write('\nSTALE exemptions (no longer match any advisory — delete them):\n');
        for (const e of stale) process.stderr.write(`  ${e.ghsa}  ${e.package}\n`);
    }

    if (failed) process.exit(1);
    process.stdout.write(`npm audit gate passed (level=${AUDIT_LEVEL}, ${EXEMPTIONS.length} tracked exemption(s)).\n`);
}

main();
