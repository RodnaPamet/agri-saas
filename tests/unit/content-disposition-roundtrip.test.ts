/**
 * A filename survives the round trip: build the header, read it back (#1833).
 *
 * `contentDisposition()` and `parseContentDispositionFilename()` are inverses
 * living in one module, and the property worth asserting is the composition —
 * not each half against a hand-written string. Ten API routes build these
 * headers so a Bulgarian name survives a download; the point is that the
 * browser gets that name, which is a statement about both halves at once.
 *
 * `content-disposition.test.ts` covers the builder's own cases (the quoting
 * backstop, the ASCII fallback, `toSlug`'s contribution). This file is about
 * the reader, and about the pair.
 */
import {
    contentDisposition,
    parseContentDispositionFilename as parse,
} from '@/lib/http/content-disposition';

describe('a filename survives build → parse', () => {
    it.each([
        ['Фактура-2026.pdf', 'a Cyrillic name — the case #1343 and #1833 exist for'],
        ['acme-org_portfolio_2026-10-08.csv', 'an already-safe name, used verbatim by the builder'],
        ['Дневник — Блок А.pdf', 'Cyrillic with an em dash and spaces'],
        ['файл.документ', 'a Cyrillic EXTENSION, which the builder transliterates separately'],
        ['Отчёт (2).xlsx', 'parentheses, which `encodeURIComponent` leaves unescaped'],
        ["O'Brien's figures.pdf", "an apostrophe — a delimiter in the extended-value grammar"],
    ])('%s — %s', (name) => {
        expect(parse(contentDisposition(name))).toBe(name);
    });

    it('reads the name the builder actually emits for a Cyrillic file', () => {
        // Pinned, so a change to EITHER half shows up here as a diff rather
        // than as a silently different download name.
        const header = contentDisposition('Фактура-2026.pdf');
        expect(header).toBe(
            'attachment; filename="faktura-2026.pdf"; ' +
                "filename*=UTF-8''%D0%A4%D0%B0%D0%BA%D1%82%D1%83%D1%80%D0%B0-2026.pdf",
        );
        // The extended half wins over the transliteration.
        expect(parse(header)).toBe('Фактура-2026.pdf');
        expect(parse(header)).not.toBe('faktura-2026.pdf');
    });
});

describe('the reader, on headers it did not build', () => {
    it('prefers filename* over a DIFFERENT quoted name', () => {
        // The only header shape that can tell the two implementations apart.
        expect(parse(`attachment; filename="ascii.pdf"; filename*=UTF-8''%D0%94.pdf`)).toBe('Д.pdf');
    });

    it('accepts the parameters in the other order', () => {
        // Nothing in RFC 6266 fixes the order, and the old site-local regex
        // would have captured `*=UTF-8''…` as the name here.
        expect(parse(`attachment; filename*=UTF-8''%D0%94.pdf; filename="ascii.pdf"`)).toBe('Д.pdf');
    });

    it('skips the LANGUAGE part of an extended value', () => {
        // `charset'language'value` — the language is usually empty, and a
        // reader that splits on the first quote returns `'%D0%94.pdf`.
        expect(parse(`attachment; filename*=UTF-8'bg'%D0%94.pdf`)).toBe('Д.pdf');
    });

    it('falls back to the quoted half on a MALFORMED encoding', () => {
        // `decodeURIComponent('%E0%A4%A')` throws `URIError`. A broken header
        // must not take the download with it.
        expect(parse(`attachment; filename="safe.pdf"; filename*=UTF-8''%E0%A4%A`)).toBe('safe.pdf');
    });

    it('ignores a charset it cannot honour rather than guessing', () => {
        expect(parse(`attachment; filename="safe.pdf"; filename*=ISO-8859-1''%C4.pdf`)).toBe('safe.pdf');
    });

    it('reads an unquoted filename, which the grammar allows', () => {
        expect(parse('attachment; filename=plain.pdf')).toBe('plain.pdf');
        expect(parse('attachment; filename=plain.pdf; size=12')).toBe('plain.pdf');
    });

    it('is case-insensitive about the parameter name', () => {
        expect(parse('attachment; FileName="x.pdf"')).toBe('x.pdf');
        expect(parse(`attachment; FILENAME*=utf-8''%D0%94.pdf`)).toBe('Д.pdf');
    });

    it('strips anything that looks like a PATH, because a filename is a name', () => {
        expect(parse('attachment; filename="../../etc/passwd"')).toBe('passwd');
        expect(parse('attachment; filename="C:\\\\Windows\\\\evil.exe"')).toBe('evil.exe');
        expect(parse('attachment; filename=".."')).toBeNull();
    });

    it('returns null — not an empty string — when there is nothing to read', () => {
        // So a caller can write `parse(h) ?? fallback` in one expression, and
        // an empty `a.download` never reaches the browser.
        expect(parse(null)).toBeNull();
        expect(parse(undefined)).toBeNull();
        expect(parse('')).toBeNull();
        expect(parse('attachment')).toBeNull();
        expect(parse('attachment; filename=""')).toBeNull();
        expect(parse('inline; filename=   ')).toBeNull();
    });
});
