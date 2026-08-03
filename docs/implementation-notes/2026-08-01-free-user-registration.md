# 2026-08-01 — Free self-service registration, made correct and safe to enable

**Commit range:** `1c187ebd..3c85aac1` (design doc through the plan-doc
fixups), plus this final-review fix pass.

## Design

`/api/auth/register` already existed as a working credentials signup
endpoint, but three properties needed to be true before the flow could
be turned on for real (unauthenticated) users: the creator of a new
workspace must be able to administer it, a partial failure must never
strand a real person with an unusable account, and — once email
verification is required — an unconfirmed registrant must not walk
away with a working session.

```
POST /api/auth/register
  │
  ├─ validate password policy + HIBP breach check (before any DB write)
  ├─ hash password (bcrypt cost 12) — BEFORE opening the transaction
  ├─ check for an existing user by emailHash (409 on duplicate)
  │
  ├─ ONE $transaction:
  │     tenant.create (name, slug, encryptedDek via generateAndWrapDek())
  │     user.create   (email, emailHash, passwordHash, name)
  │     tenantMembership.create (role: OWNER, status: ACTIVE)
  │     tenantOnboarding.create
  │
  ├─ appendAuditEntry(TENANT_CREATED)   — after commit, .catch()+log
  ├─ issueEmailVerification(email)      — swallows mailer failures
  └─ response: { user, tenant, emailVerificationRequired }
        + legacy `token` cookie, ONLY when verification is not required
```

At sign-in, the credentials `authorize()` callback (`src/auth.ts`) now
surfaces exactly one additional failure reason —
`throw new Error('EmailNotVerified')` — reachable only after
`authenticateWithPassword` has already confirmed the password is
correct (`src/lib/auth/credentials.ts`). Every other failure (unknown
email, wrong password, rate-limited) still collapses into NextAuth's
generic `CredentialsSignin`. The login page (`src/app/login/page.tsx`)
catches `EmailNotVerified` distinctly and, after a fresh registration
when `emailVerificationRequired` is true, skips the sign-in attempt
entirely and shows a "check your inbox" panel instead — suppressing
the register/sign-in heading and the OAuth buttons while that panel is
up so the card reads as one state, not two stacked ones.

Self-service signup is rate-limited via `SIGNUP_LIMIT` (now 15/hour
per IP — see the rate-limit section of CLAUDE.md / this PR's finding
2 fix) applied at `withApiErrorHandling`'s mutation-tier hook.

Two operator flags gate all of this in production —
`AUTH_CREDENTIALS_UI_HIDDEN` (hide the signup UI; the backend route
stays reachable) and `AUTH_REQUIRE_EMAIL_VERIFICATION` (gate credentials
sign-in on a confirmed address) — documented in
`deploy/env.prod.example` but **deliberately left unset on the live
VM** pending a mailer health check; see Decisions.

## Files

| File | Role |
|---|---|
| `src/app/api/auth/register/route.ts` | Atomic transaction for tenant+user+membership+onboarding; OWNER role; DEK generated inline via `generateAndWrapDek()`; legacy `token` cookie skipped when email verification is required |
| `src/auth.ts` | Credentials `authorize()` surfaces `EmailNotVerified` as a distinct thrown error; every other reason stays collapsed |
| `src/lib/auth/credentials.ts` | `authenticateWithPassword` returns the `email_not_verified` reason only after password verification succeeds; `dummyVerify` equalises timing on the deny paths |
| `src/app/login/page.tsx` | `awaitingVerification` state; shows a check-your-inbox panel post-registration instead of attempting sign-in; catches `EmailNotVerified` on direct login attempts |
| `src/lib/security/rate-limit.ts` | `SIGNUP_LIMIT` preset (15/hour/IP) |
| `src/lib/security/tenant-key-manager.ts` | Doc comments updated to describe the two transaction-bound call sites (register route, `createTenantWithOwner`) that replicate `createTenantWithDek`'s body against a `tx` client instead of calling it directly |
| `deploy/env.prod.example` | Documents `AUTH_CREDENTIALS_UI_HIDDEN` + `AUTH_REQUIRE_EMAIL_VERIFICATION` |
| `tests/integration/register-atomicity.test.ts` | Proves the transaction rolls back fully on a mid-transaction failure — no orphaned user/tenant |
| `tests/unit/register-route.test.ts` | Registration request/response contract, including the OWNER role and `emailVerificationRequired` field |
| `tests/unit/auth-authorize-reason.test.ts` | `EmailNotVerified` is the only reason that escapes the generic `CredentialsSignin` collapse |
| `tests/guardrails/no-auto-join.test.ts` | Allowlist reason kept accurate (OWNER, not ADMIN) |

## Decisions

- **OWNER, not ADMIN, for the self-service creator.** The
  `tenant_membership_last_owner_guard` DB trigger only fires on an
  UPDATE/DELETE that would drop a tenant to zero ACTIVE owners — it is
  blind to a tenant that is *born* at zero owners. An ADMIN-only
  self-service tenant would have no path to transfer ownership, rotate
  the tenant DEK, or delete the workspace, with no trigger to catch the
  mistake at creation time. Making the creator OWNER closes that gap
  structurally rather than relying on a future audit to notice it.

- **One transaction for all four rows.** The four writes (tenant, user,
  membership, onboarding) were previously sequential and unguarded. A
  failure between the user insert and the membership insert left a real
  `User` row with no workspace — and no way to retry, because the
  duplicate-email check ahead of it now returns 409 for their own
  address. Wrapping all four in one `$transaction` makes partial
  failure impossible: either the workspace exists in full, or nothing
  was created and the email is free to retry.

- **Password hashed before the transaction opens.** bcrypt at cost 12
  costs hundreds of milliseconds. `DATABASE_URL` points at PgBouncer in
  transaction-pooling mode, where holding a transaction open across
  that cost pins a pooled connection for the duration — expensive under
  load, and a plausible amplification vector for a self-service
  endpoint with no auth in front of it. Hashing happens before
  `$transaction` opens so the transaction itself is just fast row
  inserts.

- **`createTenantWithDek` couldn't be reused as-is.** It creates the
  tenant row against the singleton Prisma client, so it can't join a
  caller's transaction. The register route (and, identically,
  `createTenantWithOwner` for platform-admin bootstrap) instead inlines
  `generateAndWrapDek()` + `tx.tenant.create` directly. The DEK cache
  isn't primed on this path — it unwraps lazily on first use, same as
  any tenant that gets its DEK backfilled later.

- **Exactly one auth failure reason is surfaced.** `EmailNotVerified` is
  reachable only after the password has already been verified
  (`credentials.ts` checks password first, email-verified status
  second), so it tells an attacker nothing they couldn't already infer
  by getting the password right. Every other failure — unknown email,
  wrong password, progressive-lockout rate limiting — stays collapsed
  into NextAuth's generic `CredentialsSignin`, and `dummyVerify`
  equalises the timing of the deny paths so response latency isn't a
  side channel either.

- **The audit-append `.catch` stays a catch, but now logs.** The
  `TENANT_CREATED` audit write happens after the transaction commits,
  so a failure there can no longer undo a real workspace — propagating
  it would hand the new owner a 500 for a signup that actually
  succeeded. But a hash-chained audit trail with a silently-missing
  entry breaks provenance for that tenant with zero operator
  visibility, so the catch now logs loudly (`register.audit_append_failed`)
  instead of swallowing silently.

- **Production env flags are documented but not yet flipped.** Both
  `AUTH_CREDENTIALS_UI_HIDDEN=0` (signup UI visible) and
  `AUTH_REQUIRE_EMAIL_VERIFICATION` are listed in
  `deploy/env.prod.example` for operator awareness, but turning
  verification on is an operator decision gated on confirming the
  production mailer is healthy first — a mail outage combined with
  required verification would silently lock every new registrant out
  of their own workspace. That flip is out of scope for this branch.
