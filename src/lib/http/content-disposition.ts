/**
 * Build a `Content-Disposition` header that preserves the user's own filename
 * (#1343).
 *
 * ## The defect this replaces, and it is not cosmetic
 *
 * Every download in the app sent an ASCII-only filename, on a product whose
 * users are all Bulgarian. Eleven header lines across eight routes, zero
 * using RFC 6266's `filename*`.
 *
 * Measured against the real runtime rather than assumed, because the three
 * cases behave completely differently:
 *
 *   `attachment; filename="Фактура-2026.pdf"`
 *     → TypeError: Cannot convert argument to a ByteString
 *
 * A header value is a ByteString, so a non-Latin-1 character does not degrade
 * — it THROWS, and the response never forms. The one route that interpolated
 * `originalName` raw (`access-reviews/[reviewId]/evidence`) therefore answered
 * **500 on every Bulgarian-named file**, which is a live failure rather than
 * the "user can rename after downloading" the issue assumed. The routes that
 * replaced non-ASCII with `_` were the lucky ones: they merely lost the name,
 * and two invoices with different Cyrillic names downloaded as the same file.
 *
 *   `attachment; filename="inv"oice.pdf"`        → ACCEPTED, quoting broken
 *   `attachment; filename="a.pdf; filename=x"`   → ACCEPTED, second parameter
 *   `attachment; filename="a.pdf\r\nX-H: y"`     → THREW (so: no injection)
 *
 * CRLF throwing is why this is not a header-injection issue. The quote and the
 * semicolon are accepted, though, and a smuggled second `filename=` is a real
 * if modest spoofing vector — browsers differ on which one wins.
 *
 * ## Why `filename*` and not transliteration
 *
 * `toSlug` is the right tool for a URL, where ASCII is a genuine constraint.
 * A download filename has no such constraint: RFC 6266 / RFC 5987
 * `filename*=UTF-8''…` carries the original UTF-8 name and every browser in
 * the support matrix honours it. Romanising «Фактура» to `faktura` would throw
 * away something we are able to keep — the name the user chose and will search
 * for.
 *
 * So both halves ship: `filename=` as the ASCII fallback for anything that
 * ignores the extended form, `filename*=` carrying the truth.
 */
import { toSlug } from '@/lib/bg-transliterate';

/** `attachment` prompts a save dialog; `inline` renders in the tab. */
export type Disposition = 'attachment' | 'inline';

/**
 * A BACKSTOP for characters that must never reach the quoted `filename=`
 * value — not the primary defence, and the distinction is measured.
 *
 * `"` ends the quoted string early and `;` starts a new parameter, and both
 * were measured as ACCEPTED by the runtime, so neither is caught for us. But
 * `toSlug` already removes them on the way through `asciiFallback` —
 * `inv"oice` becomes `inv-oice`, `a.pdf; filename=evil` becomes
 * `a-pdf-filename-evil` — so for those characters this replace never fires.
 *
 * Proved by mutation: deleting `"` and `;` from this class leaves all 25 tests
 * green, because `toSlug` is doing the work. That is why the claim here is
 * "backstop" rather than "this is what protects the header".
 *
 * It is kept because the property then depends on a helper THIS MODULE DOES
 * NOT OWN. `toSlug` exists to make URL slugs and could legitimately change its
 * character class without anyone thinking about download headers, and a safety
 * argument whose premise lives in another module expires silently.
 * `content-disposition.test.ts` therefore asserts `toSlug`'s contribution
 * directly, so such a change reddens there rather than quietly removing a
 * property from every download.
 *
 * Control characters are a different case: CR and LF throw in this runtime,
 * which is a behaviour and not a guarantee, and relying on a TypeError as a
 * security control is relying on an implementation detail.
 */
const UNSAFE_IN_QUOTED = /["\;\u0000-\u001F\u007F]/g;

/** Anything a header value cannot carry: a ByteString is Latin-1 only. */
const NON_LATIN1 = /[^\u0000-\u00FF]/;

/**
 * The ASCII fallback half.
 *
 * `toSlug` transliterates «Фактура-2026» to `faktura-2026`, which is a good
 * fallback precisely because it is readable — but it returns `null` for a name
 * with nothing transliterable (all emoji, say), and it strips the extension
 * along with everything else. So the extension is preserved separately and
 * `download` is the last resort, never an empty filename.
 */
function asciiFallback(name: string): string {
    const lastDot = name.lastIndexOf('.');
    const hasExt = lastDot > 0 && lastDot < name.length - 1;
    const stem = hasExt ? name.slice(0, lastDot) : name;
    const ext = hasExt ? name.slice(lastDot + 1).replace(/[^A-Za-z0-9]/g, '') : '';

    const slug = toSlug(stem) ?? '';
    const safeStem = slug || 'download';
    return ext ? `${safeStem}.${ext}` : safeStem;
}

/**
 * Build the whole header value.
 *
 * Call this rather than assembling the string — `tests/guards/content-disposition-converged.test.ts`
 * fails CI on a hand-built `Content-Disposition`, because site twelve is what
 * reintroduces the defect.
 */
export function contentDisposition(
    filename: string,
    disposition: Disposition = 'attachment',
): string {
    const trimmed = filename.trim();
    // An empty or whitespace-only name must still produce a valid header; a
    // bare `attachment` with no filename is legal but loses the extension a
    // caller usually has, so the fallback owns this case.
    const source = trimmed || 'download';

    const ascii = asciiFallback(source).replace(UNSAFE_IN_QUOTED, '_');

    // Only emit `filename*` when it says something the fallback does not.
    // An all-ASCII name is identical in both halves, and a header carrying the
    // same value twice is noise a reader has to reconcile.
    const needsExtended = NON_LATIN1.test(source) || ascii !== source;
    if (!needsExtended) {
        return `${disposition}; filename="${ascii}"`;
    }

    // RFC 5987: percent-encode the UTF-8 bytes. `encodeURIComponent` leaves
    // `!'()*` unescaped, and `*` and `'` are delimiters in the extended-value
    // grammar, so they are encoded explicitly rather than left to chance.
    const extended = encodeURIComponent(source).replace(
        /['()*!]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    return `${disposition}; filename="${ascii}"; filename*=UTF-8''${extended}`;
}
