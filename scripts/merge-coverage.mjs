#!/usr/bin/env node
/**
 * Merge N per-shard istanbul coverage-final.json files into one report.
 *
 * Usage:
 *   node scripts/merge-coverage.mjs \
 *     --out coverage \
 *     coverage-shards/shard-1/coverage-final.json \
 *     coverage-shards/shard-2/coverage-final.json
 *
 * Or point it at a directory and it globs `** /coverage-final.json`:
 *   node scripts/merge-coverage.mjs --out coverage coverage-shards
 *
 * Emits into --out:
 *   coverage-final.json   (merged raw map — the input to the threshold check)
 *   coverage-summary.json (json-summary — per-file, what CI's artifact note wants)
 *   lcov.info + lcov-report/
 *   a text-summary on stdout
 *
 * Uses ONLY packages already present in node_modules as transitive deps of
 * jest: istanbul-lib-coverage, istanbul-lib-report, istanbul-reports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Resolve istanbul from the script's own location (the normal case: this
// file lives in the repo's scripts/ next to node_modules), falling back to
// the working directory so the script also runs from outside the tree.
const selfRequire = createRequire(import.meta.url);
const cwdRequire = createRequire(path.join(process.cwd(), '__resolve__.js'));
const require = (id) => {
    try { return selfRequire(id); } catch { return cwdRequire(id); }
};
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const argv = process.argv.slice(2);
let outDir = 'coverage';
/**
 * How many shard reports MUST be present.
 *
 * The most dangerous failure of a sharded gate is a MISSING shard: the merge
 * succeeds, the numbers come out plausible, and they are computed over less
 * code than the gate believes. Coverage percentages generally move UP when a
 * shard vanishes, because the files that shard alone loaded leave the
 * denominator with it. A silently-passing gate measuring the wrong population
 * is worse than the dark gate this replaces, so the expected count is asserted
 * rather than inferred from whatever artifacts happened to download.
 */
let expected = 0;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { outDir = argv[++i]; continue; }
    if (argv[i] === '--expect') { expected = Number(argv[++i]); continue; }
    inputs.push(argv[i]);
}
if (inputs.length === 0) {
    console.error('usage: merge-coverage.mjs [--out DIR] <coverage-final.json | dir> ...');
    process.exit(2);
}

/** Expand directories into the coverage-final.json files beneath them. */
function expand(p) {
    const st = fs.statSync(p);
    if (st.isFile()) return [p];
    const out = [];
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const child = path.join(p, entry.name);
        if (entry.isDirectory()) out.push(...expand(child));
        else if (entry.name === 'coverage-final.json') out.push(child);
    }
    return out;
}

const files = inputs.flatMap(expand);
if (files.length === 0) {
    console.error('merge-coverage: no coverage-final.json found in ' + inputs.join(', '));
    process.exit(2);
}
if (expected > 0 && files.length !== expected) {
    console.error(
        `merge-coverage: expected ${expected} shard report(s), found ${files.length}.\n` +
            '  A missing shard does NOT fail the merge on its own — it quietly shrinks the\n' +
            '  denominator and usually RAISES the percentages. Refusing rather than\n' +
            '  reporting a number over the wrong population.\n' +
            '  found: ' + files.join(', '),
    );
    process.exit(2);
}

// createCoverageMap() + .merge() is the whole trick. `merge` is keyed on
// SOURCE LOCATION (istanbul-lib-coverage/lib/file-coverage.js `mergeProp`),
// not on statement index, so two shards that instrumented the same file
// combine correctly and hit counts add.
const map = libCoverage.createCoverageMap({});
for (const f of files) {
    map.merge(JSON.parse(fs.readFileSync(f, 'utf8')));
    console.error(`merge-coverage: merged ${f}`);
}

// An empty map is not "0% coverage" — it means every shard produced an
// instrumented report of nothing, which is a harness failure, not a result.
// Without this the checker would go on to report 0% and fail every floor for
// the wrong reason, sending whoever reads it after the wrong bug.
if (map.files().length === 0) {
    console.error('merge-coverage: merged map is EMPTY — the shards produced no file coverage at all.');
    process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'coverage-final.json'), JSON.stringify(map.toJSON()));

const context = libReport.createContext({ dir: outDir, coverageMap: map });
reports.create('json-summary').execute(context);
reports.create('lcov').execute(context);
reports.create('text-summary').execute(context);

console.error(
    `merge-coverage: ${files.length} shard report(s) -> ${map.files().length} files in ${outDir}/`,
);
