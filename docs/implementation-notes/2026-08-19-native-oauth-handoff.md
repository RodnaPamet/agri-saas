# 2026-08-19 — native OAuth handoff via the system browser

**Commit:** `<pending> feat(auth): system-browser sign-in with a PKCE-bound code`

## Why a handoff exists at all

Google refuses OAuth inside embedded webviews (`disallowed_useragent`), and
production sets `AUTH_CREDENTIALS_UI_HIDDEN=1`, so operators sign in with Google.
A native client must therefore complete sign-in in the SYSTEM browser — which
cannot set a cookie the app's webview can read.

Something has to cross that gap. A short-lived, single-use, PKCE-bound
authorization code crosses it, **and nothing else does**.

## Flow

```
app  ──▶ GET /api/auth/native/start?provider&redirect_uri&code_challenge
              stashes {challenge, redirect} in an HttpOnly cookie
              redirects to the EXISTING NextAuth sign-in
     ──▶ Google / Entra, in the system browser
     ──▶ GET /api/auth/native/complete        (session cookie now exists)
              mints a 60-second code, redirects to redirect_uri?code=…
     ──▶ POST /api/auth/native/exchange       code + verifier → token pair
```

Nothing about Google sign-in is reimplemented; the handoff wraps the existing
flow at both ends.

## Decisions

- **Only the code travels.** A token in a redirect URL would be written to
  browser history, possibly OS logs, and handed to whatever app claims the
  scheme. Asserted in test: the redirect contains no `accessToken`,
  `refreshToken`, or JWT-shaped value.

- **The challenge lives in a cookie, not in OAuth `state`.** `state` round-trips
  through Google and lands in history; the cookie never leaves our origin.

- **PKCE is S256-only.** `plain` puts the verifier in the challenge, proving
  possession of nothing — an interceptor who sees one has the other.

- **A wrong verifier does NOT consume the code.** Otherwise one guess from an
  interceptor locks out the legitimate client: the attacker gains nothing, but
  denial of sign-in is still a successful attack. Tested explicitly — a bad
  attempt is refused and the real client still completes.

- **The claim is atomic.** `updateMany` with `consumedAt: null` is the
  test-and-set; two concurrent exchanges race and exactly one wins. A
  read-then-write would mint two token families from one authorization. Same
  reasoning as `tenant-invites.ts`.

- **60 seconds, not minutes.** The code rides a redirect the OS may record. Its
  security model is that it is stale almost immediately — long enough to
  foreground an app and make one HTTPS request.

- **The redirect allowlist fails CLOSED.** `NATIVE_AUTH_REDIRECT_ALLOWLIST` is
  empty by default and an empty allowlist refuses everything. An unconfigured
  deployment simply has no native sign-in, which is the safe failure; the
  alternative is an open redirect that also carries a live authorization code.
  It is re-validated at `/complete`, not only at `/start`, so cookie tampering
  is one check away from nothing rather than one check away from an open
  redirect. An empty-string allowlist entry is rejected too, since `''` is a
  prefix of everything and one blank config line would otherwise open the gate.

## The Epic 1 trap, and why this route is clear of it

Invite redemption originally ran in the `signIn` callback and wrote memberships
against a non-existent `User` FK, because a first-time OAuth user's `user.id` is
the **identity-provider subject** until the Prisma adapter creates the row —
which happens after `signIn` returns. It was moved to the `jwt` callback for
exactly that reason.

`/complete` runs later still: it is an ordinary request carrying a session
cookie, so the adapter has committed the `User` row **and** the `jwt` callback
has already run `recordNewSession`. Both FKs resolve for a first-time user.

That is a claim worth enforcing rather than trusting, so a missing session row is
refused with **409 `session_not_tracked`** instead of being papered over — a code
minted against a session that does not exist would exchange into tokens hanging
off nothing. And there is an executing test that walks a genuinely
first-time user through the whole handoff.

## IdP-verified email

`src/auth.ts` sets `emailVerifiedByIdp: account.provider !== 'credentials'`
because the credentials provider's email is self-asserted. **Nothing in this
handoff lets a native client assert an identity**: every claim is read from the
server-minted session token, and the client contributes only its PKCE challenge
and redirect URI.

## Provider scope (P2.5) — decided, not half-wired

**Both configured IdPs are supported**, via a closed `provider` allowlist
(`google`, `microsoft-entra-id`). Hardcoding Google would have been the actual
half-wiring: Entra is registered in `src/auth.ts`, and the handoff is
provider-agnostic after sign-in.

Worth recording honestly: **Google is what forced this work.** Entra is
historically more permissive about embedded webviews and may well still work
inside one. It is wired because the code path is identical and omitting it would
be arbitrary — but *whether Entra needs the handoff* is a device question that
has not been answered.

## Files

| file | role |
|---|---|
| `prisma/schema/auth.prisma` | `NativeAuthCode` (+46, additive) |
| `prisma/migrations/20260819120000_native_auth_code/` | table + asymmetric RLS |
| `src/lib/auth/native/auth-codes.ts` | mint, exchange, PKCE, allowlist |
| `src/app/api/auth/native/{start,complete,exchange}/route.ts` | the three steps |
| `src/env.ts` | `NATIVE_AUTH_REDIRECT_ALLOWLIST` |

## Verification

- 13 executing tests on the code service: single-use, concurrent double-exchange
  leaves exactly one winner, wrong/absent verifier refused, wrong verifier does
  not burn the code, expiry, revoked session, redirect allowlist including the
  empty-string case.
- 5 executing route tests through the real handlers, including a **first-time
  OAuth user** completing the whole handoff, single-use across the routes, and
  identical response shapes for every failure.
- 581 guard/guardrail suites green; `tsc` clean; RLS verified against the live
  database and registered in `SINGLE_POLICY_EXCEPTIONS`.

## Not covered

The device half. Whether `ASWebAuthenticationSession` returns control to the app
cleanly, whether the custom scheme is claimed as expected, and whether Entra
needs this at all are all questions only a physical iPhone answers.
