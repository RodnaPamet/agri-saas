# Security Hardening — Operations Guide

> **Epic scope**: middleware hardening, CORS, OAuth token encryption, admin session posture, fail-closed MFA, CSP refinement.

---

## 1. Security Headers

All responses have production-grade security headers via `src/lib/security/headers.ts`:

| Header | Value (Production) |
|---|---|
| Strict-Transport-Security | `max-age=31536000; includeSubDomains; preload` |
| X-Frame-Options | `DENY` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `camera=(), microphone=(), geolocation=(), browsing-topics=()` |
| Cross-Origin-Opener-Policy | `same-origin` |
| Cross-Origin-Resource-Policy | `same-origin` |

**Target**: securityheaders.com A+ rating.

---

## 2. CORS Policy

**Module**: `src/lib/security/cors.ts`

| Environment | Behavior |
|---|---|
| Production | Fail-closed — only `CORS_ALLOWED_ORIGINS` env var origins allowed |
| Staging | Same as production — no wildcards |
| Development | Allows `localhost:*` dev origins |

**No wildcard** `Access-Control-Allow-Origin: *` is ever set.

---

## 3. OAuth Token Encryption

### Architecture
- **Encryption**: AES-256-GCM with HKDF key derivation (`src/lib/security/encryption.ts`)
- **Middleware**: PII middleware (`src/lib/security/pii-middleware.ts`) transparently encrypts/decrypts
- **Fields**: `access_token` → `accessTokenEncrypted`, `refresh_token` → `refreshTokenEncrypted`

### Write Paths (all auto-encrypted by middleware)
| Path | Prisma Action |
|---|---|
| OAuth sign-in (PrismaAdapter) | `create` |
| Manual sign-in callback | `create` |
| Token refresh (JWT callback) | `updateMany` |

### Read Paths (auto-decrypted by middleware)
The PII middleware decrypts encrypted columns on `findUnique`, `findFirst`, `findMany`. If an encrypted column is `null` (pre-backfill row), the plaintext column is used as fallback.

### Backfill Migration
```bash
# 1. Audit (dry-run, no writes)
npx tsx scripts/backfill-token-encryption.ts

# 2. Encrypt existing rows
npx tsx scripts/backfill-token-encryption.ts --execute

# 3. Verify (rerun dry-run, should show 0 remaining)
npx tsx scripts/backfill-token-encryption.ts

# 4. Remove plaintext (after confidence period)
npx tsx scripts/backfill-token-encryption.ts --execute --null-plaintext
```

**Safety**: per-row roundtrip verification, per-row error isolation, idempotent reruns.

### Deprecation Path
After the backfill completes and plaintext columns are nulled:
1. Remove plaintext `access_token` / `refresh_token` from `PII_FIELD_MAP` mapping
2. Drop plaintext columns in a future migration
3. Remove fallback read path in PII middleware

---

## 4. Admin Session / Cookie Posture

### Why not SameSite=strict globally?
Auth.js v5 has one global cookie config. `SameSite=strict` globally breaks OAuth redirect flows (provider redirects are treated as cross-site navigations).

### Chosen Architecture
**Sec-Fetch-Site header validation** (`src/lib/security/admin-session-guard.ts`):
- Admin API routes block `cross-site` requests (equivalent to SameSite=strict for the routes that matter)
- Direct navigation (`none`) is allowed for safe methods (GET/HEAD)
- Missing header (curl, old browsers) is allowed — auth token is still required

This is integrated in `src/middleware.ts` after the admin role check.

---

## 5. Fail-Closed MFA

### Schema
```prisma
model TenantSecuritySettings {
  mfaFailClosed  Boolean @default(false)
}
```

### Behavior
| mfaFailClosed | MFA Dependency Failure | Token Error |
|---|---|---|
| `false` (default) | Fail open — allow through | none |
| `true` | Fail closed — deny access | `MfaDependencyFailure` |

Both MFA check points in `src/auth.ts` JWT callback respect this setting:
1. **Sign-in MFA check** — sets `mfaPending=true` + `error='MfaDependencyFailure'`
2. **Challenge completion check** — keeps `mfaPending=true` (access denied)

The `mfaFailClosed` flag is cached in the JWT token so subsequent requests don't need to re-read settings.

### Enabling
Set `mfaFailClosed: true` in the tenant's `TenantSecuritySettings` record via admin API or direct DB update.

---

## 6. CSP Strategy & Rollout

### Current Policy (production)
```
script-src  'self' 'nonce-X' 'strict-dynamic'
style-src   'self' 'unsafe-inline'
font-src    'self' data:
```

**No `unsafe-inline` in `script-src`** — scripts are nonce + `strict-dynamic`,
and the `patches/next+<version>.patch` CSP-nonce work exists to keep it that
way.

`style-src` DOES carry `'unsafe-inline'`, and deliberately: a nonce cannot
match a `style=` attribute, and the app emits many SSR inline styles
(progress-bar widths, status colours). The nonce is therefore dropped from
`style-src` rather than kept alongside a permission that overrides it. What
holds the line instead is `tests/guards/csp-style-guardrails.test.ts`, which
keeps `<style>` tags and CSS-in-JS out of the codebase. (This block previously
claimed no `unsafe-inline` for styles either — that was never true of the
shipped policy.)

**No third-party origin** in `style-src` or `font-src` since #779: the web
fonts are self-hosted under `/fonts/`, so neither `fonts.googleapis.com` nor
`fonts.gstatic.com` is reachable from the app.

### Rollout
```bash
# Step 1: Report-only mode (observe violations without blocking)
CSP_REPORT_ONLY=true

# Step 2: Monitor violations — platform-admin key required (#704)
curl -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" \
     https://<host>/api/security/csp-report   # recent violation summary

# Step 3: Enforce (block violations)
CSP_REPORT_ONLY=false  # or unset (default = enforce)
```

> **Reports only started arriving on 2026-08-21.** The sink was never in
> `PUBLIC_PATH_PREFIXES`, so the Edge answered every credential-less browser
> report with a 401 and the ring buffer was permanently empty — from the day
> the feature shipped (2026-03-21) until #704. If you are reading a violation
> summary from before that date, it is empty because nothing was ever stored,
> not because nothing was violated.
>
> The `GET` moved behind `PLATFORM_ADMIN_API_KEY` in the same change. It had
> relied on the Edge's "any authenticated user" gate, and opening the prefix
> for the `POST` sink would have removed that — publishing every reporter's IP
> and User-Agent, since the summary returns whole `CspViolation` objects from a
> global, un-tenanted ring buffer.

### Development-Only Exceptions
| Directive | Exception | Reason |
|---|---|---|
| `script-src` | `'unsafe-eval'` | Next.js HMR/Fast Refresh |
| `style-src` | `'unsafe-inline'` | Next.js HMR style injection ([#39706](https://github.com/vercel/next.js/issues/39706)) |

These exceptions are **never present in production**.

---

## Key Files

| File | Purpose |
|---|---|
| `src/lib/security/headers.ts` | Security response headers |
| `src/lib/security/cors.ts` | CORS policy |
| `src/lib/security/csp.ts` | CSP builder + report-only toggle |
| `src/lib/security/encryption.ts` | AES-256-GCM encryption primitives |
| `src/lib/security/pii-middleware.ts` | Prisma middleware for transparent PII encryption |
| `src/lib/security/admin-session-guard.ts` | Admin Sec-Fetch-Site CSRF protection |
| `src/auth.ts` | JWT callback with fail-closed MFA |
| `src/middleware.ts` | Centralized middleware (headers, CORS, CSP, admin guard) |
| `scripts/backfill-token-encryption.ts` | Token encryption backfill script |
