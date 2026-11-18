# 2026-11-18 — tenant SAML / OIDC SSO and SCIM turned off (dormant)

**Owner ruling:** sign-in is Google, Apple, Microsoft Entra ID and a password.
Tenant SAML / OIDC SSO and SCIM provisioning are switched off and kept
dormant. No code is deleted and no data is touched. Each can be turned back
on from the flag console.

## Design

Two runtime feature flags, both absent from production and therefore OFF:

| Flag | Gates |
|---|---|
| `auth.tenant-sso` | `/api/auth/sso/{oidc,saml}/{start,callback}`, `/api/sso`, `/api/t/{slug}/sso`, the `/admin/sso` screen and its hub tile |
| `auth.scim` | `/api/scim/v2/**` (via `authenticateScimRequest`), `ServiceProviderConfig`, `/api/t/{slug}/admin/scim`, the `/admin/scim` screen and its hub tile |

`src/lib/auth/tenant-sso-availability.ts` is the one place that reads them.
It resolves both with `userId: null`, because none of these requests carries
a user: SSO runs before sign-in, and SCIM authenticates with a bearer.

Entra (`/api/t/{slug}/sso/entra`, the `azure-ad` provider, group mappings,
role sync at sign-in) is behind neither flag.

## Files

| File | Role |
|---|---|
| `src/lib/auth/tenant-sso-availability.ts` | The flag keys and the `is*` / `assert*` helpers |
| `src/app/api/auth/sso/**/route.ts` | Start routes `assertTenantSsoEnabled()`; callbacks return 404 before reading the state cookie or the IdP response |
| `src/app/api/sso/route.ts`, `src/app/api/t/[tenantSlug]/sso/route.ts` | SAML / OIDC config API, 404 while off |
| `src/lib/scim/auth.ts` | SCIM choke point: refuses before the token lookup |
| `src/app/api/scim/v2/ServiceProviderConfig/route.ts` | The one SCIM route that does not authenticate, gated directly |
| `src/app/api/t/[tenantSlug]/admin/scim/route.ts` | Token management, 404 while off |
| `src/app/t/[tenantSlug]/(app)/admin/{sso,scim}/layout.tsx` | Server layouts answering `notFound()`; the pages are client components |
| `src/app/t/[tenantSlug]/(app)/admin/page.tsx` | Hub omits both tiles on the same flags |
| `src/lib/auth/password-management.ts` | First-password reset for accounts the turn-off stranded |
| `tests/e2e/feature-flag-fixtures.ts` | `enableFlags()` for specs that exercise the dormant UI |

## Decisions

- **Flags, not a code constant.** The owner chose flags so that either
  surface can come back without a deploy. A key absent from the table is
  off, so nothing had to be written to production for the turn-off to take
  effect.
- **The SCIM gate sits before the token check.** A dormant surface answers
  the same 404 to a valid token, a revoked one and none, so it never confirms
  that a token is still live.
- **The callbacks refuse before they read anything.** A callback URL
  replayed while SSO is off reaches neither the state cookie nor the IdP
  exchange.
- **SSO enforcement needed no change.** `isLocalLoginAllowed` and
  `checkSsoEnforcementForEmail` have no production callers. Measured: grep
  finds them only in their own module and in tests. So an `isEnforced`
  SAML / OIDC row cannot push anybody toward an SSO that no longer answers.
  Production was not measured, because no credentials were available from
  the session. The turn-off is built to be safe without that count.
- **Stranded accounts get a first-password reset, and only those.** People
  created by SSO JIT or by SCIM have no `passwordHash` and no `Account` row,
  so the turn-off left them with no way in. While `auth.tenant-sso` is off,
  `issuePasswordReset` treats them like a forgotten password. An account with
  any OAuth link (Google, Apple, Entra) stays a no-op. For Entra this matters:
  `enforceGroupGate` is checked only at an Entra sign-in, so a password would
  route around it. The exception closes automatically if tenant SSO is turned
  back on, because a password would then route around the farm's IdP.
- **SCIM off has an Entra cost.** SCIM was Entra's push channel for group
  lifecycle and deprovisioning. Roles are still synced at each Entra sign-in,
  but someone removed in Entra is no longer removed here automatically.
- **E2E covers both states.** The off state is asserted as production serves
  it. The SCIM Edge-reachability property is still observable because the 404
  comes from the handler, in the SCIM Error schema, and not from the Edge's
  `{"error":"Unauthorized"}`. The specs that exercise the dormant admin UI
  turn their flag on for their own duration, with `workers: 1` and a Redis
  cache bust, so turning a surface back on is not a step into untested code.
