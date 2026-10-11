/**
 * Is this `next` parameter somewhere we are willing to send a browser?
 *
 * ## Why it is its own module
 *
 * The implementation lived in `@/lib/auth/guard`, which imports
 * `next/server`. A CLIENT component cannot import that without dragging
 * `NextResponse` into the browser bundle — so the one page that needed it
 * most, the MFA challenge, had no cheap way to call it and simply did not.
 * Splitting it out keeps exactly ONE implementation; `guard` re-exports this.
 *
 * ## What it rejects, and the one that was missing
 *
 * ```
 *   https://evil.example      absolute URL
 *   //evil.example            protocol-relative
 *   \evil.example             backslash host
 *   javascript:alert(1)       a scheme, so it does not start with `/`
 *   /\evil.example            backslash AFTER the slash  <-- got through
 * ```
 *
 * `decoded.startsWith('//')` and `decoded.startsWith('\\')` both miss `/\`,
 * and browsers normalise `/\` to `//` when parsing a URL — so
 * `location.href = '/\evil.example'` leaves the origin. It was reachable
 * through every caller, including `buildLoginRedirect`, not only the page
 * that prompted the fix.
 *
 * ## Why this matters most on the MFA page
 *
 * There the redirect fires in the instant after somebody types a correct
 * second-factor code. That is the most convincing possible moment to show a
 * "session expired, sign in again" page: the person has just proved to
 * themselves that they are mid-authentication, so another credential prompt
 * is exactly what they expect. Found by agrent-ios.
 */

/** Control characters and whitespace that could split a header or fool a parser. */
const UNSAFE_CHARS = /[\u0000-\u0020\u007f]/;

/** A path we will navigate to, or `/` when the input is not one. */
export function sanitizeRedirectPath(next: string | null | undefined): string {
    if (!next) return '/';

    let decoded: string;
    try {
        decoded = decodeURIComponent(next);
    } catch {
        // A malformed escape is not a path. Decoding FIRST and judging after
        // is deliberate: `%2F%2Fevil.example` has to be read as
        // `//evil.example` rather than as an innocent-looking literal.
        return '/';
    }

    // Reject anything that is, or could become, an absolute reference.
    if (
        decoded.startsWith('//') ||
        decoded.includes('://') ||
        decoded.startsWith('\\') ||
        // `/\` — the gap. A browser treats the backslash as a second slash.
        /^\/\\/.test(decoded) ||
        UNSAFE_CHARS.test(decoded)
    ) {
        return '/';
    }

    if (!decoded.startsWith('/')) return '/';

    // Collapse any remaining leading slashes. Slashes ONLY, and the absence
    // of a backslash here is deliberate: a mutation test removing it changed
    // nothing, because `/\…` is already rejected above and `\…` fails
    // `startsWith('\\')`. A backslash cannot reach this line, so including
    // one would be an untestable second defence sitting next to a tested
    // first — which reads as thoroughness and is really just unreachable
    // code. The rejection above is the single place `/\` is handled.
    return decoded.replace(/^\/+/, '/');
}
