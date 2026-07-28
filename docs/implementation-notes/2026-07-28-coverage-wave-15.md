# 2026-07-28 — Coverage wave 15: the auth callbacks

**Commit:** _(this PR)_

`src/auth.ts` was the densest uncovered file in the repo — **241 uncovered
branches in one file at 10.4%**, roughly a third of the whole `global`-group
branch deficit, and the most security-critical code in the codebase. This wave
takes it to **70.63% branches / 88.62% statements**.

## Why it was uncovered

One narrow spec (`tests/unit/jwt-update-trigger-refresh.test.ts`) executed a
single `jwt` path. The `jwt-membership-bound` guardrail *looks* like coverage
but `readFileSync`s the source and greps for `.slice(0, MAX_JWT_MEMBERSHIPS)` —
it never runs the cap. Same shape as the `FilterRangePanel` finding in wave 14:
a file can be heavily guarded and still be near-zero covered, because guards
assert on text and coverage measures execution.

So the paths that decide whether a session is still valid, whether MFA is
enforced, and whether an OAuth identity may attach to an existing account were
all unexercised.

## Files

| File | Role |
|---|---|
| `tests/unit/auth-callbacks.test.ts` | new — 37 behavioural tests over `signIn`, `jwt`, `session` |

## What the tests lock down

**`session` — client exposure.** The callback must hand the browser a
deliberately narrow projection. One test serialises the returned session and
asserts the OAuth `accessToken` / `refreshToken` values do not appear anywhere
in it, so a future "just spread the token" refactor fails loudly rather than
shipping live credentials to the client. A second pins the safe defaults on a
sparse token — `sub` fallback, `READER`, `mfaPending: false`.

**`jwt` — membership bounds.** The cap is now *executed*: 57 memberships in,
50 out, `membershipsTruncated: true`, with the tenant and org arrays capped
independently. A user whose memberships all disappear is demoted to `READER`
with a null tenant, so a stale `tenantId` cannot keep authorising the Edge gate.

**`jwt` — session revocation and the sessionVersion throttle.** Revoked session
row → `SessionRevoked`. Tracker throws → *fails open*, because signing every
user out on a transient DB blip is worse than the telemetry gap. A bumped
`sessionVersion` (what a password reset writes) → `SessionRevoked`; inside the
5-minute window the DB is not touched at all.

**`jwt` — OAuth refresh.** Refresh persists to the `Account` row, clears the
prior error, and preserves the existing refresh token when the provider does
not rotate one. A failed refresh sets `RefreshTokenError` rather than looping
silently on a dead grant.

**`jwt` — MFA.** Both halves: enforcement at sign-in (`REQUIRED` challenges
everyone; `OPTIONAL` challenges only the enrolled; no settings row means no
challenge) and challenge completion (a challenge at or after the token's `iat`
clears the flag; an older one does not, so a stale verification cannot satisfy
a fresh session). The fail-closed split is covered on both sides — a
fail-closed tenant holds the challenge and raises `MfaDependencyFailure` when
the MFA store is unreachable; a fail-open tenant lets the user through.

**`signIn` — provider trust and account linking.** The `email_verified === false`
rejection is an account-takeover guard: without it, anyone able to register an
unverified address at a permissive IdP could sign in as the owner of that
address. Tests cover the rejection, the admit path, the credentials-provider
exemption, first-time linking, the already-linked no-op (a duplicate insert
would violate `provider_providerAccountId` and break sign-in outright), and the
identity-is-already-the-user case.

## Decisions

- **Mocked at the external boundary only.** Prisma, the session tracker, the
  refresh helper and invite redemption are doubles; everything inside the
  callbacks is the real implementation. Mock setup stays a fraction of the
  file, and no test asserts on a mock's own behaviour.
- **Mutation-checked, in two passes.** Six targeted mutations, each caught by
  exactly the intended test:

  | Mutation | Caught by |
  |---|---|
  | `role ?? 'ADMIN'` | safe defaults on a sparse token |
  | dropped tenant-membership cap | caps memberships at `MAX_JWT_MEMBERSHIPS` |
  | `sessionVersion >=` | stamps check time when version unchanged |
  | `challengeTime >` | clears mfaPending at-or-after issue |
  | `email_verified === true` | rejects the unverified OAuth identity |
  | `if (existingAccount)` | links a new account / does not duplicate |

  A characterization test passes the moment it is written, which proves
  nothing; the 1:1 mutation mapping is what establishes these can fail.
- **Left uncovered deliberately.** The Entra group-claim + role-sync block
  (496–527) is two dynamic imports into modules with their own suites, and its
  entire contract is "never block sign-in" — best-effort, wrapped in
  `try/catch`. `auth()` and `signOut()` are one-line framework forwards.
  Covering them would be testing the framework rather than a contract this
  code makes.

## Remaining gap

With waves 14 and 15 landed, the ranking for wave 16 by absolute uncovered
branches inside the `global` group:

| Area | Uncovered branches | Files | Branch % |
|---|---|---|---|
| `src/components/ui` | ~2,400 | 546 | 61.2% |
| `src/app` | 1,719 | 111 | 51.7% |
| `src/app-layer/repositories` | 887 | 48 | 48.0% |
| `src/app-layer/jobs` | 626 | 51 | 68.2% |

`src/app-layer/repositories` is the strongest next target: 48 files at 48%,
concentrated in a handful of large repositories (`VendorRepository` 129,
`JournalRepository` 107, `ProcessMapRepository` 94), and repository query
shapes are testable without React.
