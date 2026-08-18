# 2026-08-19 — native bearer authentication

**Commit:** `<pending> feat(auth): native bearer tokens bound to UserSession`

## Why this is mandatory, not optional

The Capacitor spike (F2) found that Google refuses OAuth inside embedded
webviews, and production sets `AUTH_CREDENTIALS_UI_HIDDEN=1`, so operators sign
in with Google. The mitigation is a system browser — which cannot set a cookie
the app's webview can read. Any native client therefore needs tokens. This is no
longer only a rewrite-path requirement.

## The one invariant

**A bearer credential is a CHILD of a `UserSession`.**

Not a parallel credential with its own lifecycle. Every lever the product
already has reaches a token because the token has no independent existence:

| lever | how it reaches a token |
|---|---|
| admin revoke at `/admin/members` | sets `UserSession.revokedAt` |
| `sessionMaxAgeMinutes` | caps `expiresAt` at insert |
| `maxConcurrentSessions` | stamps `revokedAt` on the oldest row |
| `User.sessionVersion` (password change/reset) | jwt-callback comparison |

A token that could outlive an admin clicking "revoke session" would be a
credential the product's own security UI cannot kill. That is the failure this
design exists to prevent, and it is why `issueRefreshToken` takes a session ROW
ID and the issue route returns **409 `session_not_tracked`** rather than minting
a credential it cannot later revoke.

## What had to be fixed first

Session revocation was **inert** — `token.error` was written in five places and
read in none. That shipped separately (#600) because it changes existing
behaviour, and because tokens cannot be made revocable while cookies aren't.

## Where the real work was: the server-side principal

`getToken()` already accepts an `Authorization: Bearer` header
(`next-auth/jwt/index.js:83`), so **middleware needed no change** — a bearer
already gets the identical `checkTenantAccess` answer.

But `getServerSession()` reads `sessionStore.value`, i.e. **cookies only**
(`core/routes/session.js:43`). `auth()` is `getServerSession(authOptions)`, and
every `/api/t/**` handler runs `requirePermission → getTenantCtx →
getSessionOrThrow → auth()`. So a bearer cleared the Edge and then 401'd.

And it failed in the worst possible place: `checkTenantAccess` returns `'allow'`
when `membershipsTruncated` and defers to the DB-backed gate — which, under a
bearer, had **no principal to defer to**. A user in more than
`MAX_JWT_MEMBERSHIPS` tenants succeeded with a cookie and failed with a token,
for the same request.

`resolveBearerSession` closes that with three properties:

- **One locator.** The same `getToken({ req, secret })` middleware calls.
- **One shaper.** The same `authOptions.callbacks.session` the cookie path runs.
- **Cookie wins.** If a cookie resolves, `auth()` returns exactly what it always
  did.

Claims are never reconstructed. `applyMembershipClaims` is the sole producer of
`memberships` / `membershipsTruncated` / `role`; a second producer missing its
ACTIVE filter, deleted-tenant filter, `createdAt` ordering or 50-item slice would
be silently more (or less) permissive than the cookie, in a population no fixture
covers. On refresh, claims are rebuilt from the database through that same
producer, so a refresh cannot keep stale authority alive.

## Threat model — the numbers, and why

A bearer token on a lost phone is not a same-site cookie. It cannot be scoped to
an origin, it survives app deletion if backed up, and nothing about it expires
because the user closed a tab.

**Access token: 15 minutes.** This is a revocation-window decision, not a
convenience one. A cookie is re-minted by the jwt callback on every session read,
so the `error` flag it carries is at most one request stale. An access token is
minted once and presented unchanged until expiry — nothing inside it can learn
that an admin revoked the session five minutes ago.

Two mechanisms bound that, and the second is why 15 minutes is honest rather than
hopeful:

1. **Live check on every bearer request.** `resolveBearerSession` calls
   `verifyAndTouchSession` on a path that is already DB-bound (`getTenantCtx`
   resolves membership immediately after), so revocation takes effect on the
   **next request**. This is what lets "an admin revoking a session invalidates
   the token" hold with no lifetime-shaped caveat.
2. **Fail-closed refresh.** Rotation checks the session live and refuses if it is
   revoked or expired.

So 15 minutes is the *worst case if the live check fails open* on a transient DB
error — a deliberate choice consistent with the cookie path, because failing
closed there would turn a database blip into a fleet-wide sign-out of every
operator mid-field.

**Refresh token: 30 days, capped by the session.** Long enough that a seasonal
operator who does not open the app for a fortnight is not silently signed out
mid-field; short enough that an abandoned device stops working without an admin
noticing. `capToSession` guarantees a refresh can never outlive the session it
hangs from, so `sessionMaxAgeMinutes` still governs.

**Rotation, and what replay means.** A refresh token is single-use. Presenting an
already-consumed one is not a retry — the legitimate client would hold the
successor — so it means two parties hold one credential and there is no way to
tell which is the thief. The whole family is revoked **and the session with it**.
A forced re-login for the victim beats a silently shared session.

The claim is a conditional `updateMany(consumedAt: null)`, not read-then-write.
Concurrent refreshes race and exactly one sees `count === 1`; the loser is
treated as a replay. Same shape as invite redemption in `tenant-invites.ts`, for
the same reason — a check-then-act would let a race mint two live families. There
is an executing test for exactly that, because a sequential-only suite passes
against a broken implementation here.

## Rate limiting

`/api/auth/**` goes through `checkAuthRateLimit` in middleware, which keys on
`(IP, ua-hash)` because it runs pre-authentication. `/api/auth/token*` is
**explicitly classified 'high' (10/min)** rather than inheriting the `'low'`
(60/min) default meant for `/csrf` and `/providers`. A refresh endpoint is an
unauthenticated credential exchange — the same abuse position as `/signin`.

A native client refreshes ~4×/hour at a 15-minute access lifetime, so 10/min
leaves more than an order of magnitude of headroom while capping guessing against
a 256-bit token.

Both routes additionally carry `LOGIN_LIMIT` via `withApiErrorHandling`. That is
not redundancy: the middleware tier keys on `(IP, ua-hash)`, the wrapper keys on
`(IP, userId)`. Neither alone covers both shapes.

## Failure responses are indistinguishable

Every refresh failure — unknown, malformed, missing, expired, revoked, replayed —
returns `401 {"error":"invalid_grant"}`. Distinguishing them would give an
enumeration oracle, and telling a thief their replay was *detected* is worse
still. Replay is logged at WARN server-side; the caller learns nothing.

## Files

| file | role |
|---|---|
| `prisma/schema/auth.prisma` | `NativeRefreshToken` (+51 lines, additive) |
| `prisma/migrations/20260818120000_native_refresh_token/` | table + asymmetric RLS |
| `src/lib/auth/native/refresh-tokens.ts` | mint, rotate, replay detection |
| `src/lib/auth/native/bearer-principal.ts` | server-side principal |
| `src/auth.ts` | `buildNativeAccessClaims` + bearer fallback in `auth()` |
| `src/app/api/auth/token/route.ts` | issue |
| `src/app/api/auth/token/refresh/route.ts` | rotate |
| `src/lib/rate-limit/authRateLimit.ts` | explicit 'high' tier for `/api/auth/token*` |

## Decisions worth re-reading before changing anything

- **RLS is the asymmetric single-policy form**, mirroring Epic D.1, because
  `tenantId` is nullable. Postgres OR's permissive policies, so a split
  `tenant_isolation_insert` would let an `app_user`-bound session UPDATE a
  NULL-tenant row to any tenant — i.e. re-point a live refresh token. Verified
  against the live database, not just written: `USING (tenantId IS NULL OR own)`
  / `WITH CHECK (own)`, with `relrowsecurity` and `relforcerowsecurity` both true.

- **Only the SHA-256 is stored.** A database disclosure yields no usable
  credential.

- **Issue/refresh declare `source: 'system'`** so the RLS middleware does not log
  `missing_tenant_context` at WARN on every mint. An unexplained warning on a
  credential path is how a real one later gets tuned out.

- **Routing was verified, not assumed.** `[...nextauth]` is a catch-all, but nine
  siblings already coexist with it in that directory (`register`, `ui-config`,
  `change-password`, …), two of them test-exercised. Next gives static segments
  priority.

## Verification

- 11 executing integration tests for the token store: one per revocation lever,
  rotation, replay-burns-lineage-and-session, concurrent double-spend, session
  capping, unknown token.
- 8 executing route tests: issue binds to the session, refuses when untracked,
  refuses a revoked session; refresh rotates, rebuilds claims from the DB, and
  returns byte-identical responses for four different failure causes.
- 5 **differential** parity tests: identical claims presented as a cookie and as
  a bearer, with the two answers compared **to each other** — including the
  truncated-memberships case. A test asserting "bearer returns allow" would pass
  against an implementation that allowed everything.
- `tsc` clean, zero `as any` in the auth path (`auth-stack-pinning` green), 581
  guard/guardrail suites green.

## Not in this change

The OAuth system-browser handoff (the flow that gets a native client its FIRST
token pair) builds on `POST /api/auth/token` and lands separately. Until then the
issue route is reachable only by a caller that already holds a session.
