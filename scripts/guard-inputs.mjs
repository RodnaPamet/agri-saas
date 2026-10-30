#!/usr/bin/env node
/**
 * Which guards READ a file — so a change to that file can audit them (#2377 §2).
 *
 * ## The gap this closes
 *
 * `selector-teeth` audits guards whose FILE changed. A guard can be made
 * vacuous without its file being touched at all: #2376's
 * `isDeclaredUnbacked` died because #2367 changed the runbook it reads, so
 * `drilled !== unbacked` became `true !== false` and the second predicate
 * stopped mattering. The guard was untouched, so nothing audited it. It
 * surfaced because an unrelated PR went red on content already in main —
 * luck, not process.
 *
 * So the audit's trigger needs a second input: guards whose INPUTS changed.
 *
 * ## It is deliberately the weaker half, and here is the boundary
 *
 * This is SAME-PR only. It catches #2376's case because the runbook changed in
 * the same PR as nothing — but had the runbook changed three PRs earlier with
 * the guard untouched, this window misses it exactly as completely as the
 * file-only trigger does. #2377 ranks the vacuity property above it for that
 * reason, and this does not replace it.
 *
 * ## Coverage, measured rather than hoped
 *
 * Over the audit's four roots (guards, guardrails, contracts, regression),
 * 840 guard files:
 *
 *   670  have at least one statically resolvable path-literal input (80%)
 *   169  read only globs / `readdirSync` / `git ls-files` — no literal to map
 *     1  has no discoverable input at all
 *
 * 2,374 guard→input edges. The 169 are the residue #2377 names: a guard that
 * computes its population cannot have it derived from source, and this script
 * says so rather than pretending the map is total. `--map` prints the
 * denominator for exactly that reason.
 *
 * ## Why literals and not an import graph
 *
 * These guards read FILES, not modules — `readFileSync(join(ROOT, 'x.yml'))`.
 * An import graph sees none of that. The literal is the dependency, so the
 * literal is what is matched, and it is checked against `git ls-files` so a
 * string that merely looks like a path does not invent an edge.
 *
 * Usage:
 *   node scripts/guard-inputs.mjs --map                      # the map + denominator
 *   node scripts/guard-inputs.mjs --guards-for <path>...     # guards reading those paths
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

export const GUARD_GLOBS = [
    'tests/guards/*.test.ts',
    'tests/guardrails/*.test.ts',
    'tests/contracts/*.test.ts',
    'tests/regression/*.test.ts',
];

/**
 * A quoted literal that looks like a repo path AND is tracked.
 *
 * The tracked check is load-bearing: `'utf8'`, `'node:fs'` and
 * `'2026-10-30'` all survive a shape-only filter, and each would add a
 * phantom edge that makes the map look broader than it is.
 */
const PATH_LITERAL = /['"`]([A-Za-z0-9_@][A-Za-z0-9_./@-]*\.[A-Za-z0-9]{1,5})['"`]/g;

const trackedFiles = () =>
    new Set(execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean));

const guardFiles = () =>
    execFileSync('git', ['ls-files', '--', ...GUARD_GLOBS], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);

/** guard path -> sorted repo-relative inputs it reads by literal. */
export function buildMap({ tracked = trackedFiles(), guards = guardFiles() } = {}) {
    const map = new Map();
    for (const guard of guards) {
        const src = readFileSync(guard, 'utf8');
        const inputs = new Set();
        for (const [, lit] of src.matchAll(PATH_LITERAL)) {
            const rel = lit.replace(/^\.\//, '');
            // A guard reading ITSELF is not an edge worth recording: the
            // file-changed trigger already covers that case, and keeping it
            // would double every guard's own entry.
            if (rel === guard) continue;
            if (tracked.has(rel)) inputs.add(rel);
        }
        if (inputs.size) map.set(guard, [...inputs].sort());
    }
    return map;
}

/**
 * An input read by MORE guards than this is too broad to target, and is not
 * used to select anything.
 *
 * Found by simulating the CI step rather than by reasoning: a diff touching
 * `package.json` selected **46** guards, and every dependency bump touches
 * `package.json`. At roughly 400s per selector that is hours of runner time on
 * every Dependabot PR, which would get this window switched off — and the
 * window's whole value is that it is targeted.
 *
 * Measured fanout over 1,153 distinct inputs:
 *
 *    760  read by exactly 1 guard      (66% — perfectly targeted)
 *    270  by 2-3
 *    100  by 4-9
 *     18  by 10-24
 *      5  by 25+   (package.json 44, PersistedProcessCanvas 36, nav-item 32,
 *                   tailwind.config.js 25, tokens.css 25)
 *
 * So a ceiling of 10 drops 21 inputs — 1.8% — and keeps 98%, while bounding
 * the worst case at 9 guards per changed input. `docs/backup-restore.md`, the
 * input the originating case turns on, has fanout 3 and is unaffected.
 *
 * This is NOT the `MAX_GUARDS` cap #2417 removed, and the difference matters.
 * That cap dropped an arbitrary SUFFIX of a list and emitted a `::warning::`
 * in a green job, so the audit silently covered a subset. This excludes a
 * NAMED, reported set on a stated property — a file 10+ guards read is a
 * shared foundation, and an edit to it is a broad change that the
 * file-changed trigger and the ordinary suite already cover. `--map` prints
 * every exclusion, so it cannot quietly grow.
 */
export const FANOUT_CEILING = 10;

/** input -> how many guards read it. */
export function fanout(map = buildMap()) {
    const f = new Map();
    for (const [, inputs] of map) for (const i of inputs) f.set(i, (f.get(i) ?? 0) + 1);
    return f;
}

/** Inputs too widely read to target, with their fanout. */
export function tooBroad(map = buildMap()) {
    return [...fanout(map)].filter(([, n]) => n > FANOUT_CEILING).sort((a, b) => b[1] - a[1]);
}

/** The guards to audit because one of these paths changed. */
export function guardsFor(changed, map = buildMap()) {
    const broad = new Set(tooBroad(map).map(([i]) => i));
    const want = new Set(
        changed.map((c) => c.replace(/^\.\//, '')).filter((c) => !broad.has(c)),
    );
    const out = [];
    for (const [guard, inputs] of map) {
        if (inputs.some((i) => want.has(i))) out.push(guard);
    }
    return out.sort();
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('guard-inputs.mjs');
if (invokedDirectly) {
    const args = process.argv.slice(2);
    const map = buildMap();
    if (args.includes('--map')) {
        const guards = guardFiles();
        const edges = [...map.values()].reduce((n, v) => n + v.length, 0);
        // The denominator, printed. A map over nothing would otherwise read
        // the same as a map over everything — the failure this repo keeps
        // finding one level up from wherever it looks.
        const broad = tooBroad(map);
        console.log(
            `[guard-inputs] ${guards.length} guard file(s); ${map.size} with resolvable inputs `
                + `(${edges} edge(s)); ${guards.length - map.size} read only globs or computed paths; `
                + `${broad.length} input(s) too broad to target (fanout > ${FANOUT_CEILING})`,
        );
        // Named, never merely counted. A cap that says "some were dropped" is
        // the shape #2417 removed; this says which, and why each one is here.
        for (const [input, n] of broad) {
            console.log(`  [too-broad] ${input} is read by ${n} guards — not used for selection`);
        }
        for (const [guard, inputs] of [...map].sort()) {
            console.log(`  ${guard}`);
            for (const i of inputs) console.log(`      ${i}`);
        }
    } else {
        const changed = args.filter((a) => !a.startsWith('--'));
        if (!changed.length) {
            console.error('usage: guard-inputs.mjs --guards-for <changed path>...   |   --map');
            process.exit(2);
        }
        for (const g of guardsFor(changed, map)) console.log(g);
    }
}
