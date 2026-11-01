/**
 * The generated secret-pattern module matches `.secret-patterns` — #2578.
 *
 * Same arrangement as `tokens-generated-in-sync`: a generator, a committed
 * output, and a guard that regenerates and compares. The reason it is a guard
 * rather than a convention is the `fonts:vendor` lesson — regenerating the
 * output and its own verification in one step makes a changed pattern a green
 * diff.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { blankNonCode } from '../helpers/blank-non-code';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseSecretPatterns, translatePattern } from '../../scripts/lib/secret-patterns';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE = '.secret-patterns';
const TARGET = 'src/lib/security/generated/secret-patterns.ts';
const DOCKERFILE = 'Dockerfile';

describe('generated secret patterns (#2578)', () => {
    it('is in sync with .secret-patterns', () => {
        // The generator's own `--check`, so the comparison cannot drift from
        // the thing that writes the file.
        const out = execFileSync('npx', ['tsx', 'scripts/generate-secret-patterns.ts', '--check'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        console.log(`[secret-patterns] ${out.trim()}`);
        expect(out).toContain('in sync');
    });

    it('carries a real pattern set — an empty one would report every scan clean', () => {
        // Not `module` — Next's `no-assign-module-variable` rule forbids the
        // name outright, and the lint ceiling allows zero errors.
        //
        // `blankNonCode` first, with `strings: true`. Both halves are MEASURED
        // rather than assumed, because the cap in
        // `guards-blank-comments-before-matching` warns that a stripper call
        // which does nothing teaches a later reader something false — and the
        // justification first written here was exactly that. A `//` comment can
        // never match `^\\s{4}\\{`: the slash occupies column one. Two shapes
        // CAN, and each was injected into this very file to find out.
        //
        //   raw   blanked
        //    14      14    the file as it stands
        //    16      14    + a BLOCK comment whose lines are indented four
        //    15      14    + a template literal holding the same text
        //
        // So the comment half earns its place on `/* */` and not on `//`, and
        // `strings: true` earns its own — which is also what the helper
        // prescribes when the subject is a code STRUCTURE rather than message
        // text, as an object literal is.
        const generated = blankNonCode(readFileSync(path.join(REPO_ROOT, TARGET), 'utf8'), {
            strings: true,
        });
        const rows = (generated.match(/^\s{4}\{ name: /gm) ?? []).length;
        const sourceRows = readFileSync(path.join(REPO_ROOT, SOURCE), 'utf8')
            .split('\n')
            .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('|')).length;
        console.log(`[secret-patterns] ${rows} generated row(s) from ${sourceRows} source line(s)`);
        expect(rows).toBe(sourceRows);
        expect(rows).toBeGreaterThanOrEqual(10);
    });

    it('the PREMISE still holds: .secret-patterns is not in the runtime image', () => {
        // This generator exists only because the pattern file does not reach
        // production. That is a fact about the Dockerfile, and a fact can
        // change without anybody revisiting the reasoning built on it — the
        // `a-safety-argument-expires-silently` shape.
        //
        // If someone adds the file to the runtime stage, this fails and asks
        // for a decision rather than leaving a generator nobody needs.
        //
        // The hash comments are stripped by hand and deliberately NOT through
        // `blankNonCode`, which is a JS/TS stripper: on a Dockerfile it would
        // be a call that demonstrably does nothing. `^COPY` already excludes a
        // whole-line comment; what it does not exclude is a TRAILING one, so
        // `COPY x ./x  # deliberately NOT .secret-patterns` would read as a
        // copy. That direction fails LOUD rather than silent, but a guard owes
        // the false-alarm question too — proved by injecting that exact line.
        const dockerfile = readFileSync(path.join(REPO_ROOT, DOCKERFILE), 'utf8')
            .split('\n')
            .map((l) => l.replace(/#.*$/, ''))
            .join('\n');
        const runner = dockerfile.slice(dockerfile.lastIndexOf('AS runner'));
        const copiesIt = /^COPY[^\n]*\.secret-patterns/m.test(runner);
        expect({
            premise: '.secret-patterns is absent from the runtime image',
            stillTrue: !copiesIt,
            note: 'If you added it deliberately, the generator may be redundant — decide, do not just silence this.',
        }).toEqual({
            premise: '.secret-patterns is absent from the runtime image',
            stillTrue: true,
            note: 'If you added it deliberately, the generator may be redundant — decide, do not just silence this.',
        });
    });

    it('refuses an inline (?i) that is not at the start', () => {
        // The one translation that would be WRONG rather than merely
        // unsupported: PCRE scopes `(?i)` from where it appears, so hoisting a
        // mid-pattern one to the flag set WIDENS the match. Both live
        // occurrences are at index 0; this proves the refusal exists for the
        // day one is not.
        //
        // Asserted IN PROCESS since #2586. It was driven through the CLI over a
        // temp fixture before, and the reason was purely mechanical — the
        // parser was a `.mjs`, which a ts-jest suite cannot import, because a
        // dynamic `import()` is rewritten to `require()`. Now that the parser
        // is the same `.ts` module the guardrail imports, the subprocess is a
        // choice rather than a constraint, and the direct call can assert WHICH
        // pattern was refused and WHY — neither of which survives a stderr
        // match.
        expect(() => translatePattern('Mid-pattern modifier', 'abc(?i)def')).toThrow(
            /not at the start/,
        );
        expect(() => translatePattern('Mid-pattern modifier', 'abc(?i)def')).toThrow(/WIDEN/);

        // A LEADING one is ACCEPTED, so the refusal is about PLACEMENT and not
        // about the modifier. Without this the assertion above is satisfied by
        // a parser that refuses every `(?i)`, which would reject 2 of the 14
        // live patterns and is the same mistake in the other direction.
        expect(translatePattern('Leading modifier', '(?i)abc')).toEqual({
            source: 'abc',
            flags: 'i',
        });
        // …and a pattern with no modifier keeps empty flags, which is what
        // makes the `i` above attributable to the translation.
        expect(translatePattern('No modifier', 'abc')).toEqual({ source: 'abc', flags: '' });
    });

    it('refuses an EMPTY pattern file — every scan would report clean', () => {
        // The `absence-reads-as-success` shape, and the worst available outcome
        // for a secret scanner: zero patterns means every file is clean.
        expect(() => parseSecretPatterns('# only a comment\n\n')).toThrow(/No patterns parsed/);
        // A malformed line is refused rather than SKIPPED, for the same reason:
        // skipping it would silently shrink the pattern set.
        expect(() => parseSecretPatterns('no pipe here\n')).toThrow(/Malformed line/);
        // Control: a well-formed line parses, so the refusals above are about
        // the input and not about a parser that rejects everything.
        expect(parseSecretPatterns('Name | abc\n')).toEqual([
            { name: 'Name', source: 'abc', flags: '' },
        ]);
    });

    it('the CLI turns a refusal into exit 1 with an ::error:: line', () => {
        // The ONE subprocess test, kept deliberately rather than inherited.
        //
        // `npm run secret-patterns:check` is a CI step, so the EXIT CODE and the
        // `::error::` prefix are the contract — a non-zero exit is what fails
        // the job and the prefix is what GitHub renders as an annotation. An
        // in-process call cannot exercise either: it sees a thrown Error, which
        // is a different observable from a process that exited.
        const dir = mkdtempSync(path.join(tmpdir(), 'secpat-'));
        try {
            const bad = path.join(dir, 'patterns');
            writeFileSync(bad, 'Mid-pattern modifier | abc(?i)def\n', 'utf8');
            let status = 0;
            let stderr = '';
            try {
                execFileSync('npx', ['tsx', 'scripts/generate-secret-patterns.ts'], {
                    cwd: REPO_ROOT,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        SECRET_PATTERNS_FILE: bad,
                        SECRET_PATTERNS_TARGET: path.join(dir, 'out.ts'),
                    },
                });
            } catch (error) {
                const e = error as { status?: number; stderr?: string };
                status = e.status ?? 1;
                stderr = e.stderr ?? '';
            }
            expect({
                status,
                annotated: stderr.includes('::error::'),
                mentionsTheReason: /not at the start/.test(stderr),
            }).toEqual({ status: 1, annotated: true, mentionsTheReason: true });
            // And it did NOT write the target — a generator that refuses and
            // still emits a file would leave a weakened module behind.
            expect(existsSync(path.join(dir, 'out.ts'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
