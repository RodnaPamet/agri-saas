/**
 * A download preserves the user's own filename, and the header is valid
 * whatever they called the file (#1343).
 *
 * ## The property, not the mechanism
 *
 * Every case here builds a REAL `Response`, reads the header back off it, and
 * parses it the way a browser would. Asserting the string matches a regex
 * would pin the shape I happened to write — and `p3a-canvas-export-png-svg`
 * did exactly that, pinning a regex literal, which is why it could not notice
 * that the mechanism it pinned destroyed Cyrillic.
 *
 * Constructing the Response is load-bearing rather than ceremony: a header
 * value is a ByteString, so a non-Latin-1 character does not degrade, it
 * THROWS. The old raw-interpolation site answered 500 on every Bulgarian
 * filename for that reason. A test that only inspected a string would have
 * called that code correct.
 */
import { toSlug } from '@/lib/bg-transliterate';
import { contentDisposition } from '@/lib/http/content-disposition';

/** What the runtime actually accepts — the half a string assertion skips. */
function headerOf(value: string): string {
    return new Response(null, { headers: { 'Content-Disposition': value } }).headers.get(
        'Content-Disposition',
    )!;
}

/** Parse `filename*=UTF-8''…` back to the name, as a browser would. */
function extendedName(header: string): string | null {
    const m = /filename\*=UTF-8''([^;]+)/i.exec(header);
    return m ? decodeURIComponent(m[1]) : null;
}

/** Parse the quoted `filename="…"` fallback. */
function asciiName(header: string): string | null {
    const m = /filename="([^"]*)"/.exec(header);
    return m ? m[1] : null;
}

describe('§1 a Bulgarian filename survives the round trip', () => {
    it('«Фактура-2026.pdf» comes back byte-identical', () => {
        const header = headerOf(contentDisposition('Фактура-2026.pdf'));
        expect(extendedName(header)).toBe('Фактура-2026.pdf');
    });

    it('and carries a READABLE ascii fallback, not a row of underscores', () => {
        const header = headerOf(contentDisposition('Фактура-2026.pdf'));
        expect(asciiName(header)).toBe('faktura-2026.pdf');
        expect(asciiName(header)).not.toMatch(/_{3,}/);
    });

    it('two DIFFERENT Cyrillic names do not collapse to one filename', () => {
        const a = headerOf(contentDisposition('Фактура.pdf'));
        const b = headerOf(contentDisposition('Договор.pdf'));
        expect(extendedName(a)).not.toBe(extendedName(b));
        expect(asciiName(a)).not.toBe(asciiName(b));
    });

    it('the old sanitiser WOULD have collapsed them — the contrast', () => {
        const old = (n: string) => n.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
        expect(old('Фактура.pdf')).toBe(old('Договор.pdf'));
        // Seven underscores, not eight — «Фактура» is 7 characters. My first
        // draft asserted 8 and the test failed on arithmetic while the claim
        // it was making was correct.
        expect(old('Фактура.pdf')).toBe('_______.pdf');
    });
});

describe('§2 a header that THROWS is the failure mode, so every input must form one', () => {
    it.each([
        ['cyrillic', 'Фактура-2026.pdf'],
        ['mixed script', 'Invoice-Фактура (2).pdf'],
        ['emoji only', '🌾🚜.pdf'],
        ['a quote', 'inv"oice.pdf'],
        ['a semicolon', 'a.pdf; filename=evil.exe'],
        ['CR and LF', 'a.pdf\r\nX-Injected: yes'],
        ['a NUL', 'a\u0000.pdf'],
        ['empty', ''],
        ['whitespace only', '   '],
        ['no extension', 'Фактура'],
        ['leading dot', '.hidden'],
        ['very long', `${'я'.repeat(400)}.pdf`],
        ['path separators', '../../etc/passwd'],
        ['backslash', 'a\\b.pdf'],
    ])('%s produces a header the runtime accepts', (_label, name) => {
        expect(() => headerOf(contentDisposition(name))).not.toThrow();
        const header = headerOf(contentDisposition(name));
        expect(header).toMatch(/^attachment;/);
        expect(asciiName(header)).toBeTruthy();
    });

    it('…and the raw interpolation it replaces throws on the first of them', () => {
        // The positive control for §2: if the runtime tolerated a Cyrillic
        // header value, every assertion above would pass against the broken
        // code too.
        //
        // Asserted on the MESSAGE, not `toThrow(TypeError)`. undici's
        // TypeError is a different constructor IDENTITY from the realm's
        // global, so jest reports "Expected constructor: TypeError / Received
        // constructor: TypeError" and fails on an error it is correctly
        // recognising. The message is also the more informative assertion:
        // "greater than 255" is the ByteString constraint by name.
        expect(() => headerOf(`attachment; filename="Фактура-2026.pdf"`)).toThrow(
            /ByteString|greater than 255/,
        );
    });
});

describe('§3 the quoted half cannot be broken out of', () => {
    it('a quote in the name does not end the quoted string early', () => {
        const header = headerOf(contentDisposition('inv"oice.pdf'));
        expect(asciiName(header)).not.toContain('"');
        expect(header.match(/filename="/g)).toHaveLength(1);
    });

    it('a semicolon cannot smuggle a second filename parameter', () => {
        const header = headerOf(contentDisposition('a.pdf; filename=evil.exe'));
        expect(asciiName(header)).not.toContain(';');
        expect(header).not.toMatch(/filename=evil\.exe/);
    });

    it('a path separator does not survive into the fallback', () => {
        const header = headerOf(contentDisposition('../../etc/passwd'));
        expect(asciiName(header)).not.toContain('/');
        expect(asciiName(header)).not.toContain('..');
    });

    it('control characters are stripped rather than relied on to throw', () => {
        // CR/LF throw in this runtime, which is a behaviour and not a
        // guarantee. Relying on a TypeError as a security control is relying
        // on an implementation detail.
        const header = headerOf(contentDisposition('a\u0001b.pdf'));
        expect(asciiName(header)).not.toMatch(/[\u0000-\u001F]/);
    });
});

describe('§4 the dependency on toSlug is explicit, because it is another module', () => {
    /**
     * `contentDisposition`'s safety rests on `toSlug` stripping the characters
     * that could break the quoted parameter — measured by mutation: deleting
     * `"` and `;` from the helper's own character class leaves every other
     * test in this file green, because `toSlug` already removed them.
     *
     * `toSlug` exists to make URL slugs. It could legitimately change its
     * class without anyone thinking about download headers, and the property
     * would vanish from every download with nothing failing. So the premise is
     * asserted here rather than assumed — a safety argument whose premise
     * lives in another module expires silently.
     */
    it.each([
        ['a double quote', 'inv"oice'],
        ['a semicolon', 'a; filename=evil'],
        ['a path traversal', '../../etc/passwd'],
        ['a backslash', String.raw`a\b`],
    ])('toSlug removes %s', (_label, input) => {
        const out = toSlug(input);
        expect(out).not.toBeNull();
        expect(out!).not.toMatch(/["\;\/\\]/);
        expect(out!).not.toContain('..');
    });

    it('a CYRILLIC EXTENSION is transliterated, not deleted', () => {
        // «файл.документ» is a legal filename. The first version stripped the
        // extension with `[^A-Za-z0-9]`, which deleted `документ` outright and
        // produced a fallback with no extension — caught by
        // `slug-derivation-is-converged`, which bans that shape for exactly
        // this reason. It was right about a module written to stop losing
        // Bulgarian names.
        const header = headerOf(contentDisposition('файл.документ'));
        // `fayl`, not `fail` — `й` transliterates to `y`. Measured rather
        // than guessed: my first assertion here invented the transliteration
        // and the test failed on my arithmetic while the code was correct.
        expect(asciiName(header)).toBe('fayl.dokument');
        expect(extendedName(header)).toBe('файл.документ');
    });

    it('…and it transliterates rather than masking, which is why the fallback is readable', () => {
        // The other half of why toSlug is the right source for the ASCII
        // fallback: `_______.pdf` tells a user nothing, `faktura.pdf` does.
        expect(toSlug('Фактура')).toBe('faktura');
    });
});

describe('§5 an already-safe name is used VERBATIM, not normalised', () => {
    it('an ASCII name with underscores is left exactly as given', () => {
        // `acme-org_portfolio_2026-10-08.csv` is the portfolio export's real
        // filename. The first version ran everything through `toSlug`, which
        // normalises as well as transliterates, so the underscores became
        // hyphens and a redundant `filename*` was attached — a gratuitous
        // change to a filename that was never a problem.
        // `portfolio-routes.test.ts` caught it.
        const name = 'acme-org_portfolio_2026-10-08.csv';
        const header = headerOf(contentDisposition(name));
        expect(header).toBe(`attachment; filename="${name}"`);
        expect(extendedName(header)).toBeNull();
    });

    it('a name with é takes the extended form rather than a Latin-1 byte', () => {
        // `é` is valid in a ByteString, so it would not throw — but a raw
        // Latin-1 byte in a header is interpreted differently by different
        // clients, so the extended form is the better answer.
        const header = headerOf(contentDisposition('résumé.pdf'));
        expect(extendedName(header)).toBe('résumé.pdf');
    });

    it('emits one filename, not the same value twice', () => {
        const header = headerOf(contentDisposition('rent-roll.pdf'));
        expect(header).toBe('attachment; filename="rent-roll.pdf"');
        expect(extendedName(header)).toBeNull();
    });

    it('inline is supported for the surfaces that render in the tab', () => {
        expect(headerOf(contentDisposition('a.pdf', 'inline'))).toMatch(/^inline;/);
    });
});
