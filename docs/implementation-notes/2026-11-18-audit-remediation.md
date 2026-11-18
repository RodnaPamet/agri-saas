# 2026-11-18 — Audit remediation, first batch

The 2026-11-18 code audit filed #3177–#3217. This batch fixes the account-takeover
chain and the other findings with a direct exploit or data-loss path. Each fix is
its own commit, with `Refs #N`; this note records the decisions that are not
obvious from the diffs.

## Design

| Finding | Fix |
|---|---|
| #3196 / #3197 SSO + SCIM account takeover | A tenant's IdP may only authenticate a person whose access is **wholly inside** that tenant: an ACTIVE membership there, no ACTIVE membership elsewhere, no org membership. Checked on every SSO sign-in. SCIM create answers 409 `uniqueness` for an existing account instead of attaching it; PATCH/PUT cannot reach a REMOVED member and cannot rename a person who belongs to other farms. |
| #3198 / #3199 MFA gaps | `getLegacyCtx` asserts the second factor exactly as `getTenantCtx` does; `getOrgCtx` refuses a session owing a factor to any farm; `POST /api/auth/token` refuses a pending session (403 `mfa_required`). |
| #3200 revocation | The `session` callback carries `token.error`; `auth()` treats a flagged cookie session as no session. |
| #3201 owner strip | `assignCustomRole` refuses a custom role on an OWNER membership (403 `CUSTOM_ROLE_ON_OWNER`). |
| #3202 DM block | `assertMayWriteToConversation` (participant + both-direction block) gates photo send, edit and reactions. |
| #3177 sweep | The unverified-account sweep deletes abandoned **password** sign-ups only. |
| #3203 SSRF | Automation webhooks and the audit stream post through `fetchPublicUrl` with `maxRedirects: 0`. |
| #3216 CSV | The rent-roll CSV uses the shared `escapeCSV` for text cells. |

## Files

| File | Role |
|---|---|
| `src/lib/auth/tenant-reach.ts` | `reachesBeyondTenant` — the one definition of "wholly governed by this tenant", shared by SSO and SCIM |
| `src/app-layer/usecases/sso.ts` | `ssoAuthenticationBlocker`, called on both link paths |
| `src/app-layer/usecases/scim-users.ts` | create refuses existing accounts; REMOVED excluded; renames gated |
| `src/app/api/auth/sso/{oidc,saml}/callback/route.ts` | ACTIVE membership required |
| `src/app-layer/context.ts` | factor checks in `getLegacyCtx` / `getOrgCtx` |
| `src/app/api/auth/token/route.ts` | pending-session refusal |
| `src/auth.ts` | `Session.error`; `auth()` refuses a flagged cookie |
| `src/app-layer/usecases/custom-roles.ts` | OWNER boundary |
| `src/app-layer/usecases/direct-messages.ts`, `direct-message-photos.ts` | shared block check |
| `src/app-layer/jobs/unverified-account-sweep.ts` | positive predicate |
| `src/app-layer/automation/action-executor.ts`, `src/app-layer/events/audit-stream.ts` | per-hop SSRF policy |
| `src/app/api/t/[tenantSlug]/reports/rent-roll/route.ts` | shared CSV escaping |

## Decisions

- **SSO: refuse by reach, not scope the session.** Scoping the minted session to
  the IdP's tenant was the alternative. It was rejected because a scoped session
  still hands the IdP's owner the person's PERSON-level data — direct messages,
  the account export, account deletion — which no tenant's IdP has a claim to.
  The cost: a person in this farm AND another can no longer use this farm's SSO.
  Under `isEnforced` that person's own sign-in method is refused for this
  tenant's members, so they need the break-glass route or must leave one farm.
- **SCIM: reversed a deliberate regression test.** `scim-users.test.ts` pinned
  "attaches an existing user (e.g. a consultant) into a new tenant". That case
  now asserts the refusal, with the reason in the test. Joining a second farm is
  an invite the person accepts.
- **The empty-`emailDomains`-means-any rule is unchanged.** With the reach rule in
  place an empty list can no longer reach another farm's member, and changing its
  meaning would break every existing provider configured without one.
- **`auth()` falls through to the bearer path on a flagged cookie** rather than
  returning null, so a request that also carries a live native credential is
  judged on that.
- **Per-farm MFA for bearer sessions (the second half of #3199) is not here.**
  Resolving the requirement from the database for a bearer changes when a native
  user is asked for a code on a non-primary farm, and that wants its own change.
- **The sweep's predicate is positive** (password set, no OAuth account, no SSO
  identity, no lifecycle column) rather than a list of exclusions, so a new kind
  of account is spared by default.
- **CSV numbers are not neutralised**: the shared escaper would turn a negative
  `outstanding` (an overpayment) into text, and a number cannot carry a formula.

## Second batch

| Finding | Fix |
|---|---|
| #3183 seat limit | `assertWithinLimit(…, 'user', tx)` runs where a seat is TAKEN — invite redemption, SCIM create, SSO JIT — inside the transaction that writes the membership. Redemption skips it for an already-ACTIVE member. |
| #3178 slow mode for OAuth users | An IdP sign-in (OAuth, SSO link, SSO JIT) stamps `User.emailVerified` when NULL; a migration backfills accounts holding an `Account` row or SSO link. |
| #3189 action pins | Third-party actions pinned by SHA (guard derives the population); `load-test.yml` gets `contents: read`. |
| #3191 deploy inputs | `deploy/lib/compose-repo-inputs.sh` derives the build-context files and `./deploy/…` mounts both scripts ship and hash. |
| #3192 verify-chain Q2 | Probe written beside the `:ro` mount; an unwritable probe is a failure. |

### Decisions

- **The tenant-only entitlement scope requires a transaction.** Provisioning
  paths have no request principal to bind `runInTenantContext` to, so
  `assertWithinLimit` / `getEffectivePlan` gained an overload taking
  `{ tenantId }` plus a REQUIRED `tx`, enforced at compile time by the
  overloads and at runtime by `runIn`. A second pool connection inside the
  provisioning transaction would also be #1191's deadlock shape.
- **A returning REMOVED member counts as a new seat**; only an ACTIVE row is
  "already holding one".
- **SSO counts as IdP verification.** The tenant's IdP asserts the address,
  constrained by the reach rule from the first batch; the column only drives
  slow mode and register/start's "already registered" mail, so the cost of
  trusting it is low and the cost of not trusting it is a permanent 15/min.
- **The backfill stamps `NOW()`, not `createdAt`** — the first confirmation was
  never recorded and the migration does not invent one; slow mode's age half
  reads `createdAt`, so no verdict depends on the choice.
- **VM image pins (`watchtower:latest`, `pgbouncer:latest`) are deferred**: the
  right pin is whatever the VM runs today, which needs a measurement on the VM
  this session could not make. Pinning a guessed version would be a silent
  upgrade or downgrade riding a hardening change.
  *Done later the same day:* measured on the VM over an IAP tunnel and pinned
  to the running digests (pgbouncer `sha256:4c1ca296…`, watchtower
  `sha256:6dd50763…`), so the pin changed no running bytes.
- **The deploy helper keeps `./Caddyfile` out by construction** (only
  `./deploy/…` paths are inputs), which is the one exclusion that matters: the
  live file serves a co-tenant.
