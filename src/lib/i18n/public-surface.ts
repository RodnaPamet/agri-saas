/**
 * What an ANONYMOUS visitor is sent (P6.4, #1813).
 *
 * ## The measurement
 *
 * The root layout serialises `getMessages()` into the RSC payload through
 * `NextIntlClientProvider`. Measured 2026-10-14:
 *
 *     bg   404,981 bytes   ->   475 bytes needed by /f/[handle]   (0.12%)
 *     en   250,923 bytes   ->   289 bytes
 *
 * So a stranger opening a farm page downloads the entire operator catalogue —
 * 93 namespaces, every one of them for a screen they cannot reach — to render
 * three strings. On P6.5's budget of LCP ≤2.5s over rural mobile data, that
 * single payload is the difference between the target being reachable and not.
 *
 * ## Why this is NOT "split the i18n catalogs"
 *
 * The phase's checklist says to split them, and I do not think that is the
 * right mechanism. `NextIntlClientProvider` takes a `messages` OBJECT, so
 * passing a subset shrinks the payload without touching a single file — the
 * two catalogues stay one-per-locale, and the pre-commit parity check that
 * compares them key-for-key keeps working unchanged.
 *
 * Splitting 93 namespaces across files would buy the same bytes and cost a
 * parity check that has to reason across N files, which is exactly the shape
 * that lets a key move between files while every per-file check still passes.
 * The split was a means to the slim payload; this is the end without the
 * means.
 *
 * ## The namespace list is a CLAIM, and a guard holds it
 *
 * A public surface that reads a namespace absent from this list renders raw
 * keys — `publicFarm.cropsTitle` on the page instead of «Култури» — which is
 * a failure a server render cannot report and a reviewer does not see.
 * `tests/guards/public-surface-i18n-complete.test.ts` derives the namespaces
 * every public-surface file actually uses and fails if one is unlisted.
 *
 * ## The prefix list is deliberately NARROW
 *
 * `isPublicPath` is true for `/login`, `/register`, `/no-tenant` and more —
 * those are public PAGES but they are part of the operator app and want its
 * shell. "Public surface" is the smaller idea: the unauthenticated pages a
 * stranger reaches from a shared link or a printed QR code, which today is
 * `/f` alone.
 *
 * Matched at a segment boundary rather than with a bare `startsWith`, for the
 * same reason `matchesPublicPrefix` is: `/fx` must not inherit a decision made
 * about `/f`. Here the failure direction is mild — a page would get the full
 * payload rather than the slim one, costing bytes rather than safety — but a
 * rule that is right for one reason and wrong for another is the kind that
 * gets copied into the place where it matters.
 */

/** The unauthenticated surface a stranger reaches without an account. */
export const PUBLIC_SURFACE_PREFIXES = ['/f'] as const;

/**
 * Namespaces a public-surface render may use.
 *
 * `publicFarm` is the profile page's own copy. `notFound` is reachable from it
 * — a withdrawn or missing handle renders `src/app/not-found.tsx`, which
 * translates — and omitting it would make the 404 page show raw keys, on the
 * one path a stranger is most likely to hit.
 */
import { SHARED_NAMESPACES } from './shared-namespaces';

export const PUBLIC_SURFACE_NAMESPACES = ['publicFarm'] as const;

/** Request header the middleware sets so the root layout can branch. */
export const PUBLIC_SURFACE_HEADER = 'x-agrent-public-surface';

/**
 * Is this pathname part of the public surface?
 *
 * Segment-boundary matched: `/f` and `/f/pobeda` yes, `/fx` and `/f-debug`
 * no.
 */
export function isPublicSurface(pathname: string): boolean {
    return PUBLIC_SURFACE_PREFIXES.some((prefix) => {
        if (!pathname.startsWith(prefix)) return false;
        if (pathname.length === prefix.length) return true;
        return pathname[prefix.length] === '/';
    });
}

/**
 * The subset of a message catalogue a public surface needs.
 *
 * Returns a NEW object containing only the listed namespaces. A namespace that
 * is listed but absent from the catalogue is skipped rather than emitted as
 * `undefined`, which next-intl would reject at render time — the guard catches
 * the inverse (used but unlisted), and this handles the direction a typo in
 * the list produces.
 */
export function publicSurfaceMessages<T extends Record<string, unknown>>(all: T): Partial<T> {
    const out: Partial<T> = {};
    // PUBLIC plus SHARED. `notFound` moved to `shared` in #2264 because
    // `src/app/not-found.tsx` renders on every surface, and this trim is what
    // the public page's CLIENT receives — leaving shared out would have fixed
    // the auth surface by breaking the public one.
    for (const ns of [...PUBLIC_SURFACE_NAMESPACES, ...SHARED_NAMESPACES]) {
        if (ns in all) out[ns as keyof T] = all[ns as keyof T];
    }
    return out;
}
