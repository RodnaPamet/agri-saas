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

/**
 * Keywords after which a `/` opens a REGEX rather than dividing.
 *
 * Without these, `return /[",\n]/.test(s)` reads as division — the previous
 * significant character is `n`, the last letter of `return` — and the regex's
 * quote characters are then read as string delimiters. That is cause 3 of
 * #2106, found by the contract sweep after the first two were fixed: one file
 * remained, `reports/rent-roll/route.ts:40`, whose line 29 is exactly that.
 *
 * `instanceof` and `in` are here for `x in /re/` shapes, which are rare; the
 * ones that earn their place in this corpus are `return`, `typeof`, `case` and
 * `throw`.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await',
]);

/**
 * Does the `/` at `i` open a regex literal, or divide?
 *
 * Undecidable without a parser; this is the standard heuristic. After a value
 * — an identifier, a digit, `)`, `]`, `}` — a `/` divides. Everywhere else it
 * opens a regex. The exception is a KEYWORD, which looks like an identifier
 * and is not a value.
 */
function opensRegex(src: string, i: number, prevSignificant: string): boolean {
    if (!/[A-Za-z0-9_$)\]}]/.test(prevSignificant)) return true;
    // Looks like a value — unless the trailing word is a keyword.
    if (!/[A-Za-z_$]/.test(prevSignificant)) return false;
    let k = i - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    let end = k + 1;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return REGEX_PRECEDING_KEYWORDS.has(src.slice(k + 1, end));
}

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
    // `split('')` yields CODE UNITS. `[...src]` yields code POINTS, which is
    // the bug #2106 was filed for: a surrogate pair is one code point and two
    // code units, while every index below comes from `src[j]` — code units. So
    // after the first astral character the writes landed on the wrong element,
    // and because `out[j] = ' '` replaced a two-unit element with one space,
    // the output SHRANK. It also overwrote newlines: measured on
    // `src/lib/processes/canvas-auto-layout.ts`, 290 lines became 210.
    const out = src.split('');
    const blankRange = (from: number, to: number): void => {
        for (let j = from; j < to; j++) if (src[j] !== '\n') out[j] = ' ';
    };

    /**
     * The last significant code unit of CODE seen, used only to tell `/` as
     * division from `/` as a regex opener. Unset at the start of the file,
     * where a `/` can only be a regex.
     */
    let prevSignificant = '';

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
            prevSignificant = quote;
            continue;
        }

        // ── line comment ──
        if (c === '/' && d === '/') {
            const start = i;
            while (i < src.length && src[i] !== '\n') i++;
            blankRange(start, i);
            continue;
        }

        // ── regex literal ──
        //
        // Not blanked — a regex is CODE. The reason this state exists at all
        // is that its quote characters were being read as string delimiters:
        // `src/lib/geo/basemap-bundle-scan.ts` holds
        // `/NEXT_PUBLIC_MAPTILER_KEY:"[^"]+"/`, three double quotes, so the
        // third opened a string that ran to the next quote anywhere below —
        // and with `strings: false` (the default) that whole region passed
        // through UNBLANKED, making every comment after it read as code.
        //
        // Division or regex is decided by the previous significant character,
        // which is the standard approach and cannot be perfect without a
        // parser. After an identifier, a digit, `)`, `]` or `}` a `/` is
        // division; anywhere else it opens a regex. Decisive for the real
        // corpus: a regex assigned to a `const`, passed as an argument, or
        // used in `.test(...)` is always the second case.
        if (c === '/' && d !== '/' && d !== '*' && opensRegex(src, i, prevSignificant)) {
            const start = i;
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < src.length) {
                const e = src[j];
                if (e === '\\') {
                    j += 2;
                    continue;
                }
                // A newline inside an unterminated literal means this was not
                // a regex. Bailing out matters: swallowing to the next `/`
                // anywhere below is exactly the failure this state fixes,
                // reintroduced from the other side.
                if (e === '\n') break;
                if (e === '[') inClass = true;
                else if (e === ']') inClass = false;
                else if (e === '/' && !inClass) {
                    j++;
                    while (j < src.length && /[a-z]/.test(src[j])) j++; // flags
                    closed = true;
                    break;
                }
                j++;
            }
            if (closed) {
                i = j;
                prevSignificant = '/';
                continue;
            }
            // Not a regex after all — fall through and treat it as an
            // ordinary character.
            i = start;
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

        if (!/\s/.test(c)) prevSignificant = c;
        i++;
    }
    return out.join('');
}
