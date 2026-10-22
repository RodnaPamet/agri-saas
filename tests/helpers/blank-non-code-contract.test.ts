/**
 * `blankNonCode` keeps every position — asserted over the whole of `src/`.
 *
 * ## The contract, which was prose until now
 *
 * The helper's docblock states it:
 *
 *   > every blanked character becomes a space and every newline survives.
 *   > Offsets and line numbers are identical to the input.
 *
 * and says why it is load-bearing: both original callers find a match and then
 * scan FORWARD from its index into the same string (`argsAfter`, `argsOf`), so
 * a transform that shortened a line leaves those offsets pointing at the wrong
 * place. **224 test files** import this helper — 179 in `tests/guards`, 21 in
 * `tests/guardrails`, 20 in `tests/unit`, 2 in `tests/contracts`, 2 in
 * `tests/helpers`.
 *
 * Nothing checked it. Two inputs broke it, in 13 of 2,223 source files (#2106).
 *
 * ## Why a sweep over real files rather than fixtures
 *
 * Both causes are things nobody writes on purpose into a test fixture: a
 * regex literal that happens to contain an odd number of quote characters,
 * and an emoji in a docblock. The fixtures below pin each cause so a
 * regression names it; the sweep is what finds the third cause nobody has
 * thought of yet, and it is cheap — one pass over files already on disk.
 *
 * ## Failing this is not a false alarm, it is both directions at once
 *
 *   - a COMMENT read as code: a guard asserting "no source contains X" fires
 *     on prose, which is how #2106 was found;
 *   - CODE read as absent, or the wrong window read: offsets drift, so
 *     `argsAfter`/`argsOf` scan from a shifted index and a guard reports
 *     confidently about a different call's arguments.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles } from './collect-files';
import { blankNonCode } from './blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

describe('blankNonCode preserves positions', () => {
    describe('the two causes, pinned', () => {
        it('a regex literal with an ODD number of quotes does not open a string', () => {
            // `src/lib/geo/basemap-bundle-scan.ts` has exactly this shape:
            //   const INLINED_NON_EMPTY = /NEXT_PUBLIC_MAPTILER_KEY:"[^"]+"/;
            // — three double quotes. Without a regex state the third one opens
            // a string that runs to the next quote anywhere below, and with
            // `strings: false` (the default) that region passes through
            // UNBLANKED, so every comment after it reads as code.
            const odd = 'const RE = /a:"[^"]+"/;\n/**\n * SECRET_NAME in prose\n */\nconst x = 1;';
            const even = 'const RE = /a:"[^x]+"/;\n/**\n * SECRET_NAME in prose\n */\nconst x = 1;';

            // The control first: with an even count the comment IS blanked,
            // which is what makes the odd case a difference rather than a
            // helper that never blanks anything.
            expect(blankNonCode(even)).not.toMatch(/SECRET_NAME/);
            expect(blankNonCode(odd)).not.toMatch(/SECRET_NAME/);
        });

        it('a non-BMP character does not shift every offset after it', () => {
            // A surrogate pair is ONE code point and TWO code units. The
            // helper spread `[...src]` (code points) while indexing `src[j]`
            // (code units), so after the first astral character every write
            // landed on the wrong element and the output shrank.
            const src = '/**\n * has a 🟠 emoji here\n * more\n */\nconst x = 1;';
            const out = blankNonCode(src);

            expect(out).toHaveLength(src.length);
            expect(out.split('\n')).toHaveLength(src.split('\n').length);
            // And the comment is still blanked — a fix that preserved length
            // by not blanking would satisfy the lengths and nothing else.
            expect(out).not.toMatch(/emoji here/);
            expect(out).toContain('const x = 1;');
        });

        it('café and em dashes were never the problem — the control', () => {
            // Scoping the claim: BMP non-ASCII costs one code unit and always
            // worked. Asserting it keeps a future "fix" from being aimed at
            // the wrong characters.
            const src = '/**\n * café — naïve\n */\nconst x = 1;';
            const out = blankNonCode(src);
            expect(out).toHaveLength(src.length);
            expect(out).not.toMatch(/café/);
        });
    });

    describe('the sweep — every file under src/', () => {
        const files = collectSourceFiles({
            roots: ['src'],
            extensions: ['.ts', '.tsx'],
            // The real corpus is ~2,223 files; the floor is the helper's own
            // guard against an exclude predicate eating the population.
            floor: 1500,
        });

        it('collected the corpus it claims to sweep', () => {
            expect(files.length).toBeGreaterThanOrEqual(1500);
        });

        it.each([{ strings: false }, { strings: true }])(
            'length and line count are identical for every file (%p)',
            (opts) => {
                const broken: string[] = [];
                for (const file of files) {
                    const src = fs.readFileSync(file, 'utf8');
                    const out = blankNonCode(src, opts);
                    if (
                        out.length !== src.length ||
                        out.split('\n').length !== src.split('\n').length
                    ) {
                        broken.push(
                            `${path.relative(ROOT, file)} — ` +
                                `chars ${src.length}→${out.length}, ` +
                                `lines ${src.split('\n').length}→${out.split('\n').length}`,
                        );
                    }
                }
                if (broken.length > 0) {
                    throw new Error(
                        `${broken.length} file(s) change length or line count when blanked, ` +
                            `which breaks the offsets every caller scans from:\n` +
                            broken.slice(0, 20).map((b) => `  ${b}`).join('\n') +
                            (broken.length > 20 ? `\n  …and ${broken.length - 20} more` : ''),
                    );
                }
                expect(broken).toEqual([]);
            },
        );

        it('no file has a comment line that survives as code', () => {
            // The other direction, and the one the helper exists for. A line
            // whose raw text is entirely a `//` comment must blank to
            // whitespace; if it does not, the scanner thinks it is inside
            // something it is not.
            const leaked: string[] = [];
            for (const file of files) {
                const src = fs.readFileSync(file, 'utf8');
                const rawLines = src.split('\n');
                const outLines = blankNonCode(src).split('\n');
                if (rawLines.length !== outLines.length) continue; // reported above
                for (let n = 0; n < rawLines.length; n++) {
                    if (!/^\s*\/\/\s*\S/.test(rawLines[n])) continue;
                    if (outLines[n].trim() !== '') {
                        leaked.push(`${path.relative(ROOT, file)}:${n + 1}`);
                        break;
                    }
                }
            }
            if (leaked.length > 0) {
                throw new Error(
                    `${leaked.length} file(s) have a whole-line comment that is NOT blanked, ` +
                        `so a guard reads that prose as code:\n` +
                        leaked.slice(0, 20).map((l) => `  ${l}`).join('\n') +
                        (leaked.length > 20 ? `\n  …and ${leaked.length - 20} more` : ''),
                );
            }
            expect(leaked).toEqual([]);
        });
    });
});
