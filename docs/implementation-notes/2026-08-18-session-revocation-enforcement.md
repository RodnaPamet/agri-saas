# 2026-08-18 — session revocation was inert; enforce `token.error`

**Commit:** `<pending> fix(auth): actually deny a request whose session was revoked`

## Problem

`verifyAndTouchSession` detected revocation correctly. The `jwt` callback
flagged it correctly. **Nothing read the flag.**

`token.error` was written in five places and read in none:

| writer | meaning |
|---|---|
| `auth.ts:637`, `:727` | `SessionRevoked` — admin revoke, expiry, `maxConcurrentSessions` eviction, `User.sessionVersion` bump |
| `auth.ts:591`, `:708` | `MfaDependencyFailure` — a **fail-closed** MFA check that could not complete |
| `auth.ts:681` | `RefreshTokenError` — OAuth refresh failed; the adjacent log reads *"Token refresh failed, forcing reauth"* |
| `entra-group-sync.ts:182` | `EntraGroupGateDenied` |

Verified four ways: `grep SessionRevoked src/` returned two writes and a
comment, no reads; the `session` callback copies id/tenantId/role/uiLanguage/
mfaPending/memberships but **not** `error`; `middleware.ts` and `guard.ts` never
inspect it; `getTenantCtx` performs no session re-validation and no client
component reads `session.error`.

So the `/admin/members` "revoke session" button, the concurrency cap, session
expiry, and the `sessionVersion` backstop that CLAUDE.md says makes password
change and reset *"revoke ALL of the user's sessions"* were all inert. A revoked
session kept working. `session: { strategy: 'jwt' }` sets no `maxAge` (30-day
default) and NextAuth re-issues on each request, so an actively-used revoked
session was effectively unbounded.

Two of these fail in the most misleading direction available: a **fail-closed**
MFA check was failing **open**, and a refresh failure logged *"forcing reauth"*
while forcing nothing.

## Why CI never caught it

This is the part worth keeping.

- `tests/unit/session-revocation.test.ts:51` declares its **own** local
  `isSessionRevoked(tokenVersion, dbVersion)` and tests that reimplementation.
  It never touches the code that runs.
- `tests/unit/auth-callbacks.test.ts:387` asserts
  `expect(result.error).toBe('SessionRevoked')` — that the callback **returns**
  the flag. It cannot observe whether anything acts on it.

Both were green throughout. This is exactly the failure CLAUDE.md documents
under "Green is not the same as executed", sitting in the auth path.

## Design

One check in `src/middleware.ts`, immediately after the existing `if (!token)`
branch. A token that exists but carries an error is treated exactly like no
token: **401** for `/api/**`, **redirect to `/login`** for pages, plus clearing
the stale session cookie so the browser stops re-presenting a dead credential.

Three properties made this the right seam rather than the `session` callback:

1. **The matcher already covers everything.** `/((?!_next/static|_next/image|
   favicon…).*)` — every route, page and API alike.
2. **`getToken()` reads the cookie AND an `Authorization: Bearer` header**
   (`node_modules/next-auth/jwt/index.js:83`). So the forthcoming native bearer
   tokens are denied by the *same* code. There is no second enforcement path to
   keep in sync — which is a requirement of the bearer-token work, satisfied by
   construction rather than by discipline.
3. **`isPublicPath` runs first**, and covers `/login` and `/api/auth`, so a
   denial cannot redirect-loop. Fixing this in the `session` callback would have
   covered cookies only and guaranteed the divergence.

## Decisions

- **All four error kinds deny, not just `SessionRevoked`.** Leaving three of
  four wired to nothing is how this existed in the first place.

- **The fail-open on transient DB errors is deliberately UNCHANGED.**
  `verifyAndTouchSession` still returns not-revoked when the row is unknown or
  the DB throws. Failing closed there would convert a database blip into a
  fleet-wide sign-out of every operator mid-field — a self-inflicted outage, and
  the DB being unavailable already breaks every page. **The bug was never the
  fail-open on an UNKNOWN answer; it was ignoring a DEFINITE one.**

- **Empty string is not a sentinel.** A successful refresh clears the flag with
  `delete token.error` (`auth.ts:664`), but a defensive `''` must not read as a
  denial. Asserted.

## Verification

The test drives the real `src/middleware.ts` — the harness
`tests/unit/cors.test.ts` established — and asserts **a denied request**, not a
returned value.

Proved by mutation rather than asserted: with the gate removed, **10 of 13 fail**;
restored, **13/13 pass**. The three that pass either way are the negative
controls (a valid token must still proceed, a public path must not be denied),
which is what makes the other ten meaningful.

`tsc --noEmit` clean; **584 guard/guardrail suites (7,506 tests)** green,
including the existing auth-callback and session-revocation suites unchanged.

## Expected on deploy

This will sign out anyone currently holding a revoked, expired, or
over-the-concurrency-cap session. Those are sessions that should already be
gone — but it is a visible behaviour change, which is why it ships as its own PR
rather than folded into the native-auth work that needs it.
