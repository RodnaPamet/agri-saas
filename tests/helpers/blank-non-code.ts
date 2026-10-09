/**
 * Blank the parts of a source file that are not code, keeping every character
 * POSITION (#1387).
 *
 * Two source-text guards asked a question about semantics and got prose
 * instead, in different ways:
 *
 *   `no-server-authored-user-copy`  counted a COMMENT quoting
 *                                  `forbidden('Permission denied')` as a
 *                                  thrown message. Five of its 502 hits were
 *                                  prose about a throw.
 *   `error-params-carry-no-pii`     read a template literal's `${…}` as the
 *                                  call's params object, because `${x}`
 *                                  contains a `{x}`.
 *
 * They need different amounts blanked, which is why this takes an option
 * rather than being one function. The copy ratchet's whole subject is the
 * string literals, so blanking those would blind it completely; the params
 * guard's subject is an object literal, so every string is noise to it.
 *
 * ## Positions are preserved, and that is load-bearing
 *
 * Both callers find a match and then scan FORWARD from its index into the
 * same string — `argsAfter`, `argsOf`. A transform that shortened a line
 * would leave those offsets pointing at the wrong place, so every blanked
 * character becomes a space and every newline survives. Offsets and line
 * numbers are identical to the input.
 *
 * ## One linear scan, not layered regexes
 *
 * The tempting implementation is two `String.replace` passes, and the ORDER
 * of those passes is a trap that has cost this repo real time twice over:
 *
 *   • blocks before lines — the line `// deploy/rollback/*.down.sql` has a
 *     `/*` in it, which opens a block comment that runs to the next `*&#47;`.
 *     In `src/lib/schemas/index.ts` that swallowed 102 lines and ten
 *     `export const` declarations, and the only symptom was a population
 *     count of 18 where the file has 28.
 *   • lines before blocks, naively — `'see https://…'` inside a string has a
 *     `//` in it, so cutting to end-of-line blanks real arguments and makes a
 *     ratchet UNDER-count, which is the direction that hides work.
 *
 * A single left-to-right pass that knows which construct it is inside has
 * neither problem, because a `//` inside a string is never reached as a
 * comment and a `/*` inside a line comment is never reached as an opener.
 * That it holds by construction rather than by passing today's corpus is the
 * reason for doing it this way.
 *
 * ## It replaced `tests/helpers/strip-comments.ts`, which is now DELETED (#1442)
 *
 * That helper came first and had two differences, only the first of which is
 * why this module was written:
 *
 *   • It DELETED comments; this one blanks them to spaces. Every caller here
 *     scans forward from a match index into the same string, so deleting
 *     would leave those offsets pointing at the wrong place. Positions are
 *     not a nicety for these guards; they are the contract.
 *   • It ran blocks before lines, so it had the first trap above — measured
 *     to delete 10 exported declarations from `src/lib/schemas/index.ts` and
 *     499 lines of `src/auth.ts`.
 *
 * Its three consumers moved here and it was removed. **No guard changed
 * verdict in the move** — all 18 of their assertions passed before and after,
 * and the full suite stayed at 693 suites green. So the bug was latent in
 * those three populations rather than hiding a violation: worth fixing
 * because the next file to grow a `//` line containing `/*` would have been
 * silently excised, not because something was being missed.
 *
 * The old helper also spared a TRAILING `//` deliberately, to avoid
 * truncating a regex or a URL string — a real trade, because a line-level
 * regex cannot tell those apart. This pass is state-aware and gets that for
 * free, so the limitation went with the file rather than being ported.
 *
 * **What this did NOT fix:** roughly 28 test files declare their OWN local
 * `stripComments`, most of them with the same block-before-line ordering.
 * Those are untouched here and are the larger half of the problem — a shared
 * helper has one place to fix, and a copied one has 28.
 */

export interface BlankOptions {
    /**
     * Also blank string and template literals.
     *
     * Off by default: a guard whose subject is the text of a message must
     * keep its strings. On for a guard looking for code structure — an object
     * literal, a call shape — where a brace inside a string or a `${…}` is
     * indistinguishable from the thing being looked for.
     */
    strings?: boolean;
}

/**
 * Returns `src` with comments (and optionally string literals) replaced by
 * spaces, character-for-character, newlines intact.
 */
export function blankNonCode(src: string, opts: BlankOptions = {}): string {
    const out = [...src];
    const blankRange = (from: number, to: number): void => {
        for (let j = from; j < to; j++) if (src[j] !== '\n') out[j] = ' ';
    };

    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const d = src[i + 1];

        // ── string and template literals ──
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            const start = i;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (src[i] === quote) {
                    i++;
                    break;
                }
                i++;
            }
            // Deliberately NOT recursing into `${…}`. A template's
            // interpolation can hold any expression, including another
            // template, and for both callers the whole literal is either the
            // subject (keep it) or noise (blank it) — never half of each.
            if (opts.strings) blankRange(start, i);
            continue;
        }

        // ── line comment ──
        if (c === '/' && d === '/') {
            const start = i;
            while (i < src.length && src[i] !== '\n') i++;
            blankRange(start, i);
            continue;
        }

        // ── block comment ──
        if (c === '/' && d === '*') {
            const close = src.indexOf('*/', i + 2);
            // An unterminated block comment runs to end of file, which is what
            // a compiler does too. Treating it as "no comment" would be the
            // worse guess: a file that fails to parse would be scanned as
            // though all of it were code.
            const stop = close === -1 ? src.length : close + 2;
            blankRange(i, stop);
            i = stop;
            continue;
        }

        i++;
    }
    return out.join('');
}
