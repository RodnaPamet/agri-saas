# 2026-08-19 — SCIM was unreachable; the Edge 401'd every request

**Commit:** `<pending> fix(scim): let provisioning requests reach their handlers`

## What was wrong

SCIM 2.0 provisioning shipped complete: token minting and hashing, revocation,
tenant isolation, an admin UI, Users and Groups endpoints, integration tests.
And **no SCIM request had ever reached a handler.**

`src/middleware.ts` calls `getToken({ req, secret })`, which understands only a
NextAuth JWE. A SCIM bearer is an opaque `scim_<base64url>` string compared
against a SHA-256 hash in `TenantScimToken`, so `getToken()` returned `null`,
and the next line answered `401 {"error":"Unauthorized"}`. An IdP configured
against this app saw that and nothing else, from the day the feature landed.

Verified by curl against a real `next start`, not by reading:

```
$ curl -H 'Authorization: Bearer scim_…' /api/scim/v2/Users
401 {"error":"Unauthorized"}
```

That body is `unauthorizedJson()` from `src/lib/auth/guard.ts`. The handler's
own 401 would carry `schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"]`.
The difference between those two bodies is the entire bug, and it is the
assertion the new e2e is built around.

## Why CI could not see it

`tests/integration/scim.test.ts` and `scim-isolation.test.ts` import
`authenticateScimRequest` from `@/lib/scim/auth` and hand it a `NextRequest`
they construct themselves. They prove the auth **function** is correct — which
it was, the whole time. Nothing in the suite crossed the middleware, so nothing
could observe that the function was never called.

This is the third instance of one shape in a month:

| | mechanism | severed at |
|---|---|---|
| #600 | `token.error` session revocation | nothing read the flag |
| — | `iflk_` API keys | Edge 401 before `verifyApiKey` |
| this | SCIM | Edge 401 before `authenticateScimRequest` |

Each was complete and unit-tested; each was cut at the enforcement seam; none
had a test spanning the seam. **A new auth scheme needs an HTTP-level test that
crosses the middleware**, or it is not known to work.

## Design

`/api/scim/` joins `PUBLIC_PATH_PREFIXES`. The Edge cannot verify a hashed
token — it has no database — so the only place that can is the route itself.
That is a deliberate hole in the Edge gate, and the PR is mostly the
compensating controls rather than the one-line carve-out.

**What the carve-out actually skips** (read gate by gate): the JWT verify +
401, which is the point; the `token.error` revocation check, which is vacuous
here since `token` is `null` and SCIM revocation lives on
`TenantScimToken.revokedAt`; and the client-version gate, which already treats
an absent header as compatible and should not 426 an IdP over our native-app
contract. Everything else was already inert for this path — the tenant, org,
MFA and admin gates all require an `/api/t/`, `/org/` or `/admin` prefix. CSP,
security headers, request-id and CORS are applied in the OUTER `middleware()`,
after `authMiddleware` returns, so public paths keep them.

**Tenant isolation gets stronger, not weaker.** `authenticateScimRequest`
resolves the tenant from the token, so a token can only act on its own tenant.
There is no slug in the path to mismatch.

## Files

| file | role |
|---|---|
| `src/lib/auth/guard.ts` | the carve-out, with the reason and the compensating control named |
| `src/middleware.ts` | SCIM rate limit, inside the public-path branch |
| `src/lib/rate-limit/scimRateLimit.ts` | NEW — two-bucket limiter |
| `src/lib/security/rate-limit.ts` | `SCIM_LIMIT` + `SCIM_IP_LIMIT` presets |
| `tests/guards/scim-routes-self-authenticate.test.ts` | NEW — fail-closed, filesystem-derived |
| `tests/unit/scim-edge-reachability.test.ts` | NEW — drives the real middleware |
| `tests/unit/scim-rate-limit.test.ts` | NEW — executing limiter policy |
| `tests/e2e/scim-provisioning.spec.ts` | NEW — real HTTP, cookie-less context |

## Decisions

- **The trailing slash is load-bearing.** `isPublicPath` is a `startsWith`
  test, so `'/api/scim'` would also open `/api/scimulator` or a future
  `/api/scim-admin`. Both the unit test and the limiter's scope test pin the
  boundary.

- **The guard derives its inventory from the filesystem.** A hardcoded list
  would have to be remembered, and the thing being remembered is "this new
  route is anonymous unless you authenticate it". It fails closed, asserts a
  floor so an empty scan cannot pass vacuously, and is mutation-proven:
  removing the auth call from `Groups POST` turns it red.

- **`ServiceProviderConfig` is the one exemption, and it is bounded.** RFC 7644
  §4 defines it as discovery metadata an IdP reads *before* it holds a token.
  It touches no database and returns capability flags plus the caller's own
  host. The guard additionally fails if that file ever grows a `prisma` call —
  an exemption that silently becomes an open tenant endpoint is worse than no
  exemption.

- **SCIM had no rate tier at all, and needed two buckets.** The read tier
  requires `/api/t/`; the mutation tier lives in `withApiErrorHandling`, which
  SCIM does not use. Now anonymous at the Edge, these are the only routes where
  an unauthenticated caller reaches a token comparison. Per-bearer alone is
  useless against exactly that: a caller rotating a fresh guess per request
  gets a fresh bucket per request and is never limited. Per-IP alone would
  throttle innocent tenants, because Entra egresses several tenants' syncs from
  one Microsoft IP pool — hence a ceiling at double the per-tenant budget.
  Proven by mutation: with the per-bearer bucket only, 11 of 12 limiter tests
  pass and precisely the rotation test fails.

- **The bearer is hashed into the rate-limit key.** A rate-limit key ends up in
  Redis and in logs; a live provisioning credential must not.

- **Two levels of reachability test, deliberately.** The jest file drives the
  real middleware in-process and runs on every shard — cheap, and it fails on
  pre-fix code (nine assertions go red). It never opens a socket, so it cannot
  catch a Next change to matcher application or `NextResponse.next()`
  serialisation; the Playwright spec is the socket-level backstop, and it uses
  a **cookie-less** browser context because `authedPage.request` would carry a
  session cookie that clears the Edge on its own and prove nothing.

- **The minting route stays gated.** `POST /api/t/:slug/admin/scim` is not
  under `/api/scim/`, so it keeps the session gate and
  `requirePermission('admin.scim')`. Both the unit test and the e2e assert a
  SCIM bearer cannot reach it — otherwise a leaked provisioning token could
  mint more of itself.
