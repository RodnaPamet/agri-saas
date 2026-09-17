/**
 * The `selector-teeth` CI job must audit EVERY directory that holds guards.
 *
 * ## What this cost
 *
 * The job's pathspec was `git diff --name-only "$BASE" HEAD --
 * 'tests/guards/*.test.ts'` — one directory. `tests/guardrails/` is **102 of
 * the 621 guard files** and was never audited, not even by a PR that changed
 * one. Such a PR got `no guard files changed in this PR` and a green tick.
 *
 * That is the empty-selection defect the job exists to find, in the job's own
 * selector. And it compounded: `parcel-authoring-coverage.test.ts`, one of the
 * two genuinely dead selectors the parser rewrite (#972) surfaced, lives in
 * `tests/guardrails/`. It was hidden twice over — the harness could not see its
 * `walk()` because the line scanner's describe/it gate had stuck, and CI would
 * not have audited the file even if it could.
 *
 * ## Why a guard and not just a wider glob
 *
 * A wider glob fixes today. This fails when a THIRD guard directory appears
 * and nobody widens it again — which is the same failure with a different
 * directory name, and it would be just as silent.
 *
 * Both sides are DERIVED:
 *
 *   - the covered set, from the pathspecs in `.github/workflows/ci.yml`
 *   - the required set, from `GUARD_DIRS` in
 *     `tests/guards/file-collection-is-not-silently-empty.test.ts`, which is
 *     the repo's existing answer to "where do guards live" and is what the
 *     223-entry collector record is built over
 *
 * Neither is restated here, so this guard cannot drift into agreeing with
 * itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const CI_YML = path.join(ROOT, '.github/workflows/ci.yml');
const META_GUARD = path.join(ROOT, 'tests/guards/file-collection-is-not-silently-empty.test.ts');

/** The `git diff` pathspecs the selector-teeth audit step passes. */
function auditedPathspecs(): string[] {
    const ci = fs.readFileSync(CI_YML, 'utf8');
    const line = ci
        .split('\n')
        .find((l) => l.includes('git diff --name-only') && l.includes('selector') === false && l.includes('ALL <'));
    if (!line) return [];
    return [...line.matchAll(/'([^']+\.test\.ts)'/g)].map((m) => m[1]);
}

/** The directories the repo already calls its guard directories. */
function declaredGuardDirs(): string[] {
    const src = fs.readFileSync(META_GUARD, 'utf8');
    const m = src.match(/const GUARD_DIRS\s*=\s*\[([^\]]+)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const PATHSPECS = auditedPathspecs();
const GUARD_DIRS = declaredGuardDirs();

/**
 * The `.test.ts` files in one guard directory.
 *
 * Collected through `collectSourceFiles` (#865), so a missing directory and an
 * empty one both THROW rather than returning `[]`. That is the assertion this
 * guard wants anyway: a guard directory that resolves to nothing is exactly
 * the state it exists to report, and a helper that returns an empty array
 * would make it look covered.
 */
const guardFilesIn = (dir: string): string[] =>
    collectSourceFiles({
        roots: [dir],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith('.test.ts'),
        floor: 1,
    });

describe('selector-teeth audits every guard directory', () => {
    describe('both sides were actually read', () => {
        it('the CI audit step yielded pathspecs', () => {
            // Without this, a renamed job or a reformatted line makes every
            // assertion below compare two empty sets and pass — the exact
            // shape this guard exists to prevent, one level up.
            expect(PATHSPECS.length).toBeGreaterThan(0);
        });

        it('the meta-guard yielded guard directories', () => {
            expect(GUARD_DIRS.length).toBeGreaterThan(1);
        });

        it('every declared guard directory exists and holds .test.ts files', () => {
            for (const dir of GUARD_DIRS) {
                // `guardFilesIn` throws on a missing root AND on an empty
                // result, so this covers both without either looking like the
                // other.
                expect(() => guardFilesIn(dir)).not.toThrow();
                expect(guardFilesIn(dir).length).toBeGreaterThan(0);
            }
        });
    });

    it('every guard directory is covered by a CI pathspec', () => {
        const coveredDirs = new Set(PATHSPECS.map((p) => path.posix.dirname(p)));
        const uncovered = GUARD_DIRS.filter((d) => !coveredDirs.has(d));
        if (uncovered.length > 0) {
            const counts = uncovered
                .map((d) => `  ${d}  (${guardFilesIn(d).length} guard files, audited by NOTHING)`)
                .join('\n');
            throw new Error(
                `The selector-teeth job does not audit every guard directory.\n${counts}\n\n` +
                    `Its pathspecs are: ${PATHSPECS.join(', ')}\n` +
                    `Add the missing directory to the \`git diff --name-only\` pathspec list in ` +
                    `.github/workflows/ci.yml. A PR that changes a guard in an uncovered ` +
                    `directory reports "no guard files changed" and passes — which is a green ` +
                    `tick over an audit that examined nothing.`,
            );
        }
        expect(uncovered).toEqual([]);
    });

    it('no pathspec names a directory that does not exist', () => {
        // The other direction. A pathspec pointing at a renamed directory
        // matches nothing, and "matched nothing" is indistinguishable from
        // "nothing changed" in the job's output.
        const missing = PATHSPECS.filter((p) => !fs.existsSync(path.join(ROOT, path.posix.dirname(p))));
        expect(missing).toEqual([]);
    });
});
