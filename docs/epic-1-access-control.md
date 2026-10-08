# Epic 1 — Access Control & Tenant Onboarding (operator + contributor index)

> Closes GAP-01 from the enterprise-readiness audit: OAuth sign-in
> no longer silently grants ADMIN on the oldest tenant. Tenant
> membership is now explicit (token redemption) and lifecycle-aware
> (OWNER role + last-OWNER guard). Read the source links for details;
> come back here for the architecture summary, verification
> commands, and rollback procedures.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  Layer 1 — Authentication (UNCHANGED)                                 │
│    NextAuth OAuth / credentials. Produces User row. No tenant.        │
│                                                                       │
│  Layer 2 — Tenant membership (NEW — explicit, opt-in)                 │
│    Only THREE creation modules exist:                                 │
│                                                                       │
│    a. tenant-invites.ts — TWO entry points, both requiring an         │
│       admin-created TenantInvite:                                     │
│         redeemInvite — token-bound, email-bound. Atomic claim via     │
│           updateMany with (acceptedAt IS NULL AND expiresAt > now()). │
│           Leaked token → burnt on email mismatch.                     │
│         redeemPendingInvitesByEmail — matches a pending invite to an  │
│           IdP-VERIFIED sign-in email, so the emailed link is          │
│           optional. OAuth-only (credentials email is self-asserted).  │
│           Same atomic claim. No invite ⇒ no membership.               │
│                                                                       │
│    b. createTenantWithOwner (tenant-lifecycle.ts)                     │
│         Platform-admin. Atomic: Tenant + DEK + OWNER membership +     │
│         TenantOnboarding + audit entries.                             │
│                                                                       │
│    c. /api/auth/register (credentials self-service signup)            │
│         Signing-up user creates their own tenant as ADMIN.            │
│         AUTH_TEST_MODE-gated today.                                   │
│                                                                       │
│    (Plus the legitimate SSO + SCIM provisioning paths — each          │
│     allowlisted in tests/guardrails/no-auto-join.test.ts.)            │
│                                                                       │
│  Layer 3 — Permission gate (UNCHANGED — Epic C.1)                     │
│    requirePermission('admin.members', ...) and friends.               │
│                                                                       │
│  Middleware gate (NEW)                                                │
│    /t/:slug/** + /api/t/:slug/** — the JWT's tenantSlug must match    │
│    the URL's slug. Mismatch → /no-tenant (web) or 403 (api). No       │
│    per-request DB hit.                                                │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

## Role model

```
OWNER   — tenant lifecycle + owner management (delete tenant, rotate
          DEK, transfer ownership, invite/remove OWNERs, assign OWNER
          role). Last ACTIVE OWNER of a tenant cannot be removed or
          demoted (DB trigger + usecase guard).

ADMIN   — operational control: invite/manage EDITOR/READER/AUDITOR,
          configure SSO/SCIM/billing/settings. Cannot touch OWNERs.
          Cannot assign OWNER role.

EDITOR  — create/edit all business entities.

AUDITOR — read-only everything + downloads + audit-pack share.
          For external auditors.

READER  — read-only business entities. Least privileged. Default for
          invites that omit a role.
```

**Permission keys added by Epic 1:**
- `admin.tenant_lifecycle` — delete tenant, rotate DEK, transfer ownership. OWNER-only.
- `admin.owner_management` — invite/remove OWNERs, assign OWNER role. OWNER-only.

Both explicitly `false` for ADMIN and below.

## Invitation flow

```
Admin clicks "Invite" in /admin/members
    → POST /api/t/:slug/admin/invites { email, role }
    → createInviteToken generates 256-bit base64url token
    → TenantInvite row: { email, role, token, expiresAt = +7d,
                           invitedById, acceptedAt:null, revokedAt:null }
    → Audit: MEMBER_INVITED

PATH 1 — the invitee just signs in (no link needed, the common case)
    → User completes OAuth with the invited address
    → jwt callback → redeemPendingInvites(emailVerifiedByIdp: true)
    → redeemPendingInvitesByEmail finds every pending invite for that
      verified address, claims each atomically, upserts membership.
      No pending invite → no-op. Audit MEMBER_INVITE_ACCEPTED.
    → User lands at /t/<slug>/dashboard on that same sign-in.

PATH 2 — the invitee opens the email and clicks /invite/<token>
    → preview page (tenant name, role, expiry) — NO consumption yet

Clicks "Sign in to accept"
    → GET /api/invites/<token>/start-signin
    → Sets inflect_invite_token cookie (HttpOnly, 10-min TTL)
    → 302 to /login

User completes OAuth
    → NextAuth jwt callback (NOT signIn — see below)
    → redeemPendingInvites reads cookie
    → redeemInvite runs in two steps:
         Step 1 (standalone commit): atomic claim —
           UPDATE TenantInvite SET acceptedAt = now()
           WHERE token = X AND acceptedAt IS NULL AND revokedAt IS NULL
             AND expiresAt > now()
           Count 0? → fetch to produce 404/410 error.
           Count 1? → invite is now claimed.
         Step 2 (email binding check): if invite.email != session.email →
           throw forbidden. Invite IS BURNT (acceptedAt is committed,
           Step 1 did not get rolled back because it was a separate
           transaction).
         Step 3 ($transaction): upsert TenantMembership + read tenant
           slug. Audit MEMBER_INVITE_ACCEPTED.
    → User lands at /t/<slug>/dashboard with valid membership.

Uninvited OAuth user
    → signIn callback: no cookie, no invite redemption.
    → JWT minted with tenantId = null.
    → Middleware redirects all /t/** requests to /no-tenant.
```

## Last-OWNER protection

Two layers, both load-bearing:

1. **Usecase layer** (`tenant-admin.ts::updateTenantMemberRole` and
   `deactivateTenantMember`): counts ACTIVE OWNERs, throws
   `forbidden('Cannot demote/deactivate the last OWNER...')` with a
   friendly error message before the mutation lands.

2. **DB trigger** (`check_not_last_owner` function + BEFORE UPDATE/DELETE
   trigger on `TenantMembership`): raises
   `LAST_OWNER_GUARD: tenant % would have zero active OWNERs` with
   SQLSTATE P0001. Catches bypass attempts — raw `deleteMany`, code
   paths that skip the usecase, future bugs that forget the check.
   Defence-in-depth.

The two-step "transfer ownership" flow uses this to advantage:
promote the new OWNER FIRST (brings count to 2), then demote the old
OWNER (count drops to 1, but trigger is satisfied because count ≥ 1).

## Verification commands

### Invitation flow
```bash
SKIP_ENV_VALIDATION=1 npx jest \
    tests/integration/invite-redemption.test.ts \
    tests/integration/invite-routes.test.ts \
    --no-coverage
```
10 redemption cases + 5 HTTP-contract cases.

### Last-OWNER protection
```bash
SKIP_ENV_VALIDATION=1 npx jest \
    tests/integration/last-owner-guard.test.ts \
    tests/integration/last-owner-usecase-guard.test.ts \
    --no-coverage
```
DB-trigger tests + usecase-layer tests.

### Middleware tenant-access gate
```bash
SKIP_ENV_VALIDATION=1 npx jest \
    tests/integration/middleware-tenant-gate.test.ts \
    --no-coverage
```
Pure-function tests against `checkTenantAccess`.

### Vulnerability closure (PR 4)
```bash
SKIP_ENV_VALIDATION=1 npx jest \
    tests/integration/auth-signin-no-auto-join.test.ts \
    --no-coverage
```
Simulates the signIn callback — asserts no membership created without
a valid invite token.

### Guardrails (PR 5 — anti-regression)
```bash
SKIP_ENV_VALIDATION=1 npx jest \
    tests/guardrails/no-auto-join.test.ts \
    tests/guardrails/role-zod-enums.test.ts \
    --no-coverage
```

### Platform-admin tenant creation
```bash
SKIP_ENV_VALIDATION=1 npx jest \
    tests/integration/tenant-lifecycle.test.ts \
    tests/integration/platform-admin-tenant-creation.test.ts \
    --no-coverage
```

## Rollback procedures

### PR 4 rollback — restoring auto-ADMIN (DO NOT do this in prod)
Revert `src/auth.ts` signIn callback changes + remove the middleware
tenant-access gate. The vulnerability is reintroduced. The tree stays
type-safe but the guardrail `no-auto-join.test.ts` would STILL pass
(function name check only), so this regression is NOT automatically
caught — you'd need to also remove the assertion that
`ensureDefaultTenantMembership` is absent. Don't.

### PR 3 rollback — removing token-redemption
Revert `tenant-invites.ts` + the `/admin/members` POST change. The
old `inviteTenantMember` behaviour reappears. Invitations are silently
created as ACTIVE memberships for existing users — a milder version
of GAP-01. Don't.

### PR 2 rollback — dropping OWNER bootstrap
- Trigger: `DROP TRIGGER tenant_membership_last_owner_guard ON "TenantMembership"; DROP FUNCTION check_not_last_owner();`
- Bootstrap: `UPDATE "TenantMembership" SET role='ADMIN' WHERE role='OWNER' AND <audit marker matches>;`
  Audit log retains the `ROLE_PROMOTED_TO_OWNER` entries so the change
  is traceable.
- Platform-admin routes + `PLATFORM_ADMIN_API_KEY` env: remove both.
  Return 404 on the routes.

### PR 1 rollback — dropping OWNER enum value
Postgres does not support dropping an enum value without recreating
the type. Leave the enum value; no rows use it after PR 2's inverse
migration.

## Accepted residual risks (documented decisions)

The Epic 1 security validation enumerated 8 residual risks (R-1
through R-8). Five are closed by code (R-1 via JWT memberships array
+ tenant picker; R-3 email_verified check; R-4 platform-key rotation;
R-5 E2E spec; R-6 production Redis-required startup check). Three
are accepted with the following written rationale:

**R-2 — Invite cookie carries the token unencrypted.** The cookie is
`HttpOnly`, `SameSite=Lax`, `Secure` in production, with a 10-minute
TTL and single-use semantics. TLS protects in transit. Encrypting
the cookie value with a server-side secret would not change the
threat model — an on-path attacker who has broken TLS already has
much bigger problems. Accepted as-is. Tightening would add
complexity without security gain.

**R-7 — Bootstrap script must run once in production.**
`scripts/bootstrap-tenant-owners.ts` promotes the oldest ACTIVE
ADMIN per tenant to OWNER. It's idempotent (re-running is a no-op
on tenants that already have an OWNER) and emits an audit-chained
`ROLE_PROMOTED_TO_OWNER` entry per promotion. **Operator action:**
run `npm run db:bootstrap-owners` against prod once after deploying
PRs 1–2. Not a code closure — operational checklist item only.

**R-8 — CSRF-style invite acceptance is benign.** A malicious site
that links to `/api/invites/<attacker-token>/start-signin` could
trick an authenticated user into accepting an invite addressed to
their own email. Worst case: the user gets added to a tenant they
didn't request. They can leave via deactivate. The attack does NOT
escalate privileges, leak data, or compromise other tenants. Adding
a CSRF token tied to the preview page would close R-8 mechanically
but at the cost of breaking the preview-then-sign-in flow (the
token would be tied to the preview-page session, which the
post-OAuth session no longer has). Accepted as-is.

## Adding a new tenant-membership creation path (for future contributors)

The `tests/guardrails/no-auto-join.test.ts` guardrail enforces that
`tenantMembership.create` / `upsert` / `createMany` appears ONLY in
allowlisted files. If you're adding a legitimate new path:

1. Land the code with a clear audit trail (call `appendAuditEntry`
   or `logEvent` with a distinct action name like
   `TENANT_MEMBERSHIP_GRANTED_VIA_<mechanism>`).
2. Add the file to `ALLOWLISTED_MEMBERSHIP_SITES` in the guardrail
   with a one-line `reason` describing the security posture:
   - What authz gates this path? (Permission? API key? Token?)
   - What is the "source of truth" for the role assignment?
   - Is email binding enforced?
3. Run the guardrail to confirm.

## Adding a new legitimate OWNER-aware route

If your route's Zod schema parses a `Role` value and OWNER is a valid
input, add the file path to `MEMBER_MGMT_FILES` in
`tests/guardrails/role-zod-enums.test.ts`. If OWNER should be
intentionally rejected (e.g. custom-role baseRole, SCIM), add it to
`OWNER_EXEMPT_FILES` with a reason.

## Canonical references

- `src/app-layer/usecases/tenant-invites.ts` — invite lifecycle
- `src/app-layer/usecases/tenant-lifecycle.ts` — tenant creation + ownership transfer
- `src/auth.ts` — signIn callback (no auto-join path)
- `src/middleware.ts` + `src/lib/auth/guard.ts::checkTenantAccess` — middleware gate
- `src/lib/permissions.ts::getPermissionsForRole` — OWNER/ADMIN permission derivation
- `prisma/migrations/<ts>_epic1_add_owner_role/migration.sql` — enum value
- `prisma/migrations/<ts>_epic1_last_owner_trigger/migration.sql` — DB trigger
- `scripts/bootstrap-tenant-owners.ts` — one-time OWNER bootstrap for existing tenants


---

## Access Control & Tenant Onboarding (Epic 1) — the reasoning

Relocated from CLAUDE.md (#1334). **Read this before adding a membership-creation path, touching the tenant-access gate, or changing invite redemption.** It carries why redemption runs in the `jwt` callback and not `signIn` (the adapter has not created the User row yet, so redeeming there wrote a membership against a non-existent FK), why the gate reads `memberships[]` rather than the single `tenantSlug` claim, and why MECHANISATOR needs an explicit arm in every `switch` on `Role`.

Closes the audit's GAP-01 (Critical): OAuth sign-in no longer
silently grants ADMIN on the oldest tenant. Authentication and
tenant membership are now orthogonal — sign-in alone authenticates
the user; tenant access requires an explicit grant via one of the
allowlisted paths.

**Role model.** The `Role` enum has SIX values:
`OWNER | ADMIN | EDITOR | READER | AUDITOR | MECHANISATOR`. OWNER is
strictly superior to ADMIN — it gains `admin.tenant_lifecycle` (delete
tenant, rotate DEK, transfer ownership) and `admin.owner_management`
(invite/remove OWNERs, assign OWNER role). ADMIN has every other
admin flag but explicitly denies those two. The `PermissionSet`
resolution in `src/lib/permissions.ts` enforces the distinction at
compile time; `getPermissionsForRole('ADMIN').admin.tenant_lifecycle`
is `false` by type.

MECHANISATOR (#277) is the restricted machine-operator / sprayer
persona, and it is the odd one out in three places, each load-bearing.
**Its explicit arm in `getPermissionsForRole` is what keeps it
restricted**: that switch ends `case 'READER': default:`, so a
MECHANISATOR without its own arm does not fail — it silently inherits
the READER "view everything" default. The arm returns every domain
`false` except `tasks.view` + `tasks.edit`, on only so the completion
affordances render. Those permissions are defence-in-depth; the
LOAD-BEARING confinement is the middleware lockdown in
`src/middleware.ts`, which redirects any tenant path outside
`isOperatorAllowedPath` (`src/lib/auth/guard.ts`) to `/t/{slug}/my-work`
and returns 403 `operator_scope` on API routes. And it is never an
SSO-mappable target — excluded from `ENTRA_MAPPABLE_ROLES` in
`src/app-layer/schemas/entra-group-mapping.schemas.ts`, so only a tenant
admin can assign it.

**Membership creation is explicit.** Only SEVEN modules can write a
`TenantMembership` row today — the three detailed below (the first of
them via two entry points), plus SSO, SCIM, the non-production staging
seed route, and the two Epic O-2 org paths:
(a) `src/app-layer/usecases/tenant-invites.ts`, which has TWO entry
points, both requiring an admin-created `TenantInvite`:
`redeemInvite` is token-bound and email-bound, atomically consumed
via an `updateMany` with `acceptedAt IS NULL AND expiresAt > now()`
predicate (a leaked token is burnt on email mismatch); and
`redeemPendingInvitesByEmail` matches a pending invite against an
**IdP-verified** sign-in email, which is what makes the emailed link
optional. The second is **OAuth-only** — `src/auth.ts` passes
`emailVerifiedByIdp: account.provider !== 'credentials'`, because the
credentials provider's email is self-asserted and honouring an invite
there would hand a tenant to whoever guessed an invited address. It is
still not auto-join: no invite ⇒ no membership. Both share
`finalizeInviteRedemption`.
(b) `createTenantWithOwner` in `src/app-layer/usecases/tenant-lifecycle.ts` —
platform-admin tenant bootstrap, gated by `PLATFORM_ADMIN_API_KEY`
(constant-time compared via `verifyPlatformApiKey`).
(c) `/api/auth/register/start` + `/verify` — credentials self-service
signup, P3.5b's two-step form. Step 1 creates an UNVERIFIED user and
records terms acceptance; step 2 proves the address and signs in; the
farm is created afterwards by `POST /api/me/farms` (P3.6), which is the
site that writes the membership. **`/api/auth/register` — the
single-call route that created a user AND a tenant together — was
RETIRED on 2026-10-07 (#1376)**, because it recorded no terms
acceptance and was the weaker of two signup doors. Do not recreate it;
`src/generated/route-inventory.json` holds the retirement reason, and
`tests/integration/tenant-creation-atomicity.test.ts` is where its
real-DB rollback proof now lives, retargeted onto
`createTenantWithOwner`.
The `Credentials()` provider is still registered unconditionally in
`src/auth.ts`; what hides the sign-in form in production is
`AUTH_CREDENTIALS_UI_HIDDEN`, a request-time flag served by
`src/app/api/auth/ui-config/route.ts`. That same route now also serves
`registrationOpen`, because the login page is a client component and
cannot resolve `social.farm-registration` itself — it links to
`/start` only when the wizard is open, for the reason the landing page
does (`/start` 404s when the flag is off).
**Terms acceptance has TWO capture points, and the second exists because
the first cannot cover every door.** `register/start` records it inline.
A first-time Google sign-in creates its `User` row through
`PrismaAdapter` inside NextAuth, so it passes no route of ours (#1376) —
and stamping consent on that callback would file an agreement nobody
gave, which is worse than the null the column honestly holds. So a
signed-in session whose `acceptedTermsAt` is null is HELD at
`/accept-terms` by the Edge, and `POST /api/auth/accept-terms` is the
way out (idempotent, and it does not re-stamp: the timestamp is the
artifact).
That gate runs AFTER the MFA gate — MFA is a security control, consent
is a compliance record — and `isTermsAllowedPath` exempts the MFA paths
too, so the two cannot deadlock if the order is ever changed. It tests
`termsPending === true`, so a token minted before this shipped reads as
not-pending and nobody is locked out mid-session; the claim resolves
from the column on the next re-mint. The lookup FAILS CLOSED, which is
the opposite trade from `mfaFailClosed`: being asked twice is harmless,
granting access with no record is the thing this prevents.
**The consent control is ONE component** —
`components/auth/TermsConsentCheckbox` — rendered by both the wizard and
the interstitial, with its copy under a single `common` key. It was
duplicated with byte-identical text under two keys, which is the shape
where one gets edited and the other quietly keeps saying something else
while the stored version string claims both users agreed to the same
document.
Plus five provisioning paths that never involve an invite: SSO
(`usecases/sso.ts`), SCIM (`usecases/scim-users.ts`), the staging seed
route (`app/api/staging/seed/route.ts` — 403s outright when
`NODE_ENV === 'production'`), and the two Epic O-2 org paths.
`usecases/org-tenants.ts` writes the OWNER row for the ORG_ADMIN
creating a tenant under an org; `usecases/org-provisioning.ts` is the
one CROSS-TENANT writer — it fans `AUDITOR` rows (`createMany`, with
`provisionedByOrgId` stamped so deprovisioning can tell auto-created
rows from granted ones) into every tenant under the org, and it is the
easiest of the seven to forget. Seven files in total; every one is
allowlisted in `tests/guardrails/no-auto-join.test.ts` with a one-line
reason, and ANY site not on that list fails CI.

**Middleware tenant-access gate.** `/t/:slug/**` and
`/api/t/:slug/**` require the URL's slug to appear in the JWT's
`memberships[]` list — NOT the single `tenantSlug` claim, which
`src/auth.ts` keeps only as the "primary" (oldest) membership for
backward compatibility and which would deny a legitimate member of a
second tenant. An empty list → `no_tenant_access`; a slug absent from a
COMPLETE list → `cross_tenant`. Both redirect to `/no-tenant` on web; on
the API they return 403 `{ error: 'no_tenant_access' }` and 403
`{ error: 'cross_tenant_access_denied' }` respectively. If the list was
capped at sign-in (`membershipsTruncated`) a slug-miss is not
definitive — the slug may be a membership that did not fit — so the gate
allows and lets the authoritative DB-backed server check (`TenantLayout`
/ `getTenantCtx`) decide. Uses the JWT claim only — no per-request DB
hit. Carve-outs
for `/invite/<token>`, `/api/invites/**`, and `/no-tenant` itself.
Logic lives in `src/lib/auth/guard.ts::checkTenantAccess`.

**Last-OWNER protection — two layers.** Usecase layer
(`updateTenantMemberRole`, `deactivateTenantMember`) counts ACTIVE
OWNERs and throws `forbidden('Cannot demote/deactivate the last
OWNER...')`. DB trigger `tenant_membership_last_owner_guard` is the
backstop — raises SQLSTATE P0001 on any UPDATE or DELETE that would
leave a tenant with zero ACTIVE OWNERs, catching bypass attempts
(raw `deleteMany`, code paths that forget the check). The two-step
`transferTenantOwnership` flow uses this: promote the new OWNER
first (count=2), then demote the old (count=1, trigger satisfied).

**Invitation flow — the link is OPTIONAL.** Admin POSTs to
`/api/t/:slug/admin/invites` → `createInviteToken` creates a 256-bit
base64url token with 7-day expiry. There are then two ways in, and
neither is privileged over the other:

  1. **Just sign in.** An OAuth sign-in whose IdP-verified email
     matches a pending invite provisions the membership on the spot
     (`redeemPendingInvitesByEmail`). This is the path most invitees
     actually take — email delivery is unreliable, and a user who
     clicks "Sign in with Microsoft" should not be stranded on
     `/no-tenant` because an SMTP relay dropped a message.
  2. **Follow the link.** User clicks `/invite/<token>` → preview page
     → "Sign in to accept" sets a 10-min HttpOnly cookie and redirects
     to `/login`.

Both are claimed atomically against the same row, so a link-click
racing a login cannot double-redeem; the loser skips.
After OAuth, redemption runs in the **`jwt` callback** (NOT `signIn`)
via `redeemPendingInvites` in `src/lib/auth/invite-redemption.ts`,
which reads the cookie and resolves the persisted `User.id` **by
email** before calling `redeemInvite`. This is load-bearing: in the
`signIn` callback a first-time OAuth user's `user.id` is the
identity-provider subject, not our `User.id` (the Prisma adapter
creates the row only after `signIn` returns), so redeeming there wrote
a membership against a non-existent `User` FK and stranded the invitee
on `/no-tenant`. The `jwt` callback fires after the row exists.
Step 1 (atomic claim) commits standalone so Step 2 (email binding) can
burn the invite on mismatch without rolling back the claim — leaked
tokens are unusable on first failed attempt.

**See `docs/epic-1-access-control.md`** for the Epic 1 operator
runbook (verification commands, rollback procedures, how to add a
new tenant-membership creation path).
