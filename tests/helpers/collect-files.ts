/**
 * Collect the files a guard scans, and REFUSE to hand back an empty list (#865).
 *
 * ## The measurement this exists for
 *
 * A guard whose unit of work is a selection passes vacuously when the selection
 * is empty: `expect(offenders).toEqual([])` is satisfied by a selector that
 * returns nothing, whether because nothing is wrong or because the selector is
 * broken. A mutation sweep of the 94 guards most at risk found:
 *
 *     47 DEAD        81% of the 58 that could be audited
 *     11 CLEAN
 *     35 NOT AUDITED (selection inline in `it()`, unreachable by the harness)
 *
 * and 37 of the 47 were the same function: a hand-rolled `walk` that could be
 * gutted to `return []` with every assertion built on it still green.
 *
 * ## Why "the root exists" was not enough
 *
 * #875/#876/#894 already made 87 guards throw when a scan ROOT does not
 * resolve. **35 of these 47 carry that throw and are still dead.** A root that
 * resolves says nothing about whether the walk found anything: the filter can
 * match zero files, an exclude predicate can eat everything, and a gutted
 * collector returns `[]` from a directory that exists. The rule has to be
 * asserted on the RESULT, which is what this module does.
 *
 * ## Empty is sometimes the pass
 *
 * `no-tracked-node-modules` asserts that `node_modules` is NOT tracked, so zero
 * files is exactly what it wants. That case is allowed — but only via
 * `expectEmptyBecause`, which forces the reason into the call site instead of
 * letting a floor of zero look like an oversight. Same shape as `EXPECTED_EMPTY`
 * in `scan-roots-resolve.test.ts`.
 *
 * ## A note on what this does to the mutation harness
 *
 * Migrating a guard here REMOVES its module-level `walk`, so
 * `scripts/selector-teeth.mjs` has nothing left to gut in that file and reports
 * it as `NOT AUDITED`. That is not a regression dressed up: the guarantee moves
 * from "we mutated its collector and it noticed" to "its collector cannot
 * return empty at all", which is stronger, and it is asserted here by executing
 * tests rather than inferred from a mutation. The meta-guard
 * (`tests/guards/file-collection-is-not-silently-empty.test.ts`) is what stops
 * a new hand-rolled walk reappearing.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const REPO_ROOT = path.resolve(__dirname, '../..');

/** Directories never worth walking into. */
const DEFAULT_SKIP_DIRS: readonly string[] = ['node_modules', '.next', 'dist', 'coverage', '.git'];

export interface CollectOptions {
    /** Repo-relative directories to walk. Every one must resolve. */
    roots: readonly string[];
    /** File extensions to keep, with the dot. Default `.ts` + `.tsx`. */
    extensions?: readonly string[];
    /** Directory names to skip. Replaces the default when given. */
    skipDirs?: readonly string[];
    /** Drop a file by its repo-relative path. */
    exclude?: (relativePath: string) => boolean;
    /**
     * Minimum files the caller expects. Default 1 — the entire point of the
     * module. Raise it when a guard knows its population is larger; a floor
     * closer to reality catches an exclude predicate that ate too much.
     */
    floor?: number;
    /**
     * Required to pass `floor: 0`. States why zero files is the PASS condition
     * rather than a broken selector, and appears in no failure message — it
     * exists so the decision is visible at the call site and in review.
     */
    expectEmptyBecause?: string;
}

function assertFloor(found: number, opts: CollectOptions, what: string): void {
    const floor = opts.floor ?? 1;
    if (floor === 0 && !opts.expectEmptyBecause) {
        throw new Error(
            `${what}: floor 0 needs expectEmptyBecause. Zero files is either the ` +
                `pass condition or a broken selector, and those must not look alike.`,
        );
    }
    if (found >= floor) return;
    throw new Error(
        [
            `${what}: collected ${found} file(s), expected at least ${floor}.`,
            ``,
            `This guard is about to assert over an EMPTY set, which passes for free.`,
            `Something upstream broke: a renamed directory, an extension filter that`,
            `matches nothing, or an exclude predicate that ate the population.`,
            ``,
            `If zero is genuinely correct here, pass floor: 0 with expectEmptyBecause.`,
        ].join('\n'),
    );
}

/**
 * Walk `roots` and return absolute paths. Throws if a root does not resolve, and
 * throws if the result is below `floor`.
 */
export function collectSourceFiles(opts: CollectOptions): string[] {
    const extensions = opts.extensions ?? ['.ts', '.tsx'];
    const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
    const out: string[] = [];

    for (const root of opts.roots) {
        const abs = path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
        if (!fs.existsSync(abs)) {
            // Kept from #875: a renamed root must name itself rather than
            // quietly contributing nothing to the total.
            throw new Error(
                `scan root does not exist: ${root} — a renamed root would scan zero ` +
                    `files and pass (#875). Update the caller's roots.`,
            );
        }
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (skipDirs.includes(entry.name)) continue;
                    walk(full);
                    continue;
                }
                if (!entry.isFile()) continue;
                if (!extensions.some((e) => entry.name.endsWith(e))) continue;
                const rel = path.relative(REPO_ROOT, full);
                if (opts.exclude?.(rel)) continue;
                out.push(full);
            }
        };
        walk(abs);
    }

    assertFloor(out.length, opts, `collectSourceFiles(${opts.roots.join(', ')})`);
    return out.sort();
}

/**
 * The same contract over `git ls-files`, for guards that scan the INDEX rather
 * than the working tree.
 *
 * `git ls-files <missing-path>` returns empty with exit 0, so the absent-root
 * case is invisible here in a way it is not for a filesystem walk — which is
 * exactly why the floor matters more, not less.
 */
export function collectTrackedFiles(opts: CollectOptions): string[] {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...opts.roots], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    const extensions = opts.extensions;
    const files = out
        .split('\0')
        .filter(Boolean)
        .filter((rel) => !extensions || extensions.some((e) => rel.endsWith(e)))
        .filter((rel) => !opts.exclude?.(rel));

    assertFloor(files.length, opts, `collectTrackedFiles(${opts.roots.join(', ')})`);
    return files.map((rel) => path.join(REPO_ROOT, rel)).sort();
}
