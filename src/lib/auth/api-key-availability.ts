/**
 * The single switch for tenant API-key authentication.
 *
 * ## Why this is off
 *
 * A tenant API key (`iflk_…`) has never authenticated a request, on any
 * deployment, since the feature shipped. `src/middleware.ts` calls
 * `getToken({ req, secret })`, which accepts an `Authorization: Bearer` header
 * but then runs the value through NextAuth's JWE `decode()`. An `iflk_` token
 * is not a JWE, so decode throws, `getToken` returns `null`, and the request is
 * refused with a generic 401 before any handler — and therefore before
 * `verifyApiKey` — runs. Confirmed over real HTTP, not by reading:
 *
 * ```
 * $ curl -H 'Authorization: Bearer iflk_…' /api/t/<slug>/journal
 * 401 {"error":"Unauthorized"}
 * ```
 *
 * Meanwhile the admin UI happily minted keys, showed each one once, and told
 * the operator "Copy this key now — it will never be shown again!". A
 * credential a customer can create, is instructed to use, and which returns a
 * 401 indistinguishable from a wrong key is worse for them than no feature at
 * all: it costs a support cycle to discover it was never going to work.
 *
 * So creation is closed. **Nothing is deleted** — `createApiKey`,
 * `verifyApiKey`, the scope machinery, the `TenantApiKey` model and the admin
 * list/revoke UI all remain, because revocation of already-issued keys still
 * matters and a named machine-to-machine customer would revive this.
 *
 * ## What flipping this to `true` requires
 *
 * It is NOT a one-line change, and `tests/guards/api-key-auth-disabled.test.ts`
 * fails if anyone treats it as one. Turning it on means:
 *
 *  1. **An Edge carve-out.** The Edge has no database and cannot verify a
 *     hashed key, so the middleware must let `iflk_`-bearing requests past
 *     unauthenticated and trust the handler — the same deliberate hole opened
 *     for SCIM, and it needs the same fail-closed guard.
 *  2. **Scope enforcement.** `enforceApiKeyScope` currently has ZERO callers.
 *     Scopes only influence a coarse role derivation; nothing checks them per
 *     operation.
 *  3. **A rate tier.** An anonymous-at-the-Edge surface that reaches a key
 *     comparison is a brute-force oracle (see `scimRateLimit.ts`).
 *  4. **End-to-end tests** that actually send the header through the
 *     middleware. The only current CI signal is a source-text grep for
 *     `API_KEY_PREFIX`, which stayed green for the entire life of the bug.
 *
 * Deliberately dependency-free so the `'use client'` admin page can import it.
 */
export const API_KEY_AUTH_ENABLED = false;

/**
 * Returned to a client that tries to create a key. It DIAGNOSES rather than
 * refusing blankly — the whole failure mode being fixed here is a credential
 * that fails in a way indistinguishable from a wrong one.
 */
export const API_KEY_DISABLED_MESSAGE =
    'API key authentication is not currently available: keys issued here cannot ' +
    'authenticate requests. Existing keys can still be listed and revoked.';
