/**
 * An exemption can be dead because it is IRRELEVANT, not because its file is
 * gone — #2414.
 *
 * ## The gap this closes
 *
 * `exemption-entries-name-something-real` (#2377) checks that every
 * file-shaped exemption entry names a file that EXISTS. That catches one class
 * and is blind to a second:
 *
 * | class | file | still violates | caught by |
 * | --- | --- | --- | --- |
 * | gone | absent | n/a | #2377's guard |
 * | **irrelevant** | **present** | **no** | **nothing, until this** |
 * | live | present | yes | n/a — it is working |
 *
 * An existence check cannot separate rows 2 and 3: both resolve. An
 * irrelevant entry reads as "this file is a known, accepted violation" when
 * the file is clean, and removing it changes no verdict — which is precisely
 * why nothing notices.
 *
 * ## Why a helper the guard calls, and not a cross-guard scan
 *
 * The check needs the guard's OWN ban. #2377's scan reads exemption lists
 * generically, by constant NAME, and does not know what any individual guard
 * forbids. A cross-guard job that INFERRED each banned pattern would be
 * guessing, and a guard that guesses is worse than one with a stated limit.
 *
 * So the pattern is supplied by the only code that knows it — `violates` is
 * the guard's own predicate — and the check lives here once rather than as 89
 * hand-written copies.
 *
 * ## It is strictly stronger than existence
 *
 * A deleted file cannot violate, so it fails this too. A guard adopting this
 * does not also need the existence check.
 *
 * ## The comment-only rationale is self-refuting
 *
 * Measured on the first adopter: 2 of 5 entries in `no-compact-filter-bar`'s
 * ALLOWLIST were irrelevant, and BOTH were justified as referencing the banned
 * string "in comments or docstrings". That guard bans the string in
 * `blankNonCode(src)` — comments already blanked. **Any entry whose stated
 * reason is "it only appears in a comment" necessarily exempts nothing**, for
 * every guard that blanks before matching. Worth checking first when adopting
 * this: the rationale names the class.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode, type BlankOptions } from './blank-non-code';

export interface AllowlistLivenessReport {
    /** Present, and still matches the guard's ban — doing its job. */
    live: string[];
    /** Present, but does NOT match — exempting nothing. */
    irrelevant: string[];
    /** Does not resolve to a file at all. */
    missing: string[];
    /** Resolves, but to a directory — this helper cannot judge it. */
    notAFile: string[];
}

export interface AllowlistLivenessOptions {
    /** Names the guard in failure output, so a shared helper's throw says WHOSE list. */
    label: string;
    /** Repo-relative, file-shaped entries. */
    entries: readonly string[];
    /**
     * The guard's own ban, applied to the file's (optionally blanked) text.
     * `true` means "this file still violates", i.e. the exemption is earning
     * its place.
     */
    violates: (code: string, relativePath: string) => boolean;
    /**
     * Passed to `blankNonCode` so the helper applies the SAME transform the
     * guard does. Getting this wrong is the difference between judging code
     * and judging comments — see the note above.
     */
    blankOptions?: BlankOptions;
    /**
     * Repo root. Defaults to two levels above this file, which is where
     * `tests/helpers` sits.
     */
    repoRoot?: string;
}

const DEFAULT_ROOT = path.resolve(__dirname, '../..');

/**
 * Classify every entry and throw unless all of them are live.
 *
 * Returns the report on success so a caller can print its denominator — a
 * guard that cannot say how many entries it checked is a gate that cannot say
 * what it covers.
 */
export function assertAllowlistIsLive(
    opts: AllowlistLivenessOptions,
): AllowlistLivenessReport {
    const root = opts.repoRoot ?? DEFAULT_ROOT;
    const report: AllowlistLivenessReport = {
        live: [],
        irrelevant: [],
        missing: [],
        notAFile: [],
    };

    for (const rel of opts.entries) {
        const abs = path.resolve(root, rel);

        // ONE filesystem call, classified by its error — not `existsSync`
        // then `readFileSync`.
        //
        // The first version did exactly that, and CodeQL flagged it high
        // severity: `js/file-system-race`, the check-then-use (TOCTOU) race
        // where the path can change between the two calls. In a test helper
        // reading the repo that is not an exploitable hole, but the rule is
        // pointing at real sloppiness — the second call can fail for reasons
        // the first said were impossible, and the `!isFile()` branch then
        // depends on a stat that may already be stale.
        //
        // Reading once and classifying by `code` removes the window and is
        // shorter: ENOENT is "gone", EISDIR is "a directory", and anything
        // else is a real problem that must not be swallowed into a verdict.
        let text: string;
        try {
            text = fs.readFileSync(abs, 'utf-8');
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                report.missing.push(rel);
                continue;
            }
            if (code === 'EISDIR') {
                // Not judged rather than guessed: a directory-shaped entry
                // needs a walk, and which files inside it the guard means is
                // the guard's business. Reported so it cannot pass as checked.
                report.notAFile.push(rel);
                continue;
            }
            // EACCES, ELOOP, EMFILE — a failure this helper cannot interpret.
            // Rethrowing is deliberate: folding it into `missing` would report
            // "the exemption is dead" on evidence that says nothing of the
            // kind.
            throw err;
        }

        const code = blankNonCode(text, opts.blankOptions ?? {});
        if (opts.violates(code, rel)) report.live.push(rel);
        else report.irrelevant.push(rel);
    }

    const problems: string[] = [];
    if (report.missing.length > 0) {
        problems.push(
            `GONE (${report.missing.length}): ${report.missing.join(', ')}\n`
                + `    The file does not exist, so the exemption cannot be excusing anything.`,
        );
    }
    if (report.irrelevant.length > 0) {
        problems.push(
            `IRRELEVANT (${report.irrelevant.length}): ${report.irrelevant.join(', ')}\n`
                + `    The file exists and does NOT match this guard's ban, so the exemption\n`
                + `    exempts nothing. Removing it changes no verdict — which is what makes it\n`
                + `    misleading: it reads as an accepted violation over a clean file.\n`
                + `    If the only occurrences are in COMMENTS and this guard blanks comments\n`
                + `    before matching, the entry was never needed. Delete it.`,
        );
    }
    if (report.notAFile.length > 0) {
        problems.push(
            `NOT A FILE (${report.notAFile.length}): ${report.notAFile.join(', ')}\n`
                + `    This helper judges file-shaped entries only and will not guess at a\n`
                + `    directory. Check it in the guard, or pass only files.`,
        );
    }

    if (problems.length > 0) {
        throw new Error(
            `${opts.label}: ${report.live.length} of ${opts.entries.length} exemption(s) are live.\n\n`
                + `${problems.join('\n\n')}\n`,
        );
    }

    return report;
}
