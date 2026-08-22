#!/usr/bin/env node
/**
 * Prove two istanbul coverage maps measure the SAME thing — the parity check
 * that gates turning the sharded coverage gate from shadow to enforcing.
 *
 * Usage:
 *   node scripts/diff-coverage.mjs \
 *     --a coverage-sharded/coverage-final.json   --label-a sharded \
 *     --b coverage-reference/coverage-final.json --label-b reference \
 *     --thresholds jest.thresholds.json
 *
 * Exits 1 on ANY difference. Exits 0 only when the two maps are equal on
 * every axis the coverage gate can see.
 *
 * ── WHAT IS COMPARED, AND WHAT DELIBERATELY IS NOT ──
 *
 * Compared, all exact:
 *   1. THE FILE SET. The most important axis and the least obvious. A missing
 *      shard does not depress coverage — istanbul's merge unions the file set,
 *      so absent files leave the DENOMINATOR entirely and the percentages
 *      RISE. A parity check that only compared percentages could therefore be
 *      satisfied by the exact failure it exists to catch.
 *   2. THE FIVE THRESHOLD-GROUP ROWS — covered/total integers and the 2dp pct.
 *      These are the numbers the gate scores; equality here is the claim being
 *      proven. Grouping comes from scripts/lib/coverage-groups.mjs, the same
 *      module the checker uses, so the differ cannot group differently than
 *      the thing it is certifying.
 *   3. PER-FILE covered/total for all four metrics — so a mismatch names the
 *      files rather than just reporting that a number moved.
 *
 * NOT compared: raw execution counts (`s`/`f`/`b` hit tallies).
 *
 *   This is deliberate and is the one judgement call in the file. Hit counts
 *   are not what the gate scores — a statement executed 3 times and one
 *   executed 3000 times are both "covered", and jest.thresholds.json cannot
 *   tell them apart. But they ARE legitimately allowed to differ between a
 *   sharded and an unsharded run: anything that loops on wall-clock, retries,
 *   or consults a PRNG or a Date changes its tally without changing what is
 *   covered. Asserting on counts would therefore produce failures that are
 *   real differences but not DEFECTS, and a parity check that cries wolf is
 *   one somebody switches off. Covered/total is the coarsest comparison that
 *   is still strictly stronger than the gate's own resolution.
 *
 * ── PATHS ──
 *
 * istanbul keys on ABSOLUTE paths and jest resolves threshold keys against
 * process.cwd(), so both maps must be rooted at the cwd this runs in. In the
 * reference workflow they are — both are produced on a GitHub runner at
 * /home/runner/work/agri-saas/agri-saas, which is also the checkout root.
 * `--rebase-from <prefix>` rewrites that prefix to the cwd in both maps, for
 * running this on a downloaded artifact locally. Without it, a foreign-rooted
 * map matches no path key and every file silently lands in `global`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
    GLOBAL,
    PATH,
    assignGroups,
    combineCoverage,
    filesScoredForGroup,
} from './lib/coverage-groups.mjs';

const selfRequire = createRequire(import.meta.url);
const cwdRequire = createRequire(path.join(process.cwd(), '__resolve__.js'));
const require = (id) => {
    try { return selfRequire(id); } catch { return cwdRequire(id); }
};
const libCoverage = require('istanbul-lib-coverage');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i === -1 ? dflt : argv[i + 1];
};

const aPath = opt('--a');
const bPath = opt('--b');
const labelA = opt('--label-a', 'A');
const labelB = opt('--label-b', 'B');
const thresholdsPath = opt('--thresholds', 'jest.thresholds.json');
const rebaseFrom = opt('--rebase-from');
/** Cap on how many individual differences are listed before summarising. */
const MAX_LIST = 25;

if (!aPath || !bPath) {
    console.error('usage: diff-coverage.mjs --a <map.json> --b <map.json> [--label-a X --label-b Y] [--rebase-from <prefix>]');
    process.exit(2);
}

function load(p) {
    let raw = fs.readFileSync(p, 'utf8');
    if (rebaseFrom) raw = raw.split(rebaseFrom).join(process.cwd());
    const map = libCoverage.createCoverageMap(JSON.parse(raw));
    if (map.files().length === 0) {
        console.error(`FATAL: ${p} contains no files. An empty map compares equal to another empty map.`);
        process.exit(2);
    }
    return map;
}

const mapA = load(aPath);
const mapB = load(bPath);
const thresholds = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));

const METRICS = ['statements', 'branches', 'functions', 'lines'];
const rel = (f) => path.relative(process.cwd(), f);
const problems = [];

// ── 1. File set ────────────────────────────────────────────────────────────
const filesA = new Set(mapA.files());
const filesB = new Set(mapB.files());
const onlyA = [...filesA].filter((f) => !filesB.has(f)).sort();
const onlyB = [...filesB].filter((f) => !filesA.has(f)).sort();

console.log('── File set ──');
console.log(`  ${labelA}: ${filesA.size} files`);
console.log(`  ${labelB}: ${filesB.size} files`);
if (onlyA.length || onlyB.length) {
    problems.push(`file set differs: ${onlyA.length} only in ${labelA}, ${onlyB.length} only in ${labelB}`);
    const show = (list, label) => {
        if (!list.length) return;
        console.log(`\n  Only in ${label} (${list.length}):`);
        for (const f of list.slice(0, MAX_LIST)) console.log(`    ${rel(f)}`);
        if (list.length > MAX_LIST) console.log(`    … and ${list.length - MAX_LIST} more`);
    };
    show(onlyA, labelA);
    show(onlyB, labelB);
} else {
    console.log('  identical ✓');
}

// ── 2. Per-file covered/total ──────────────────────────────────────────────
const shared = [...filesA].filter((f) => filesB.has(f)).sort();
const fileDiffs = [];
for (const f of shared) {
    const sa = mapA.fileCoverageFor(f).toSummary();
    const sb = mapB.fileCoverageFor(f).toSummary();
    const bad = METRICS.filter(
        (m) => sa[m].covered !== sb[m].covered || sa[m].total !== sb[m].total,
    );
    if (bad.length) fileDiffs.push({ f, bad, sa, sb });
}

console.log('\n── Per-file covered/total ──');
if (fileDiffs.length) {
    problems.push(`${fileDiffs.length} file(s) differ on covered/total`);
    console.log(`  ${fileDiffs.length} of ${shared.length} shared files differ:`);
    for (const { f, bad, sa, sb } of fileDiffs.slice(0, MAX_LIST)) {
        console.log(`    ${rel(f)}`);
        for (const m of bad) {
            console.log(
                `      ${m.padEnd(11)} ${labelA} ${sa[m].covered}/${sa[m].total}` +
                    `   ${labelB} ${sb[m].covered}/${sb[m].total}`,
            );
        }
    }
    if (fileDiffs.length > MAX_LIST) console.log(`    … and ${fileDiffs.length - MAX_LIST} more`);
} else {
    console.log(`  all ${shared.length} shared files identical ✓`);
}

// ── 3. Threshold-group rows ────────────────────────────────────────────────
function groupRows(map) {
    const { groupTypeByThresholdGroup, coveredFiles, inGroup } = assignGroups(map, thresholds, require);
    const rows = new Map();
    for (const group of Object.keys(thresholds)) {
        const type = groupTypeByThresholdGroup[group];
        if (type !== GLOBAL && type !== PATH) continue;
        const files = filesScoredForGroup(group, type, inGroup, coveredFiles);
        const s = combineCoverage(map, files);
        if (!s) continue;
        rows.set(group, { files: files.length, s });
    }
    return rows;
}

const rowsA = groupRows(mapA);
const rowsB = groupRows(mapB);

console.log('\n── Threshold groups (the populations the gate scores) ──');
const allGroups = [...new Set([...rowsA.keys(), ...rowsB.keys()])];
for (const g of allGroups) {
    const ra = rowsA.get(g);
    const rb = rowsB.get(g);
    if (!ra || !rb) {
        problems.push(`group ${g} present in only one map`);
        console.log(`  ${g.padEnd(30)} MISSING from ${!ra ? labelA : labelB}`);
        continue;
    }
    const fmt = (r) =>
        METRICS.map((m) => `${m[0].toUpperCase()}${r.s[m].pct.toFixed(2)}`).join(' ');
    const same =
        ra.files === rb.files &&
        METRICS.every(
            (m) =>
                ra.s[m].covered === rb.s[m].covered &&
                ra.s[m].total === rb.s[m].total &&
                ra.s[m].pct.toFixed(2) === rb.s[m].pct.toFixed(2),
        );
    console.log(`  ${g.padEnd(30)} ${same ? '✓' : '✗'}`);
    console.log(`    ${labelA.padEnd(12)} files=${String(ra.files).padStart(5)}  ${fmt(ra)}`);
    console.log(`    ${labelB.padEnd(12)} files=${String(rb.files).padStart(5)}  ${fmt(rb)}`);
    if (!same) {
        problems.push(`group ${g} differs`);
        for (const m of METRICS) {
            if (
                ra.s[m].covered !== rb.s[m].covered ||
                ra.s[m].total !== rb.s[m].total
            ) {
                console.log(
                    `      ${m.padEnd(11)} ${labelA} ${ra.s[m].covered}/${ra.s[m].total}` +
                        `   ${labelB} ${rb.s[m].covered}/${rb.s[m].total}`,
                );
            }
        }
    }
}

// ── Verdict ────────────────────────────────────────────────────────────────
console.log('');
if (problems.length) {
    console.error('COVERAGE PARITY FAILED:');
    for (const p of problems) console.error(`  • ${p}`);
    console.error('');
    console.error('Do NOT re-floor jest.thresholds.json to make this pass — the floors are');
    console.error('not what is in question. A difference here means the two runs measured');
    console.error('different CODE, and the file-set section above names it.');
    process.exit(1);
}
console.log(`PARITY PROVEN: ${labelA} and ${labelB} are identical on file set, per-file`);
console.log('covered/total, and every threshold-group row.');
