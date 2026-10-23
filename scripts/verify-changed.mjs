#!/usr/bin/env node
/**
 * Derive the test population from a diff, and run it — #2018.
 *
 * ## The problem this exists for
 *
 * Sixteen test roots, no command that runs what CI runs inside the available
 * time, and several guards that fire on a NEW FILE rather than on the code it
 * tests — so a change's blast radius is not inferable from reading its diff.
 * Every push becomes a judgement call about which subset is sufficient, and
 * the issue records three different wrong subsets in one day.
 *
 * ## Two axes, because one of them is where the misses happen
 *
 * **Path rules** answer "which roots care about files in this directory". They
 * are the obvious half and they are not where this goes wrong.
 *
 * **Content rules** answer "what does this diff now treat differently", by
 * grepping the added lines for signals. That is the half that is normally
 * missed, and every miss on #2030 and #2035 was of this kind:
 *
 *   - A new `codedBadRequest('X', …)` needs the Bulgarian-entry guard and the
 *     OpenAPI-spec contract. Neither lives anywhere near the file that raises
 *     the code.
 *   - A stripper that starts REFUSING a format needs every suite holding a
 *     fixture of that format. On #2035 that was 47 suites, 35 of them outside
 *     the set an import-graph derivation produced — and CI found the 36th.
 *
 * So a path-only derivation is the thing that has already failed. Both axes
 * union, never intersect.
 *
 * ## It over-includes on purpose
 *
 * A population that is too large costs minutes. One that is too small costs a
 * CI round trip and, worse, reads as a pass. Where a rule is uncertain it
 * includes more.
 *
 * ## Usage
 *
 *   npm run verify:changed              # derive and run
 *   npm run verify:changed -- --explain # derive, print why, run nothing
 *   npm run verify:changed -- --base=origin/main
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const explainOnly = argv.includes('--explain');
const baseArg = argv.find((a) => a.startsWith('--base='));

function git(...args) {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/**
 * The comparison point. `merge-base` rather than `origin/main` itself, because
 * a two-dot diff against a moved base lists files you never touched — which
 * would inflate the population with other people's changes and make the run
 * both slower and less honest about what it covered.
 */
function resolveBase() {
    if (baseArg) return baseArg.slice('--base='.length);
    for (const ref of ['origin/main', 'main']) {
        try {
            return git('merge-base', 'HEAD', ref);
        } catch {
            /* try the next */
        }
    }
    throw new Error('no origin/main or main to compare against — pass --base=<ref>');
}

/**
 * Added lines only. A REMOVED `codedBadRequest` needs no new entry.
 *
 * Untracked files contribute their WHOLE contents, because every line of a new
 * file is an added line. Without that, a brand-new module raising a brand-new
 * refusal code would match no content rule at all — the case most in need of
 * one.
 */
function addedLines(base, untrackedFiles, excludePaths) {
    // Prose is excluded from CONTENT matching. A content rule asks "what does
    // this change now treat differently", which only code can answer — and
    // documenting these very rules in CLAUDE.md made three of them fire on
    // their own description: the refusal-code rule, the upload-format rule and
    // the eslint-disable warning, all matched against a paragraph explaining
    // them. Over-inclusion is the safe direction so nothing broke, but a
    // population explained by "you wrote about the pattern" is noise in the
    // one output meant to be read.
    //
    // Markdown cannot raise a refusal code. Path rules still cover docs —
    // CLAUDE.md selects both guard directories, because guards quote it.
    const excludes = [...excludePaths.map((p) => `:(exclude)${p}`), ':(exclude)*.md'];
    const diff = git('diff', '--unified=0', base, '--', ...excludes);
    const fromDiff = diff
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .map((l) => l.slice(1));
    const fromNew = untrackedFiles.flatMap((f) => {
        try {
            return readFileSync(path.join(REPO_ROOT, f), 'utf8').split('\n');
        } catch {
            return []; // a directory, or something unreadable
        }
    });
    return [...fromDiff, ...fromNew];
}

/**
 * ── THE RULES ──
 *
 * Data, in `verify-changed.rules.json`, rather than code here. Three reasons,
 * and the third is the one that forced it:
 *
 *   - The mapping is the deliverable this issue asked for ("document the
 *     mapping"), and a JSON file is readable and diffable by someone who is
 *     not reading a script.
 *   - A rule set in data cannot drift from a second copy in CLAUDE.md,
 *     because there is no second copy — CLAUDE.md points here.
 *   - `tests/guards/verify-changed-rules-resolve.test.ts` asserts every `run`
 *     path exists, and jest's `node` project is CJS: it cannot import this
 *     `.mjs` at all. Data is importable from both.
 *
 * `when` is a regex SOURCE string, compiled below. A path rule matches a
 * repo-relative path; a content rule matches an added line.
 */
const RULES = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/verify-changed.rules.json'), 'utf8'),
);
const compile = (rules) => rules.map((r) => ({ ...r, when: new RegExp(r.when) }));
export const PATH_RULES = compile(RULES.pathRules);
export const CONTENT_RULES = compile(RULES.contentRules);

// Guarded, so a test can import the rules without the script executing. The
// rules are the thing worth asserting on — a path in them that no longer
// exists would contribute zero tests and read as a pass.
const INVOKED_DIRECTLY = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (!INVOKED_DIRECTLY) {
    // imported for its rules only
} else {
const base = resolveBase();

/**
 * Tracked changes AND untracked files.
 *
 * `git diff --name-only` cannot see a file that has never been added, and the
 * single most important rule here is "you added a file under tests/" — which
 * is exactly the case where the file is new. Measured on this script's own
 * first run: it reported 1 changed file where there were 2, because itself was
 * untracked.
 *
 * That is the failure shape this whole tool exists to remove: an absence that
 * reads as nothing-to-do. A population derived from `git diff` alone is
 * confidently empty for the change most likely to need the meta-guards.
 */
const files = [
    ...git('diff', '--name-only', base, '--').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
].filter(Boolean);
const untracked = new Set(git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));

if (files.length === 0) {
    console.log(`[verify:changed] no files differ from ${base.slice(0, 9)} — nothing to run.`);
    process.exit(0);
}

/**
 * This file is excluded from CONTENT matching, because its rule patterns
 * appear in its own source as literals and prose — so editing it matched the
 * refusal-code rule, the PDF-format rule and the eslint-disable rule against
 * itself. Over-inclusion is the safe direction and this would be harmless,
 * but a population explained by "you mentioned the pattern in the rule that
 * looks for the pattern" is noise in the one output meant to be readable.
 *
 * Path rules still see it: it lives under `scripts/`, so a change here selects
 * `tests/unit` like any other source change.
 */
const SELF = 'scripts/verify-changed.mjs';
const RULES_FILE = 'scripts/verify-changed.rules.json';
const PROSE = /\.(md|mdx|txt)$/;
const added = addedLines(
    base,
    [...untracked].filter((f) => f !== SELF && f !== RULES_FILE && !PROSE.test(f)),
    [SELF, RULES_FILE],
);
const selected = new Map(); // jest path -> reasons
let lintNeeded = false;

function select(paths, why) {
    for (const p of paths) {
        if (!selected.has(p)) selected.set(p, new Set());
        selected.get(p).add(why);
    }
}

for (const rule of PATH_RULES) {
    const hits = files.filter((f) => rule.when.test(f));
    if (hits.length) select(rule.run, `${rule.why} (matched ${hits.length} file(s))`);
}
/**
 * Comment lines are skipped for CONTENT matching, by the same principle the
 * guards use (`blankNonCode` before matching) and for the same reason: a file
 * that merely DISCUSSES a pattern is not a file that does it.
 *
 * Measured three times while building this: the script's own rule literals,
 * CLAUDE.md's paragraph describing the rules, and the guard test's comment
 * explaining the `eslint-disable` rule all matched the rules they described.
 *
 * A LINE-PREFIX heuristic, not a parser — deliberately. A real stripper here
 * would be a hand-rolled one in a script, which is the thing
 * `comment-stripper-order` exists to distrust, and it would buy only trailing
 * comments: a `codedBadRequest(` or a `markStored(` is at the start of its
 * statement, not after code on the same line. Over-inclusion stays the safe
 * direction, so a missed trailing comment costs minutes rather than a gap.
 */
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
const codeLines = added.filter((l) => !isCommentLine(l));

for (const rule of CONTENT_RULES) {
    const hits = codeLines.filter((l) => rule.when.test(l));
    if (!hits.length) continue;
    if (rule.lintOnly) lintNeeded = true;
    select(rule.run, `${rule.why} (matched ${hits.length} added line(s))`);
}

// Drop a specific test file when its whole directory is already selected —
// otherwise jest is handed a redundant path and the printed population
// overstates what is distinct.
const dirs = [...selected.keys()].filter((p) => !p.endsWith('.ts'));
const population = [...selected.keys()].filter(
    (p) => !dirs.some((d) => p !== d && p.startsWith(`${d}/`)),
);

console.log(
    `[verify:changed] base ${base.slice(0, 9)} · ${files.length} changed file(s)`
        + (untracked.size ? ` (${untracked.size} untracked)` : ''),
);
console.log(`[verify:changed] population: ${population.length} jest path(s)\n`);
for (const p of population.sort()) {
    console.log(`  ${p}`);
    if (explainOnly) for (const why of selected.get(p)) console.log(`      — ${why}`);
}
if (lintNeeded) {
    console.log(
        '\n  !! This diff adds an `eslint-disable`. Run `npm run lint` AFTER your last\n'
        + '     edit — the ceiling counts suppressions, and a run taken earlier is stale.',
    );
}

if (explainOnly) {
    console.log('\n[verify:changed] --explain: nothing run.');
    process.exit(0);
}

for (const p of population) {
    if (!existsSync(path.join(REPO_ROOT, p))) {
        console.error(`\n[verify:changed] selected path does not exist: ${p}`);
        console.error('A renamed root would silently contribute zero tests. Fix the rule.');
        process.exit(1);
    }
}

console.log('\n[verify:changed] running…\n');
try {
    // Paths FIRST. `--selectProjects` swallows paths placed after it, which
    // turns a targeted run into a silent full sweep.
    execFileSync(
        'npx',
        ['jest', ...population, '--runInBand', '--no-coverage'],
        { cwd: REPO_ROOT, stdio: 'inherit' },
    );
} catch {
    console.error('\n[verify:changed] FAILED — see above.');
    process.exit(1);
}
console.log('\n[verify:changed] passed. Note this is the DERIVED population, not CI.');
if (lintNeeded) console.log('[verify:changed] still owed: npm run lint');
}
