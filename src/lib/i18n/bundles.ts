/**
 * How the message catalogue is split on disk — P6.4 (#1813).
 *
 * ## Three CATEGORIES, two files
 *
 * Per the owner's ruling of 2026-10-15, after measurement contradicted the
 * option they were first offered. The public surface reads exactly
 * `publicFarm` and `notFound` — 2 of 93 namespaces — and NOTHING is read by
 * both the public tree and the operator app. So there are two audiences, and a
 * `shared` bundle would be an empty file.
 *
 * It stays as a category rather than being deleted, because the day a public
 * page needs `errors` that namespace needs a declared home. Without one the
 * likely outcome is the same keys copied into two bundles — which
 * `scripts/i18n-diff.mjs` reports as `duplicated` and refuses, so the
 * alternative to this category is a blocked commit with nowhere to go.
 *
 * No file is emitted while a category is empty: `bundleFiles()` returns only
 * the non-empty ones, so `messages/<locale>/` holds two files today and three
 * the moment `SHARED_NAMESPACES` gains an entry.
 *
 * ## The split does not change what a VISITOR downloads
 *
 * That was already won by passing a subset to `NextIntlClientProvider`
 * (314 bytes instead of 272,298), and `public-surface-i18n-complete.test.ts`
 * enforces it. What the split adds is that the server stops READING the
 * operator catalogue to serve an anonymous page — `src/i18n.ts` loads the
 * public bundle alone when the middleware marks the request public.
 */
import { SHARED_NAMESPACES } from './shared-namespaces';
import { AUTH_SURFACE_NAMESPACES } from './auth-surface';
import { PUBLIC_SURFACE_NAMESPACES } from './public-surface';

export const BUNDLES = ['public', 'auth', 'shared', 'app'] as const;
export type Bundle = (typeof BUNDLES)[number];

/**
 * Namespaces read by BOTH the public tree and the operator app.
 *
 * `notFound` lives here since #2264, and it is the case this category was kept
 * empty FOR: the day a namespace needs a home that is not one surface's.
 *
 * `src/app/not-found.tsx` renders on EVERY surface — a 404 under `/login` is
 * still a 404 — but the namespace was in `public`, which `bundlesFor('auth')`
 * excludes along with `app`. So a 404 on the sign-in surface threw
 * `MISSING_MESSAGE: notFound` and, with no `getMessageFallback` configured,
 * printed the key path. Measured at 360 occurrences per E2E run across two
 * independent `main` runs.
 *
 * It could not simply be added to `auth` as well: a namespace lives in exactly
 * ONE bundle, which `scripts/i18n-diff.mjs` enforces as `duplicated` and
 * refuses to commit.
 *
 * Add a namespace here — not to two bundles — when a page on more than one
 * surface reads it.
 */
export { SHARED_NAMESPACES } from './shared-namespaces';

/**
 * Which bundle a namespace belongs in.
 *
 * `public` is DERIVED from `PUBLIC_SURFACE_NAMESPACES` rather than listed
 * again. Two lists of the public namespaces is how the loader and the
 * payload-trimming filter come to disagree about what a visitor may read, and
 * the trimming filter is the one that keeps the operator catalogue off a
 * public page.
 */
export function bundleFor(namespace: string): Bundle {
    if ((PUBLIC_SURFACE_NAMESPACES as readonly string[]).includes(namespace)) return 'public';
    // `auth` before `app` for the same reason `public` is: a namespace lives
    // in exactly ONE bundle, and the surface lists are the authority on which.
    if ((AUTH_SURFACE_NAMESPACES as readonly string[]).includes(namespace)) return 'auth';
    if (SHARED_NAMESPACES.includes(namespace)) return 'shared';
    return 'app';
}

/** The bundles that actually exist on disk — non-empty categories only. */
export function bundleFiles(): Bundle[] {
    return BUNDLES.filter((b) => b !== 'shared' || SHARED_NAMESPACES.length > 0);
}

/** Which surface a request is being rendered for. */
export type Surface = 'app' | 'public' | 'auth';

/**
 * The bundles a request needs.
 *
 * A public request needs `public` (+ `shared` once it exists) and must NOT
 * load `app`: that is the point of the split. Everything else gets the lot —
 * and an ABSENT public marker means the operator app, which is the safe
 * default, because a missing header costs bytes where a wrongly-set one would
 * strip copy from a real screen.
 */
export function bundlesFor(surface: Surface): Bundle[] {
    // The operator app reads everything.
    if (surface === 'app') return bundleFiles();
    // A pre-session surface reads ITS OWN bundle plus `shared` — never `app`,
    // which is the whole point, and never the OTHER surface's bundle, which
    // would hand `/login` the public-farm copy and vice versa.
    const other: Bundle = surface === 'public' ? 'auth' : 'public';
    return bundleFiles().filter((b) => b !== 'app' && b !== other);
}
