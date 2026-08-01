# 2026-08-01 — Free self-service registration

## Summary

Make the existing self-service signup flow reachable in production, correct
the role it grants, harden its failure modes, and gate first login on email
confirmation.

**The flow is already built.** The login page carries a register toggle, the
`/api/auth/register` route creates a tenant + user + membership and fires a
verification email, and the verify-email routes consume the token. None of it
is reachable in production because `AUTH_CREDENTIALS_UI_HIDDEN=1` on the VM
hides the entire credentials block — form, register toggle, and resend row.

So this is not a build. It is: fix two real defects, close one UX trap that
only appears once verification is enforced, then flip two env flags.

## Evidence gathered before designing

Measured against live production on 2026-08-01, not assumed:

| Question | Finding |
|---|---|
| Is the register UI reachable in prod? | No. `GET /api/auth/ui-config` → `{"credentialsFormHidden": true}` |
| Is the credentials provider registered? | Yes. `GET /api/auth/providers` lists `credentials`. It is always registered (`auth.ts:302`); only the UI is hidden |
| Do zero-OWNER tenants already exist? | No. `total_tenants=1, tenants_without_active_owner=0` — the OWNER fix is forward-only, no backfill |
| Would requiring verification lock anyone out? | No. `total_users=5, unverified=5, password_users=0` — all prod users are OAuth, and the gate at `credentials.ts:320` only runs in the credentials path |
| Is email configured in prod? | Yes. `SMTP_HOST` and `SMTP_USER` are both present |
| Is `AUTH_TEST_MODE` set in prod? | No — correct. It disables brute-force lockout and rate limiting |

## Design

### A — Registration grants OWNER, not ADMIN

`src/app/api/auth/register/route.ts:116` creates the membership with
`role: 'ADMIN'`. The platform-admin path (`createTenantWithOwner`,
`tenant-lifecycle.ts:107`) grants `OWNER`. Epic 1 made these differ in a way
that matters:

```
permissions.ts:105  OWNER → tenant_lifecycle: true,  owner_management: true
permissions.ts:124  ADMIN → tenant_lifecycle: false, owner_management: false
```

Every self-service workspace is therefore born with **zero OWNERs**. Nobody in
it can delete the tenant, rotate its DEK, transfer ownership, or invite another
OWNER — those permissions resolve to `false` for every member, forever.

The DB trigger `tenant_membership_last_owner_guard` does not catch this: it
fires on UPDATE and DELETE that would drop a tenant to zero owners. It cannot
see a tenant that was *born* at zero. The guard protects the transition, not
the initial state.

**Change:** `role: 'ADMIN'` → `role: 'OWNER'`.

### B — Make registration transactional, and add what it omits

Today the route runs three unguarded writes in sequence
(`route.ts:95`, `:102`, `:112`):

```
createTenantWithDek()  →  prisma.user.create()  →  prisma.tenantMembership.create()
```

A failure between the second and third leaves a real `User` row with no
membership. That user is stranded on `/no-tenant` permanently and **cannot
retry** — their email is now taken, so a second signup attempt returns 409 at
`route.ts:88`. A failure between the first and second orphans a tenant with a
wrapped DEK and no members.

`createTenantWithOwner` already models the correct shape: one
`$transaction` covering tenant + membership + onboarding row, with audit
entries appended after commit so data is durable before the hash chain
extends.

**Change:** wrap tenant + user + membership in a single transaction. Add the
`TenantOnboarding` row for parity with the platform-admin path. Append
hash-chained audit entries for tenant creation and membership grant, with an
actor type reflecting self-service rather than `PLATFORM_ADMIN`.

Reusing `createTenantWithOwner` wholesale was considered and rejected: it
upserts a User with no password (`tenant-lifecycle.ts:67`), while registration
must create one with a `passwordHash`, and it hard-codes
`actorType: 'PLATFORM_ADMIN'`. Mirroring its guarantees is the right amount of
reuse; forcing the call site to fit would distort both.

### C — Surface "email not verified" distinctly at login

`auth.ts:322` returns `null` for every authentication failure, which NextAuth
collapses into a single `CredentialsSignin` error. This is deliberate — it is
the account-enumeration-safe shape.

Once verification is enforced, that shape produces a bad outcome: a user who
enters their **correct** password is told their credentials are invalid, with
no indication that the real problem is an unclicked email. This is the largest
support-load risk in the change.

**Change:** when `authenticateWithPassword` returns
`reason === 'email_not_verified'`, surface a distinct error so the login page
can render a "confirm your email" message pointing at the resend form that
already exists at `login/page.tsx:343–377`.

**Why this does not weaken enumeration safety.** `credentials.ts` verifies the
password at line 300 and only reaches the verification gate at line 320. The
distinct reason is therefore reachable *only* by someone who has already proved
they know the password — it discloses nothing they did not already have. Every
other failure (unknown email, wrong password, locked out) stays collapsed into
one indistinguishable response, and `dummyVerify` keeps their timing equal.

### D — Replace post-register auto-sign-in with a "check your inbox" state

`login/page.tsx:119` calls `signIn()` immediately after a successful
registration. With verification required this call now fails, so a user who
just registered successfully would be shown a login error.

The register response already returns `emailVerificationRequired`
(`route.ts:158`) for exactly this purpose.

**Change:** branch on that field. When true, skip `signIn()` and render a
confirmation panel telling the user to check their inbox, with the resend
affordance. New user-facing strings go into **both** `messages/en.json` and
`messages/bg.json` with a real Bulgarian translation, per the i18n convention.

### E — Abuse limiting on the register endpoint

`/api/auth/register` inherits the default `API_MUTATION_LIMIT` (60/min).
For an endpoint that provisions a **tenant plus a wrapped per-tenant DEK** on
every successful call, that permits 60 workspaces per minute per IP.

**Change:** add a dedicated stricter preset in
`src/lib/security/rate-limit.ts` alongside `LOGIN_LIMIT` and
`EMAIL_DISPATCH_LIMIT`, and apply it via the route's
`{ rateLimit: { config, scope } }` options.

> Scope note: this was raised as optional and accepted. It is the most
> separable item here — drop it without affecting A–D if scope needs cutting.

### F — Production env changes, applied last

Through `deploy/`, never a VM hand-edit:

- remove (or zero) `AUTH_CREDENTIALS_UI_HIDDEN` — exposes the register toggle
- set `AUTH_REQUIRE_EMAIL_VERIFICATION=1` — enforces confirmation

**Order is load-bearing.** Ship A–E, confirm mailer health, *then* flip.
`metrics.ts:549` documents a verification-email delivery signal that exists
specifically to detect a mailer outage **before** this flag can lock users out.
Flipping first would invert the safety margin the metric was built to provide.

## Data flow (after the change)

```
/login  ──register──▶  POST /api/auth/register
                          │  validate password policy
                          │  HIBP breach screen (Epic E.4 — mandatory)
                          │  reject duplicate by emailHash
                          │  ┌─ transaction ────────────────────┐
                          │  │ tenant + wrapped DEK             │
                          │  │ user (passwordHash)              │
                          │  │ membership role=OWNER            │
                          │  │ onboarding row                   │
                          │  └──────────────────────────────────┘
                          │  audit entries (after commit)
                          │  issueEmailVerification → SMTP
                          └─▶ { emailVerificationRequired: true }
                                      │
                    ┌─────────────────┘
                    ▼
        "Check your inbox" panel + resend        (no auto sign-in)
                    │
   email click ─────┴──▶ GET /api/auth/verify-email?token=<raw>
                          │  sha256 → find → delete (single use)
                          │  user.emailVerified = now()
                          └─▶ /login?verifyStatus=verified
                                      │
                                      ▼
                          sign in → /tenants → own workspace as OWNER
```

## Error handling

| Failure | Behaviour |
|---|---|
| Weak / breached password | 400 with a specific message; no rows written |
| Duplicate email | 409; no rows written |
| Any write fails mid-registration | Whole transaction rolls back — no orphan tenant, no membership-less user; the email remains free to retry |
| SMTP down at registration | Registration still succeeds (`issueEmailVerification` swallows mailer errors). User sees the inbox panel and can resend. Delivery metric records the failure |
| Login before verifying | Distinct "confirm your email" message plus resend, not "invalid credentials" |
| Verification token expired / reused | Existing behaviour — `/login?verifyStatus=expired\|invalid` banners |

## Testing

- **Unit** — registration grants `OWNER`; a mid-flight failure leaves no orphan
  rows; `email_not_verified` surfaces distinctly while every other reason stays
  collapsed as `CredentialsSignin`.
- **Guardrails** — `no-auto-join` allowlist still covers the route (its entry
  is at `tests/guardrails/no-auto-join.test.ts:57`); HIBP coverage (Epic E.4)
  unchanged; i18n key parity and untranslated-copy checks.
- **E2E** — isolated-tenant signup → login blocked → verify link → login
  succeeds, landing in the new workspace as OWNER.

## Risks

- **Deliverability becomes load-bearing.** After F, a broken SMTP path means no
  new user can complete signup. Mitigated by: checking the delivery metric
  before flipping, the always-visible resend form, and the fact that the flag
  reverts instantly with no code change.
- **Rollback.** A–E are ordinary code changes on a branch. F is two env values;
  reverting either restores today's behaviour without a deploy of application
  code.
- **Not addressed here.** Existing prod users have `emailVerified = null`. This
  is harmless today because all five are OAuth-only and the gate is
  credentials-path-only. If a password is ever added to one of those accounts,
  that user would need to verify first.
