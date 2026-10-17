/**
 * The AUTH surface — the pages a stranger reaches before they have a session
 * (#2011).
 *
 * ## Why this exists separately from the public surface
 *
 * #1813 split the catalogue so an anonymous visitor to `/f/<handle>` stops
 * downloading the operator vocabulary. `/login` never benefited, because
 * `PUBLIC_SURFACE_PREFIXES` is `['/f']` and nothing else: the sign-in page
 * took `allMessages` and serialised **all 5787 keys** into the HTML a stranger
 * downloads before authenticating.
 *
 * `lighthouserc.json`'s own note named that lever back on 2026-07-13 — "the
 * biggest lever is trimming the full message catalog sent to unauthenticated
 * pages" — and it stayed unpulled because the split was keyed on one prefix.
 *
 * ## Measured, not assumed
 *
 * A transitive import walk from `src/app/login/**` reaches **5 files** and
 * reads exactly **one** namespace. The comparable figure from the public
 * split, recorded in `public-surface-i18n-complete.test.ts`, is 314 bytes of
 * Bulgarian instead of 272,298 serialised.
 *
 * ## The failure this must not cause
 *
 * A page that reads an UNLISTED namespace renders raw keys —
 * `login.submitButton` where «Вход» belongs. next-intl does not throw for a
 * missing namespace in a server component, the HTML is valid, the status is
 * 200, and the only observer is a visitor who cannot sign in.
 *
 * So the list is DERIVED and guarded rather than maintained by hand:
 * `tests/guards/auth-surface-i18n-complete.test.ts` re-walks the imports and
 * fails if this list and the files disagree, in either direction.
 */

/** The pre-session surface. Deliberately one prefix — see the guard. */
export const AUTH_SURFACE_PREFIXES = ['/login'] as const;

/**
 * Namespaces an auth-surface render may use.
 *
 * One, today. The guard derives the same set from the import graph, so this
 * grows when the page starts reading something and not before.
 */
export const AUTH_SURFACE_NAMESPACES = ['login'] as const;

/** Request header the middleware sets so the root layout and `i18n.ts` can branch. */
export const AUTH_SURFACE_HEADER = 'x-agrent-auth-surface';

/**
 * Is this pathname part of the auth surface?
 *
 * Segment-boundary matched, like `isPublicSurface`: `/login` and
 * `/login/callback` yes, `/loginx` no. The boundary matters more here than it
 * looks — a prefix match would hand the slim bundle to any future route that
 * merely starts with those letters, and the symptom would be raw keys rather
 * than an error.
 */
export function isAuthSurface(pathname: string): boolean {
    return AUTH_SURFACE_PREFIXES.some((prefix) => {
        if (!pathname.startsWith(prefix)) return false;
        if (pathname.length === prefix.length) return true;
        return pathname[prefix.length] === '/';
    });
}
