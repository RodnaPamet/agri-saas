/**
 * jest's threshold-group assignment, extracted so there is exactly ONE copy.
 *
 * This is a line-for-line port of jest 30's own algorithm —
 * node_modules/@jest/reporters/build/index.js `_checkThreshold` (v30.4.1,
 * lines 370-503) — and it is shared by:
 *
 *   • scripts/check-coverage-thresholds.mjs — scores the floors
 *   • scripts/diff-coverage.mjs             — proves two maps are equal
 *
 * The differ MUST group identically to the checker or its verdict is
 * meaningless: it would be comparing two populations that jest would never
 * have scored. Two copies of a subtle algorithm drift; this module is the
 * reason there is only one.
 *
 * The semantics that are easy to get wrong, reproduced deliberately:
 *
 *  1. GROUP ASSIGNMENT. A file matching a PATH (or GLOB) key is REMOVED from
 *     the `global` group — `global` is scored over the remainder only. This is
 *     the repo's documented footgun (jest.config.js, ci.yml): the whole-map
 *     "Coverage summary" table and the enforced `global` number are DIFFERENT
 *     populations, ~4.45 points apart on branches. Re-flooring from the wrong
 *     one broke main on 2026-08-20.
 *  2. PATH MATCH IS A PREFIX MATCH on the ABSOLUTE path, trailing slash
 *     preserved. Resolution is relative to process.cwd(), exactly as in jest —
 *     so callers must run from the repo root, and a map generated on another
 *     machine must have its paths rewritten first or every file misses every
 *     group and silently falls into `global`.
 *  3. EMPTY-GLOBAL FALLBACK. If every covered file landed in a path group,
 *     `global` is scored over ALL covered files rather than nothing.
 *  4. PERCENTAGES come from istanbul's own CoverageSummary (percent.js floors
 *     to 2dp), never a hand-rolled covered/total — hence toSummary(), not
 *     arithmetic.
 */
import path from 'node:path';

export const GLOBAL = 'global';
export const PATH = 'path';
export const GLOB = 'glob';

/**
 * Assign every covered file to its threshold group.
 *
 * @param {import('istanbul-lib-coverage').CoverageMap} map
 * @param {Record<string, unknown>} coverageThreshold  parsed jest.thresholds.json
 * @param {(id: string) => unknown} require  resolver, for the lazy `glob` import
 * @returns {{ sorted: Array<[string, string|undefined]>, groupTypeByThresholdGroup: Record<string,string>, coveredFiles: string[], inGroup: (g: string) => string[] }}
 */
export function assignGroups(map, coverageThreshold, require) {
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
                // Lazy — jest.thresholds.json currently declares no globs, so
                // the dependency is never loaded on the normal path.
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

    return { sorted, groupTypeByThresholdGroup, coveredFiles, inGroup };
}

/**
 * Merge a set of files into one istanbul CoverageSummary.
 * Returns undefined for an empty set, matching jest.
 */
export function combineCoverage(map, filePaths) {
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

/**
 * The files a group is actually SCORED over — which is not simply `inGroup(g)`,
 * because `global` falls back to the whole map when every file matched a path
 * key (semantic 3 above). Both consumers need this identically.
 */
export function filesScoredForGroup(group, type, inGroup, coveredFiles) {
    if (type === GLOBAL) {
        const g = inGroup(GLOBAL);
        return g.length > 0 ? g : coveredFiles;
    }
    return inGroup(group);
}
