/**
 * The API-key token FORMAT — and nothing else.
 *
 * ## Why this is its own module
 *
 * `src/middleware.ts` runs on the Edge and has to answer one question before
 * any database exists: "is this bearer an API key?". The answer is a string
 * prefix test, but the prefix used to live in `api-key-auth.ts`, which imports
 * `@/lib/prisma` — so asking the question from the Edge would have pulled the
 * Prisma client into the Edge bundle.
 *
 * So the format is split out here, dependency-free, for the same reason
 * `api-key-availability.ts` is: an Edge module and a `'use client'` page must
 * both be able to import a constant without importing a database.
 *
 * `api-key-auth.ts` re-exports both symbols, so there is exactly ONE
 * definition of what an API key looks like and existing importers are
 * unaffected.
 */

/**
 * Prefix every tenant API key carries.
 *
 * Load-bearing in two places that must agree: the Edge carve-out uses it to
 * decide whether to let a request through unauthenticated, and `verifyApiKey`
 * uses it to reject a malformed token before hashing. If they ever disagreed,
 * a token shape could be admitted at the Edge and refused at the handler — or,
 * far worse, admitted and then not recognised as needing verification.
 */
export const API_KEY_PREFIX = 'iflk_';

/**
 * Does this bearer token look like an API key?
 *
 * A FORMAT test, not a validity test. It says only that the token should be
 * routed to API-key verification rather than JWT decoding; whether the key
 * exists, is revoked, or has expired is `verifyApiKey`'s answer.
 */
export function isApiKeyToken(token: string): boolean {
    return token.startsWith(API_KEY_PREFIX);
}
