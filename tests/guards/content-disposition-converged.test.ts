/**
 * No route builds a `Content-Disposition` header by hand (#1343).
 *
 * ## Why a guard and not a convention
 *
 * Eleven header lines across eight routes each built the header themselves,
 * and the results disagreed: seven replaced non-ASCII with `_` (losing the
 * name, and collapsing two different Cyrillic filenames to one), and one
 * interpolated the raw `originalName` — which does not degrade but THROWS,
 * because a header value is a ByteString. That route answered 500 on every
 * Bulgarian-named file.
 *
 * One invariant, eleven hand-maintained sites, agreement by diligence. That is
 * the same family as the `/start` two-list bug and the `deletedAt` predicate
 * missed at the sixth of six consumers — and the fix is the same: converge on
 * one helper and let a derived population refuse the twelfth site.
 *
 * ## What counts as hand-built
 *
 * A literal `attachment;` or `inline;` outside the helper. Matching the HEADER
 * NAME would be wrong: a route legitimately writes
 * `'Content-Disposition': contentDisposition(name)`, and the OpenAPI path
 * modules describe the header in prose for the spec, which is documentation
 * rather than a second implementation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = join(__dirname, '..', '..');
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/[\\]/g, '/');

/** The one module allowed to assemble the header. */
const HELPER = 'src/lib/http/content-disposition.ts';

/** Comments stripped: prose about the header is not an implementation of it. */
function codeOnly(src: string): string {
    return src
        .replace(/[/][*][\s\S]*?[*][/]/g, '')
        .replace(/^\s*[/][/].*$/gm, '')
        .replace(/\s[/][/].*$/gm, '');
}

/**
 * A hand-assembled disposition value.
 *
 * Anchored on the DISPOSITION TOKEN rather than on the header name, because
 * the header name appears in every correct call site too. `attachment` or
 * `inline` immediately followed by `;` inside a string literal is the thing
 * only an assembler writes.
 */
const HAND_BUILT = /['"`]\s*(attachment|inline)\s*;/i;

const ALL = collectSourceFiles({ roots: ['src'] }).map(rel);

describe('§1 the population this covers', () => {
    it('prints the denominator', () => {
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(`[content-disposition] src files scanned: ${ALL.length}`);
        expect(ALL.length).toBeGreaterThan(500);
        expect(ALL).toContain(HELPER);
    });
});

describe('§2 only the helper assembles the header', () => {
    const offenders = ALL.filter(
        (p) => p !== HELPER && HAND_BUILT.test(codeOnly(readFileSync(join(ROOT, p), 'utf8'))),
    );

    it('no route builds one by hand', () => {
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) assemble a Content-Disposition value directly:\n  ` +
                    offenders.join('\n  ') +
                    `\n\nUse contentDisposition(name) from @/lib/http/content-disposition.\n` +
                    `A hand-built header is ASCII-only, and on this product that means the ` +
                    `user's own filename is lost — or, if interpolated raw, the response ` +
                    `THROWS and the download 500s.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

describe('§3 every download route reaches the helper', () => {
    // The other direction: §2 catches a hand-built header, and would be
    // satisfied by a route that sends NO disposition at all. This counts the
    // call sites so a conversion that silently dropped one is visible.
    const callers = ALL.filter((p) =>
        /contentDisposition\s*\(/.test(codeOnly(readFileSync(join(ROOT, p), 'utf8'))),
    ).filter((p) => p !== HELPER);

    it('reports the converted call sites', () => {
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(`[content-disposition] call sites: ${callers.length}\n  ` + callers.join('\n  '));
        // Eight routes today. A floor rather than an equality so adding a
        // download does not break this, while losing most of them does.
        expect(callers.length).toBeGreaterThanOrEqual(8);
    });
});

describe('§4 the detector can tell the two apart', () => {
    it('flags a hand-built header', () => {
        const bad = `const h = { 'Content-Disposition': 'attachment; filename="x.pdf"' };`;
        expect(HAND_BUILT.test(codeOnly(bad))).toBe(true);
    });

    it('flags a template-literal one', () => {
        const bad = 'const h = `attachment; filename="${name}"`;';
        expect(HAND_BUILT.test(codeOnly(bad))).toBe(true);
    });

    it('flags inline as well as attachment', () => {
        expect(HAND_BUILT.test(codeOnly(`'inline; filename="x.pdf"'`))).toBe(true);
    });

    it('does NOT flag a correct call site', () => {
        // The assertion that stops this guard being satisfied by banning the
        // header name — every converted route still mentions it.
        const good = `const h = { 'Content-Disposition': contentDisposition(name) };`;
        expect(HAND_BUILT.test(codeOnly(good))).toBe(false);
    });

    it('does NOT flag prose describing the header', () => {
        // The OpenAPI path modules document it for the spec, and a docblock
        // quoting `Content-Disposition: attachment` is not an implementation.
        const prose = `/** Returns application/pdf with Content-Disposition: attachment. */`;
        expect(HAND_BUILT.test(codeOnly(prose))).toBe(false);
    });

    it('does not flag the word attachment on its own', () => {
        // No semicolon, so no assembly — otherwise every mention of an
        // attachment in the product would enter the population.
        expect(HAND_BUILT.test(codeOnly(`const label = 'attachment';`))).toBe(false);
    });
});
