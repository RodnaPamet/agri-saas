/**
 * Which jest SUITES transitively import a given source file — #3058.
 *
 * ## Why this exists
 *
 * `verify:changed` selects test ROOTS. A root is the right unit for the two
 * questions it was built on — "which roots care about files in this directory"
 * and "what does this diff now treat differently" — and the wrong unit for a
 * third: *which suites actually exercise the module I just edited*.
 *
 * Measured on main 2026-11-14, an `src/app-layer/**` change reaches six roots
 * that no path rule selects: `tests/rendered` (92 files), `tests/guards` (86),
 * `tests/guardrails` (62), `tests/pdf` (47), `tests/contracts` (35),
 * `tests/drills` (8). Adding all six as path rules would make every app-layer
 * edit run most of the repository — `tests/guards` + `tests/guardrails` alone
 * is ~888 suites and ~13 minutes — because a transitive closure over a types
 * barrel reaches nearly everything (`src/app-layer/types.ts` reaches 805
 * suites across seven roots).
 *
 * So the selection is per SUITE. Owner ruling 2026-11-15, choosing this over
 * both "add the cheap roots" and "accept and document". It is the only option
 * that still works when the next root appears.
 *
 * #3030 is the case that cost a cycle: a push-link literal in
 * `usecases/channels.ts` is asserted exactly by `channel-mention-notifies.test.ts`,
 * and `verify:changed` derived 2,248 suites across five roots without that one.
 *
 * ## ADDITIVE, never a substitute
 *
 * This answers "which suites REFERENCE this module". It cannot answer "which
 * guards fire on the SHAPE of this change" — and that second axis is why the
 * content rules exist. A new `codedBadRequest('X')` pulls in the Bulgarian
 * entry guard and the OpenAPI contract, neither of which imports the throwing
 * file. So a caller must ADD what this returns to what the rules already
 * select; replacing them would be faster, narrower, and would lose the class
 * of coverage #2018 built them for.
 *
 * ## Comments are NOT skipped, and that is the opposite of the content rules
 *
 * `verify-changed.mjs` skips comment lines when matching content rules,
 * because a file that merely DISCUSSES a pattern is not a file that does it,
 * and a population explained by "you wrote about it" is noise.
 *
 * Here the cost is REVERSED. A commented-out import adds a suite and costs
 * seconds; a missed edge is a suite that should have run and did not, which is
 * the gap this module exists to close. So every line is scanned, which also
 * means no comment blanker is hand-rolled in a script — the thing
 * `comment-stripper-order` exists to distrust, and the hazard CLAUDE.md
 * records as having swallowed code once already.
 *
 * The practical effect is small: a commented-out import is rare, and when it
 * happens the penalty is one extra suite rather than a whole root.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** jest collects `*.test.ts(x)`; a `*.spec.ts` under tests/e2e is Playwright's. */
export const IS_JEST_TEST = /\.test\.tsx?$/;

/**
 * `from '@/x'`, `from './x'`, `require('./x')`, `import('@/x')`.
 *
 * The same shape `verify-changed-covers-app-layer` uses, and it must stay that
 * way: an integration suite reaches a usecase by its ALIAS, so a pattern that
 * handled relative specifiers only would miss most of the real edges.
 */
const SPEC = /(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g;

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * `src/a/b.ts` and `src/a/b/index.ts` both resolve to the stem `src/a/b`, so an
 * importer of either is found under one key.
 */
export const stemOf = (f) => f.replace(/\.tsx?$/, '').replace(/\/index$/, '');

/** Tracked `.ts`/`.tsx` under the given roots, repo-relative and POSIX. */
export function trackedSources(repoRoot, roots = ['src', 'tests']) {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...roots], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return out
        .split('\0')
        .filter((f) => /\.tsx?$/.test(f))
        .map(toPosix);
}

/**
 * stem → the files that import it.
 *
 * Built once per process. Reading ~2,900 files costs well under a second,
 * which is the right trade against a wrong population costing a CI cycle.
 */
export function buildImporterGraph(repoRoot, files) {
    const importersOf = new Map();
    for (const f of files) {
        let src;
        try {
            src = readFileSync(path.join(repoRoot, f), 'utf8');
        } catch {
            // A file listed by git but absent from disk (a deletion in the
            // working tree). Skipping it is right: it imports nothing now.
            continue;
        }
        for (const m of src.matchAll(SPEC)) {
            const spec = m[1];
            let target;
            if (spec.startsWith('@/')) target = `src/${spec.slice(2)}`;
            else if (spec.startsWith('.')) {
                target = toPosix(path.normalize(path.join(path.dirname(f), spec)));
            } else continue; // a bare specifier is a package, not a file here
            const stem = stemOf(target);
            const list = importersOf.get(stem);
            if (list) list.add(f);
            else importersOf.set(stem, new Set([f]));
        }
    }
    return importersOf;
}

/**
 * Every jest test file that reaches `file`, following source→source edges.
 *
 * Breadth-first over importers. A test file is a LEAF: a suite that imports
 * another suite's helper is reached through the helper, and following edges out
 * of a test would walk into its own fixtures for no gain.
 */
export function suitesReaching(importersOf, file) {
    const seen = new Set([file]);
    const queue = [file];
    const suites = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        for (const importer of importersOf.get(stemOf(current)) ?? []) {
            if (seen.has(importer)) continue;
            seen.add(importer);
            if (IS_JEST_TEST.test(importer)) suites.add(importer);
            else queue.push(importer);
        }
    }
    return suites;
}

/**
 * The suites reaching any of `changedFiles`, EXCLUDING those already covered
 * by a selected root.
 *
 * The exclusion is what keeps this cheap and honest. `tests/unit` is already
 * selected for any source change, so naming 400 individual `tests/unit` suites
 * beside it would be redundant — jest would be handed a path it already walks,
 * and the printed population would overstate what is distinct (the same reason
 * `dedupeAgainstDirectories` exists). What is left is exactly the gap: the
 * suites in roots nothing selected.
 */
export function unreachedSuitesFor(repoRoot, changedFiles, selectedPaths, opts = {}) {
    const sources = changedFiles.filter(
        (f) => /^(src|scripts)\//.test(f) && /\.tsx?$/.test(f) && !IS_JEST_TEST.test(f),
    );
    if (sources.length === 0) return { suites: [], scanned: 0, sources: 0 };

    const files = opts.files ?? trackedSources(repoRoot);
    const importersOf = opts.graph ?? buildImporterGraph(repoRoot, files);

    const covered = (suite) =>
        selectedPaths.some((sel) => suite === sel || suite.startsWith(`${sel}/`));

    const suites = new Set();
    for (const f of sources) {
        for (const suite of suitesReaching(importersOf, f)) {
            if (!covered(suite)) suites.add(suite);
        }
    }
    return { suites: [...suites].sort(), scanned: files.length, sources: sources.length };
}

/**
 * When a root's selected suites are MOST of that root, name the root instead.
 *
 * Measured 2026-11-15 on the real tree (2,563 jest suites: `tests/unit` 1,071,
 * `tests/guards` 783, `tests/integration` 288, `tests/rendered` 285,
 * `tests/guardrails` 109, `tests/contracts` 11, `tests/pdf` 5,
 * `tests/drills` 1):
 *
 *   src/app-layer/types.ts        24 of 783 guards (3%)   -> list them
 *   src/lib/auth/guard.ts          8 of 783 guards (1%)   -> list them
 *   src/components/ui/button.tsx 168 of 285 rendered (59%) -> name the root
 *
 * Two reasons, and the second is the one that would otherwise bite. Running
 * 59% of a root as individual paths saves almost nothing against running the
 * root, so the precision buys no time. And the population print is meant to be
 * READ — 168 suite paths bury the `why` lines that make it readable, which is
 * the output `--explain` exists for.
 *
 * 50% is a judgement, not a measurement. It is deliberately generous: the cost
 * of collapsing too eagerly is minutes of extra tests, and the cost of not
 * collapsing is an unreadable population, so the threshold leans toward
 * naming the root.
 */
export const COLLAPSE_FRACTION = 0.5;

export function rootOf(file) {
    return file.split('/').slice(0, 2).join('/');
}

/** `{ root: suiteCount }` over every jest suite in the tree. */
export function suiteCountByRoot(files) {
    const counts = new Map();
    for (const f of files) {
        if (!IS_JEST_TEST.test(f)) continue;
        const r = rootOf(f);
        counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    return counts;
}

/**
 * Collapse per-root. Returns the jest paths to pass, plus what was collapsed,
 * so a caller can explain itself rather than silently naming a whole root —
 * a selection nobody can see the reason for is the thing `--explain` exists
 * to prevent.
 */
export function collapseByRoot(suites, counts, fraction = COLLAPSE_FRACTION) {
    const byRoot = new Map();
    for (const s of suites) {
        const r = rootOf(s);
        const list = byRoot.get(r);
        if (list) list.push(s);
        else byRoot.set(r, [s]);
    }
    const paths = [];
    const collapsed = [];
    for (const [root, list] of byRoot) {
        const total = counts.get(root) ?? 0;
        if (total > 0 && list.length / total >= fraction) {
            paths.push(root);
            collapsed.push({ root, selected: list.length, total });
        } else {
            paths.push(...list);
        }
    }
    return { paths: paths.sort(), collapsed };
}
