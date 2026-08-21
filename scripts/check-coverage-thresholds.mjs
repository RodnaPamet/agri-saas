#!/usr/bin/env node
/**
 * Enforce jest.thresholds.json against an ALREADY-MERGED istanbul coverage
 * map — the piece `jest --coverageThreshold` cannot do for us once the
 * Coverage job is sharded, because that flag only applies to a live jest run.
 *
 * Usage (from the repo root — see the cwd note below):
 *   node scripts/check-coverage-thresholds.mjs \
 *     --coverage coverage/coverage-final.json \
 *     --thresholds jest.thresholds.json
 *
 * Exits 1 and prints jest's exact error strings when a floor is missed.
 *
 * This is a line-for-line port of jest 30's own algorithm —
 * node_modules/@jest/reporters/build/index.js `_checkThreshold` (v30.4.1,
 * lines 370-503). The semantics that are easy to get wrong and are
 * reproduced deliberately:
 *
 *  1. GROUP ASSIGNMENT. A file that matches a PATH (or GLOB) threshold key
 *     is REMOVED from the `global` group. `global` is scored over the
 *     remainder only. This is the repo's documented footgun (jest.config.js
 *     :455-470, ci.yml:598-615) — do not "simplify" it to whole-map totals.
 *  2. PATH MATCH IS A PREFIX MATCH on the ABSOLUTE path, with the trailing
 *     slash preserved: `path.resolve('./src/lib/')` + sep, then
 *     `file.indexOf(abs) === 0`. Resolution is relative to process.cwd(),
 *     exactly as in jest, so run this from the repo root.
 *  3. EMPTY-GLOBAL FALLBACK. If every covered file landed in a path group,
 *     `global` is scored over ALL covered files rather than nothing.
 *  4. NEGATIVE THRESHOLDS mean "at most N uncovered units", not a percent.
 *  5. PERCENTAGES come from istanbul's own CoverageSummary (percent.js
 *     floors to 2dp), never from a hand-rolled covered/total — that is why
 *     this uses createCoverageMap/toSummary rather than arithmetic.
 *  6. A path group that matches NO covered file is an ERROR
 *     ("Coverage data for X was not found"), not a silent pass.
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

const argv = process.argv.slice(2);
/**
 * SHADOW MODE. Print every group's real numbers and exit 0 regardless.
 *
 * Stage 1 of the sharding change lands report-only on purpose. The gate is
 * currently DARK (cancelled at its timeout on five consecutive main pushes) and
 * is not a required check, so a shadow run that prints the true enforced numbers
 * is strictly better than what exists — while enforcement waits on a
 * decimal-exact parity proof against a single-process reference run.
 *
 * Enforcing before that proof is how you get the one failure worse than a dark
 * gate: a green gate measuring the wrong population, which nobody investigates.
 */
const reportOnly = argv.includes('--report-only');
const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i === -1 ? dflt : argv[i + 1];
};
const coveragePath = opt('--coverage', 'coverage/coverage-final.json');
const thresholdsPath = opt('--thresholds', 'jest.thresholds.json');

const map = libCoverage.createCoverageMap(
    JSON.parse(fs.readFileSync(coveragePath, 'utf8')),
);
const coverageThreshold = JSON.parse(fs.readFileSync(thresholdsPath, 'utf8'));

/** jest: `check(name, thresholds, actuals)` */
function check(name, thresholds, actuals) {
    return ['statements', 'branches', 'lines', 'functions'].reduce((errors, key) => {
        const actual = actuals[key].pct;
        const actualUncovered = actuals[key].total - actuals[key].covered;
        const threshold = thresholds[key];
        if (threshold !== undefined) {
            if (threshold < 0) {
                if (threshold * -1 < actualUncovered) {
                    errors.push(
                        `Jest: Uncovered count for ${key} (${actualUncovered}) ` +
                            `exceeds ${name} threshold (${-1 * threshold})`,
                    );
                }
            } else if (actual < threshold) {
                errors.push(
                    `Jest: Coverage for ${key} (${actual}%) does not meet "${name}" threshold (${threshold}%)`,
                );
            }
        }
        return errors;
    }, []);
}

const GLOBAL = 'global';
const PATH = 'path';
const GLOB = 'glob';

const coveredFiles = map.files();
const thresholdGroups = Object.keys(coverageThreshold);
const groupTypeByThresholdGroup = {};
const filesByGlob = {};

const sorted = coveredFiles.reduce((files, file) => {
    const matches = thresholdGroups.reduce((agg, group) => {
        if (group === GLOBAL) return agg;

        // Preserve trailing slash, but not required if root dir.
        const resolved = path.resolve(group);
        const suffix =
            (group.endsWith(path.sep) ||
                (process.platform === 'win32' && group.endsWith('/'))) &&
            !resolved.endsWith(path.sep)
                ? path.sep
                : '';
        const abs = `${resolved}${suffix}`;

        if (file.indexOf(abs) === 0) {
            groupTypeByThresholdGroup[group] = PATH;
            agg.push([file, group]);
            return agg;
        }

        if (filesByGlob[abs] === undefined) {
            // Lazy — jest.thresholds.json currently declares no globs, so the
            // dependency is never loaded on the normal path.
            const { globSync } = require('glob');
            filesByGlob[abs] = globSync(abs, { windowsPathsNoEscape: true }).map((f) =>
                path.resolve(f),
            );
        }
        if (filesByGlob[abs].includes(file)) {
            groupTypeByThresholdGroup[group] = GLOB;
            agg.push([file, group]);
            return agg;
        }
        return agg;
    }, []);

    if (matches.length > 0) {
        files.push(...matches);
        return files;
    }
    if (thresholdGroups.includes(GLOBAL)) {
        groupTypeByThresholdGroup[GLOBAL] = GLOBAL;
        files.push([file, GLOBAL]);
        return files;
    }
    files.push([file, undefined]);
    return files;
}, []);

if (thresholdGroups.includes(GLOBAL)) groupTypeByThresholdGroup[GLOBAL] = GLOBAL;

const inGroup = (g) => sorted.filter(([, grp]) => grp === g).map(([f]) => f);

function combineCoverage(filePaths) {
    return filePaths
        .map((f) => map.fileCoverageFor(f))
        .reduce(
            (combined, next) =>
                combined === undefined || combined === null
                    ? next.toSummary()
                    : combined.merge(next.toSummary()),
            undefined,
        );
}

let errors = [];
for (const group of thresholdGroups) {
    switch (groupTypeByThresholdGroup[group]) {
        case GLOBAL: {
            const globalFiles = inGroup(GLOBAL);
            const coverage = combineCoverage(
                globalFiles.length > 0 ? globalFiles : coveredFiles,
            );
            if (coverage) errors = [...errors, ...check(group, coverageThreshold[group], coverage)];
            break;
        }
        case PATH: {
            const coverage = combineCoverage(inGroup(group));
            if (coverage) errors = [...errors, ...check(group, coverageThreshold[group], coverage)];
            break;
        }
        case GLOB:
            for (const f of inGroup(group)) {
                errors = [
                    ...errors,
                    ...check(f, coverageThreshold[group], map.fileCoverageFor(f).toSummary()),
                ];
            }
            break;
        default:
            if (group !== GLOBAL) {
                errors = [...errors, `Jest: Coverage data for ${group} was not found.`];
            }
    }
}

errors = errors.filter((e) => e !== undefined && e !== null && e.length > 0);

// Diagnosability: print the per-group measured numbers. The equivalent
// information in a jest run has to be reverse-engineered from
// coverage-summary.json, which is the confusion ci.yml:598-615 documents.
console.log('Per-threshold-group coverage (the populations the floors score):');
for (const group of thresholdGroups) {
    const type = groupTypeByThresholdGroup[group];
    if (type !== GLOBAL && type !== PATH) continue;
    const files = type === GLOBAL ? (inGroup(GLOBAL).length > 0 ? inGroup(GLOBAL) : coveredFiles) : inGroup(group);
    const s = combineCoverage(files);
    if (!s) continue;
    console.log(
        `  ${group.padEnd(30)} files=${String(files.length).padStart(5)}  ` +
            `B${s.branches.pct.toFixed(2)} F${s.functions.pct.toFixed(2)} ` +
            `L${s.lines.pct.toFixed(2)} S${s.statements.pct.toFixed(2)}`,
    );
}

if (errors.length > 0) {
    console.error('\n' + errors.join('\n'));
    if (reportOnly) {
        console.error('');
        console.error('SHADOW MODE (--report-only): the failures above are NOT enforced.');
        console.error('Enforcement resumes once the sharded numbers are proven equal to a');
        console.error('single-process reference run, to the decimal. Until then this is');
        console.error('a number where there was previously nothing.');
        process.exit(0);
    }
    process.exit(1);
}
console.log('\nAll coverage thresholds met.');
