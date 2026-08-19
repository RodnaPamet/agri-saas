# Admin, RBAC & SCIM — Operational Guide

## Admin Information Architecture

```
/t/[tenantSlug]/admin
├── Audit Log (default tab)
├── Policy Templates
├── Members & Roles    → /admin/members
├── Roles & Access     → /admin/rbac
├── Billing            → /admin/billing
├── SSO & Identity     → /admin/sso
├── SCIM Provisioning  → /admin/scim
└── Security & MFA     → /admin/security
```

All admin pages require `canAdmin` permission (ADMIN role on `TenantMembership`).

## Member Management

### Invite a Member
1. Navigate to **Members & Roles**
2. Enter email address and select role
3. Click **Send Invite**

### Change a Member's Role
1. Open **Members & Roles**
2. Click the role dropdown next to the member
3. Select the new role

**Safety**: The last ADMIN cannot demote themselves.

### Remove/Deactivate a Member
1. Open **Members & Roles**
2. Click the action menu → **Deactivate**
3. Member's status changes to DEACTIVATED

Deactivated members lose access. Their historical records (audit entries, task assignments, evidence reviews) remain intact.

## Roles

| Role | Permissions |
|------|------------|
| **ADMIN** | Full access: member management, settings, billing, SSO, SCIM |
| **EDITOR** | Create/edit resources (controls, risks, evidence, policies) |
| **AUDITOR** | Read-only + audit cycle management |
| **READER** | Read-only access to tenant resources |

## SSO Configuration

Navigate to **SSO & Identity** (`/admin/sso`).

### Supported Protocols
- **OIDC** — Okta, Azure AD, Google Workspace, Auth0
- **SAML 2.0** — Any SAML-compliant IdP

### Enforcement
- **Disabled**: SSO available but not required
- **Enabled**: SSO available for configured email domains
- **Enforced**: All non-admin users must use SSO (break-glass: admins with local password can bypass)

## SCIM 2.0 Provisioning

### Endpoints

| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/scim/v2/ServiceProviderConfig` | GET | SCIM capabilities — anonymous by spec (RFC 7644 §4) |
| `/api/scim/v2/Users` | GET, POST | List/create users |
| `/api/scim/v2/Users/:id` | GET, PATCH, PUT, DELETE | User CRUD |
| `/api/scim/v2/Groups` | GET, POST | List/create groups |
| `/api/scim/v2/Groups/:id` | GET, PUT, PATCH, DELETE | Group CRUD |

> **Reachability (2026-08-19).** Until this date **no SCIM request reached a
> handler on any deployment.** The Edge middleware called `getToken()`, which
> cannot decode an opaque SCIM bearer, and answered
> `401 {"error":"Unauthorized"}` before any route ran — so the "(public)" claim
> on the ServiceProviderConfig row above was false too. `/api/scim/` is now in
> `PUBLIC_PATH_PREFIXES`; the handlers authenticate themselves, held
> fail-closed by `tests/guards/scim-routes-self-authenticate.test.ts`.
>
> **If provisioning breaks, check the 401 BODY first.** A SCIM-schema error
> (`schemas: [...:2.0:Error]`) means the handler ran and rejected the token —
> look at `TenantScimToken`. A bare `{"error":"Unauthorized"}` means the Edge
> refused it and the carve-out has regressed.
>
> **These routes carry their own rate tier** (300/min per bearer, 600/min per
> IP). A 429 here is that tier; see `docs/rate-limiting.md`.
>
> **SCIM tokens do not expire.** `TenantScimToken` has no `expiresAt` and
> `authenticateScimRequest` checks only existence and `revokedAt`. While the
> Edge 401'd everything a leaked token was inert; now it is a permanent,
> tenant-wide provisioning credential until an admin revokes it. Rotate on a
> schedule and revoke promptly on IdP decommission.

### Setup
1. Navigate to **SCIM Provisioning** (`/admin/scim`)
2. Click **Generate Token** and copy the token (shown once only)
3. Configure your IdP's SCIM connector:
   - **Base URL**: The SCIM endpoint shown on the page
   - **Auth**: Bearer token (HTTP header)
   - **Operations**: Create, Update, Deactivate

### Token Rotation
1. Generate a new token
2. Update your IdP with the new token
3. Revoke the old token

### Role Mapping

| SCIM Role Value | Local Role | Status |
|----------------|------------|--------|
| `reader` | READER | ✅ Default |
| `editor` | EDITOR | ✅ Allowed |
| `auditor` | AUDITOR | ✅ Allowed |
| `admin` | — | ⛔ Blocked |

**ADMIN role cannot be assigned via SCIM.** It must be set manually by an existing admin.

### Deactivation Behavior
- SCIM `DELETE` or `PATCH active=false` → membership `DEACTIVATED`
- User loses tenant access immediately
- Historical records preserved (audit trail, task ownership, evidence)
- Re-provisioning the same user reactivates their membership

### Audit Events

All SCIM operations emit structured audit events:
- `SCIM_USER_CREATED`
- `SCIM_USER_UPDATED`
- `SCIM_USER_DEACTIVATED`
- `SCIM_USER_REACTIVATED`
