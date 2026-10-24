/**
 * Namespaces read by MORE THAN ONE surface, in a leaf module (#2264).
 *
 * Its own file to break a cycle, which is the whole reason it is not in
 * `bundles.ts` beside the other two lists: `bundles.ts` imports
 * `PUBLIC_SURFACE_NAMESPACES` and `AUTH_SURFACE_NAMESPACES` from the surface
 * modules, so a surface module importing back from `bundles.ts` closes a loop.
 * These are `const` arrays read at call time, so the loop might have worked by
 * luck — `bundleFiles()` reads `SHARED_NAMESPACES.length` and is callable
 * during module init, which is exactly where a cycle yields `undefined`.
 *
 * ## Why `notFound` is here
 *
 * `src/app/not-found.tsx` renders on EVERY surface — a 404 under `/login` is
 * still a 404 — but the namespace lived in `public`, which `bundlesFor('auth')`
 * excludes along with `app`. So a 404 on the sign-in surface threw
 * `MISSING_MESSAGE: notFound`, and with no `getMessageFallback` configured
 * next-intl printed the key path. Measured at 360 occurrences per E2E run,
 * steady across two independent `main` runs.
 *
 * Adding it to `auth` as well was not an option: a namespace lives in exactly
 * ONE bundle, and `scripts/i18n-diff.mjs` reports the alternative as
 * `duplicated` and refuses the commit.
 *
 * @module lib/i18n/shared-namespaces
 */
export const SHARED_NAMESPACES: readonly string[] = ['notFound'];
