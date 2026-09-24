/**
 * The single switch for tenant API-key authentication.
 *
 * ## History, kept because it is the reason this file exists
 *
 * A tenant API key (`iflk_…`) had never authenticated a request, on any
 * deployment, from the day the feature shipped until 2026-09-24.
 * `src/middleware.ts` called `getToken({ req, secret })`, which accepts an
 * `Authorization: Bearer` header but then runs the value through NextAuth's
 * JWE `decode()`. An `iflk_` token is not a JWE, so decode threw, `getToken`
 * returned `null`, and the request was refused with a generic 401 before any
 * handler — and therefore before `verifyApiKey` — ran:
 *
 * ```
 * $ curl -H 'Authorization: Bearer iflk_…' /api/t/<slug>/journal
 * 401 {"error":"Unauthorized"}
 * ```
 *
 * Meanwhile the admin UI minted keys, showed each one once, and told the
 * operator "Copy this key now — it will never be shown again!". A credential a
 * customer can create, is instructed to use, and which returns a 401
 * indistinguishable from a wrong key is worse for them than no feature at all.
 *
 * So creation was closed and this switch introduced, with a guard
 * (`tests/guards/api-key-auth-enabled.test.ts`, named `-disabled` until the
 * switch was flipped) that failed if anyone flipped
 * it without building the four things that make it work.
 *
 * ## What was built to turn it on
 *
 *  1. **The Edge carve-out.** `src/middleware.ts` now lets a request bearing
 *     an `iflk_` token past `getToken()` unauthenticated, bounded to
 *     `/api/t/`. The handler authenticates instead — the same deliberate hole
 *     SCIM and the signed webhooks have, with the same fail-closed guard:
 *     `tests/guards/tenant-api-routes-self-authenticate.test.ts`, derived from
 *     the filesystem so a route that does not exist yet is covered the moment
 *     it is created.
 *  2. **Scope enforcement, per request.** `enforceApiKeyScope` had ZERO
 *     callers. Wiring it into `requirePermission` alone would have covered ~23
 *     of 273 tenant routes; the rest gate on `assertCanWrite`, which reads a
 *     COARSE role derived from the key's scopes — so a `tasks:write` key could
 *     write journal entries, field operations and insurance leads. The gate is
 *     now `assertApiKeyMayReachPath`, called from `getTenantCtx`, which every
 *     one of the 273 reaches. See `api-key-scope.ts`.
 *  3. **A rate tier.** `apiKeyRateLimit.ts` — two buckets, hashed bearer and
 *     per-IP, because the carve-out makes `/api/t/` a surface where an
 *     anonymous caller reaches a key comparison.
 *  4. **Tests through the middleware.** The only CI signal used to be a
 *     source-text grep for `API_KEY_PREFIX`, which stayed green for the entire
 *     life of the bug. `tests/unit/api-key-edge-reachability.test.ts`
 *     puts a real header through the real middleware.
 *
 * Deliberately dependency-free so the `'use client'` admin page can import it.
 */
export const API_KEY_AUTH_ENABLED = true;

/**
 * Returned to a client that tries to create a key. It DIAGNOSES rather than
 * refusing blankly — the whole failure mode being fixed here is a credential
 * that fails in a way indistinguishable from a wrong one.
 */
export const API_KEY_DISABLED_MESSAGE =
    'API key authentication is not currently available: keys issued here cannot ' +
    'authenticate requests. Existing keys can still be listed and revoked.';
