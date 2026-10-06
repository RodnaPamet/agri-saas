/**
 * Remove comments from TS/TSX source so a guard greps CODE, not prose.
 *
 * Guards that match raw source are routinely fooled by a docblock EXPLAINING
 * the thing they ban — a comment reading "this must never call `foo()`" is
 * indistinguishable from a call to `foo()` under a plain `grep`. I have shipped
 * that bug: a reachability guard matched its own docblock describing why it
 * could not use `useNavSections()`.
 *
 * ── the deliberate limitation ──
 *
 * Only line comments that START a line are removed. A TRAILING `//` is left
 * alone, because stripping from the first `//` on a line corrupts two very
 * common things:
 *
 *     const RE = /https?:\/\/.../     ← a regex literal containing //
 *     const url = 'https://x.test'    ← a string containing //
 *
 * …and a guard that silently truncated those would mis-read the code it is
 * grading, which is worse than missing a trailing comment. Callers that need
 * trailing comments gone should assert against a line-level window instead.
 *
 * A guard using this MUST also assert the stripper works — see
 * `tests/guards/slug-derivation-is-converged.test.ts`'s control. A stripper
 * that silently returned '' would make every `not.toMatch` assertion pass.
 */
export function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}
