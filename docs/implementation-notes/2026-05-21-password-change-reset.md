# 2026-05-21 — Password change + reset flows

**Commit:** `feat(auth): password change + reset flows, HIBP-enforced`

## Design

Three new routes under `/api/auth/`, plus the pages that drive them:

```
authenticated                      unauthenticated (token-driven)
─────────────                      ─────────────────────────────
/account/security                  /forgot-password
  └ POST change-password             └ POST forgot-password  ─┐
      verify currentPassword             issue token, email   │ enumeration-safe
      policy + HIBP                                            │ (always 200)
      swap hash                      /reset-password?token=…  ─┘
      revoke ALL sessions              └ POST reset-password
                                          policy + HIBP
                                          consume token (single-use)
                                          swap hash
                                          revoke ALL sessions
```

**Token model.** A dedicated `PasswordResetToken` table — deliberately
NOT a reuse of NextAuth's `VerificationToken`, so a verify-email link
can never be replayed as a password reset. The raw 256-bit token lives
only in the emailed link; the DB stores `SHA-256(raw)`, so a leaked
dump cannot be replayed. Single-use is a conditional `updateMany`
claim (`usedAt IS NULL AND expiresAt > now`) — concurrent submits race
to exactly one winner, the same pattern as `tenant-invites`. TTL is
1 hour (account-takeover-adjacent; much shorter than the 24h
verify-email link).

**Session invalidation.** Every change/reset success revokes *all* of
the user's sessions two ways: `User.sessionVersion` is bumped (the
throttled JWT-callback backstop) and every live `UserSession` row is
stamped `revokedAt` (the immediate, per-request Epic C.3 check). For
`change-password` this includes the caller's own session — the route
returns `reauthRequired: true` and the UI redirects to sign-in.

**Enumeration safety.** `forgot-password` always returns `{ ok: true }`.
`issuePasswordReset` is a silent no-op for unknown emails AND for
OAuth-only accounts (no `passwordHash` — nothing to reset), and
swallows mailer failures.

**HIBP.** `change-password` and `reset-password` both run
`validatePasswordPolicy` then `checkPasswordAgainstHIBP` at the route
boundary (fail-open on a HIBP outage). The Epic E.4 guardrail's
structural scan flags any password-accepting route that skips it; the
schemas are defined inline in the route files precisely so the scan
sees them.

> **Superseded (#1166).** That last clause was the convention at the
> time and is no longer a requirement. The scan follows imports per
> symbol (`tests/helpers/password-schema-graph.ts`) and matches the
> field by NAME rather than by a literal `z.` after the colon, so a
> password field declared in a shared schema module — or bound to a
> named sub-schema — is seen either way. These two routes keep their
> inline schemas because there was no reason to move them, not
> because the guard needs them there.

## Files

| File | Role |
|---|---|
| `prisma/schema/auth.prisma` | New `PasswordResetToken` model + `User` back-relation. |
| `prisma/migrations/20260521000000_add_password_reset_token/` | The table + indexes + FK. |
| `src/lib/auth/password-management.ts` | `issuePasswordReset` / `consumePasswordReset` / `changePassword` — token lifecycle + persistence + session revocation. |
| `src/lib/auth/passwords.ts` | New `describePasswordPolicyFailure` — one source of truth for policy-failure copy. |
| `src/lib/auth/security-events.ts` | New `recordPasswordReset{Requested,Completed}` + `recordPasswordChanged` audit emitters. |
| `src/app/api/auth/{forgot,reset,change}-password/route.ts` | The three HTTP routes. |
| `src/lib/auth/guard.ts` | `/forgot-password` + `/reset-password` added to the public-path allowlist. |
| `src/app/{forgot-password,reset-password,account/security}/` | The driving pages. |
| `tests/guardrails/hibp-coverage.test.ts` | `change-password` + `reset-password` registered in `HIBP_REQUIRED_ROUTES`. |
| `tests/unit/tenant-isolation-structural.test.ts` | New pages added to the non-tenant root-page allowlist. |

## Decisions

- **Dedicated token table, not `VerificationToken` reuse.** A single
  shared token table would make a verify-email token and a reset token
  interchangeable — a privilege confusion. One table per purpose.
- **Hash the token at rest.** `VerificationToken` already does this;
  `tenant-invites` stores raw (entropy is the boundary). Reset tokens
  are the higher-stakes case, so they get the hash-at-rest treatment.
- **Change-password revokes the caller's own session too.** The
  alternative — keep the current session alive — means NOT bumping
  `sessionVersion` (which would invalidate the current JWT) and instead
  revoking only *other* `UserSession` rows by id. That is fragile and
  leaves a 5-minute throttle window. Revoking everything and forcing
  one clean re-login is simpler and strictly safer.
- **`PasswordResetToken` is not tenant-scoped.** A password is one
  identity, shared across every tenant a user belongs to — like
  `User` / `VerificationToken`, the table carries no `tenantId` and
  needs no RLS policy.
- **Rate limits.** `forgot-password` → `EMAIL_DISPATCH_LIMIT` (5/hr per
  IP — email-bomb mitigation); `reset-password` → `LOGIN_LIMIT` (the
  preset's JSDoc names password reset as an intended use);
  `change-password` → default mutation limit (authenticated, and
  `currentPassword` must verify).
