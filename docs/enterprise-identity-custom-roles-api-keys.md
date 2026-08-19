# Enterprise Identity: Custom Roles & API Keys

> Epic 21 — Tenant-scoped RBAC customization and machine-to-machine authentication.

## Architecture Overview

```
                    ┌──────────────────────────────┐
                    │       Request Arrives         │
                    └──────────────┬───────────────┘
                                   │
                          Authorization: Bearer ...?
                                   │
                    ┌──────── iflk_ prefix? ────────┐
                    │                                │
                    ▼                                ▼
            API Key Auth                      Session Auth
            ┌────────────┐                  ┌──────────────┐
            │ Hash lookup │                 │ NextAuth JWT  │
            │ Expiry chk  │                 │ + Membership  │
            │ Revoke chk  │                 │   resolution  │
            │ Scope map   │                 │ + Custom role  │
            └─────┬──────┘                  │   resolution  │
                  │                         └──────┬───────┘
                  │                                │
                  ▼                                ▼
            ┌──────────────────────────────────────────┐
            │            RequestContext                 │
            │  userId, tenantId, role, appPermissions  │
            │  apiKeyId?, apiKeyScopes?                │
            └──────────────────────────────────────────┘
```

## Custom Roles

### Model

| Field | Type | Purpose |
|-------|------|---------|
| `id` | CUID | Primary key |
| `tenantId` | FK → Tenant | Tenant isolation |
| `name` | String | Human-readable label |
| `description` | String? | Optional description |
| `baseRole` | Role enum | Fallback role for base permissions |
| `permissionsJson` | Json | Full `PermissionSet` blob |
| `isActive` | Boolean | Soft-delete flag |

### Permission Resolution

```
If membership.customRoleId is set AND customRole.isActive:
  → parsePermissionsJson(customRole.permissionsJson, customRole.baseRole)
Else:
  → getPermissionsForRole(membership.role)
```

**Fallback guarantee**: `parsePermissionsJson` falls back to `baseRole` defaults
for any missing or malformed fields in the stored JSON. This means a partially
corrupted `permissionsJson` never produces a `null` or empty permission set.

### PermissionSet Shape

```typescript
type PermissionSet = {
    controls:   { view, create, edit }
    evidence:   { view, upload, edit, download }
    policies:   { view, create, edit, approve }
    tasks:      { view, create, edit, assign }
    risks:      { view, create, edit }
    vendors:    { view, create, edit }
    tests:      { view, create, execute }
    frameworks: { view, install }
    audits:     { view, manage, freeze, share }
    reports:    { view, export }
    admin:      { view, manage, members, sso, scim }
}
```

All fields are `boolean`. Validated on write by `validatePermissionsJson()`.

### Backward Compatibility

- The existing `Role` enum (`ADMIN`, `EDITOR`, `AUDITOR`, `READER`) is unchanged.
- `TenantMembership.role` remains the default/fallback field.
- `TenantMembership.customRoleId` is **nullable** — `null` = use enum role.
- Existing memberships without a custom role behave exactly as before.
- Deleting a custom role sets `customRoleId = null` on all affected memberships
  (via `SetNull` referential action), restoring enum role behavior.

### Admin Management

- **Page**: `/admin/roles`
- **Operations**: Create, edit (name/description/permissions), soft-delete
- **UI**: Checkbox-based permission grid editor — prevents malformed JSON
- **Presets**: "Load from ADMIN/EDITOR/AUDITOR/READER" to start from known-good sets

---

## API Keys

> **STATUS (2026-08-19): API-key authentication is DISABLED, and it never
> worked.** A key issued here **cannot authenticate a request** and never
> could. The Edge middleware calls `getToken()`, which runs an
> `Authorization: Bearer` value through NextAuth's JWE decode; an `iflk_`
> token is not a JWE, so decode throws, `getToken` returns `null`, and the
> request is refused with a generic 401 **before any handler runs** — and
> therefore before `verifyApiKey` is ever reached. Confirmed over real HTTP:
>
> ```
> $ curl -H 'Authorization: Bearer iflk_…' /api/t/<slug>/journal
> 401 {"error":"Unauthorized"}
> ```
>
> Creation is closed (`POST` returns **410 Gone** with a diagnostic body) and
> the admin page hides the create button. **Listing and revoking existing keys
> still works** and the page stays reachable for exactly that reason.
>
> Everything below describes the design as built. It is accurate about the
> model, hashing and scopes, and **not** about the request path — that section
> is marked where it applies. See `src/lib/auth/api-key-availability.ts` for
> what re-enabling requires (an Edge carve-out, scope enforcement — which has
> zero callers today — a rate tier, and an HTTP-level test through the
> middleware). `tests/guards/api-key-auth-disabled.test.ts` fails if the switch
> is flipped without them.

### Model

| Field | Type | Purpose |
|-------|------|---------|
| `id` | CUID | Primary key |
| `tenantId` | FK → Tenant | Tenant isolation |
| `name` | String | Human-readable label (e.g. "CI/CD Pipeline") |
| `keyPrefix` | String | First 13 chars for identification (e.g. `iflk_a1b2c3d4`) |
| `keyHash` | String | SHA-256 hex digest — **never stores plaintext** |
| `scopes` | Json | Array of scope strings |
| `expiresAt` | DateTime? | Optional expiry — `null` = no expiry |
| `revokedAt` | DateTime? | Non-null = permanently revoked |
| `lastUsedAt` | DateTime? | Updated on each successful auth |
| `lastUsedIp` | String? | Client IP of last auth |
| `createdById` | FK → User | Audit trail — who created the key |

### Key Lifecycle

```
1. Admin creates key via UI
   → generateApiKey() produces plaintext + SHA-256 hash
   → Hash stored in DB, plaintext returned ONCE to the UI
   → UI shows plaintext in a copy-once warning box

2. Machine uses key
   → Authorization: Bearer iflk_...
   → verifyApiKey() hashes the token, looks up by keyHash
   → Checks revokedAt, expiresAt
   → Builds RequestContext with scopes

3. Admin revokes key
   → Sets revokedAt = now()
   → All future auth attempts fail immediately
```

### Key Format

```
iflk_ + 48 hex chars = 53 chars total
       └─ 24 bytes of crypto.randomBytes = 192 bits of entropy
```

**Why SHA-256 (not bcrypt)?** API keys have 192 bits of entropy — far above
the brute-force threshold. SHA-256 is deterministic (needed for DB lookup)
and fast. bcrypt/argon2 are designed for low-entropy passwords.

### Scope Model

Scopes use the format `resource:action`:

| Scope | Effect |
|-------|--------|
| `*` | Full access (all resources, all actions) |
| `controls:*` | All actions on controls |
| `controls:read` | controls.view |
| `controls:write` | controls.create, controls.edit |
| `evidence:read` | evidence.view, evidence.download |
| `evidence:write` | evidence.upload, evidence.edit |
| `policies:admin` | policies.approve |
| `admin:write` | admin.manage, admin.members, admin.sso, admin.scim |

### Scope Enforcement

```
> **Not currently reachable** — see the status note above; the Edge refuses an
> `iflk_` bearer before this decision point.

Request authenticated via API key?
  ├─ Yes → enforceApiKeyScope(ctx, resource, action)
  │        └─ Checks ctx.apiKeyScopes against requested resource:action
  │        └─ Throws 403 if scope not granted
  └─ No  → Normal user permission checks (no scope enforcement)
```

**Key principle**: API key scopes are *in addition to* the PermissionSet check.
The RequestContext's `appPermissions` is derived from scopes, so both checks
align. `enforceApiKeyScope` provides a clear, auditable enforcement point.

### Admin Management

- **Page**: `/admin/api-keys`
- **Operations**: Create, list, revoke (no edit — immutable after creation)
- **Copy-once**: Plaintext key shown in amber warning box with show/hide toggle
- **Scope picker**: Visual checkbox grid grouped by resource
- **Expiry presets**: 30d, 90d, 180d, 1y, or no expiry

---

## Auth Coexistence

| Aspect | Session Auth | API Key Auth |
|--------|-------------|-------------|
| **Token** | JWT cookie (NextAuth) | `iflk_...` bearer token |
| **Identity source** | User → TenantMembership | TenantApiKey.createdById |
| **Permission source** | Custom role or enum role | Scopes → PermissionSet |
| **MFA** | Enforced per tenant policy | Not applicable (M2M) |
| **Revocation** | sessionVersion increment | revokedAt timestamp |
| **Tenant isolation** | Membership FK | TenantApiKey.tenantId FK |
| **Detection** | `ctx.apiKeyId === undefined` | `ctx.apiKeyId !== undefined` |

**No leakage**: API key auth constructs an entirely fresh `RequestContext`
from the key's stored data. It never touches session/JWT state or membership
tables, preventing any cross-path permission inheritance.

---

## Rollout Notes

### Migration Safety

1. **TenantCustomRole**: Zero-downtime. No existing tables modified.
   New nullable FK on TenantMembership with `SetNull` referential action.
2. **TenantApiKey**: Zero-downtime. New table only. No existing tables modified.
3. Both migrations are additive — safe to deploy without a maintenance window.

### Feature Activation

- Custom roles are opt-in. Tenants that don't create custom roles see
  zero behavioral changes. The enum role path is the default.
- API keys are opt-in. No keys exist until an admin creates one.
  The auth middleware only triggers when it detects the `iflk_` prefix.

### Caveats

- **API key scopes are coarse-grained**: `resource:read` / `resource:write`.
  Future work could add `resource:action:id` for record-level scoping.
- **API keys do not support MFA**: Machine credentials are inherently
  non-interactive. Key expiry and revocation are the primary security controls.
- **Custom role permissions are additive over the base role's defaults**:
  The admin UI allows setting any permission, but `parsePermissionsJson`
  falls back to `baseRole` defaults for missing fields.
