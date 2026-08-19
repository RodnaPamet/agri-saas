# Epic C — Defense-in-Depth (operator + contributor index)

> Five layers, one defense-in-depth story. Read the source files
> linked below when you need details; come back here for the
> architecture summary, env-var reference, and verification runbook.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│ Request                                                               │
│   ─▶ withApiErrorHandling (src/lib/errors/api.ts)                     │
│        ─▶ requirePermission(<key>, handler)                           │
│             ├─ getTenantCtx → resolves session + tenant + perms       │
│             ├─ hasPermission(appPermissions, key)                     │
│             │    ─ allowed → handler(req, args, ctx)                  │
│             │    ─ denied  → AUTHZ_DENIED audit + throw forbidden     │
│             ─▶ usecase                                                │
│                  ─ Epic C.5 — sanitize* before persist                │
│                  ─▶ runInTenantContext (Epic A.1)                     │
│                  ─▶ Prisma queries                                    │
│                  ─▶ appendAuditEntry                                  │
│                       └─ streamAuditEvent  ─ ─ ─▶  per-tenant buffer  │
│                                                    ↓ 100 events / 5s  │
│                                              POST <tenant SIEM>       │
│                                              X-Inflect-Signature: …   │
│                                                                       │
│   Sign-in flow (Epic C.3)                                             │
│        NextAuth jwt callback                                          │
│             ─ recordNewSession (caps expiresAt, evicts oldest if      │
│                                  over maxConcurrentSessions)          │
│             ─ verifyAndTouchSession on every JWT pass                 │
│                  └─ revoked or expired → SessionRevoked               │
└──────────────────────────────────────────────────────────────────────┘

  Local dev path                       CI / pre-merge path
  ──────────────                       ───────────────────
  .husky/pre-commit                    npm run test:ci
    └─ scripts/detect-secrets.sh         ├─ tests/guardrails/
         (staged files only)             │    api-permission-coverage.test.ts
                                         ├─ tests/guardrails/no-secrets.test.ts
                                         └─ tests/unit/security/*
```

| Layer | What it does | Source of truth |
|---|---|---|
| C.1 — API permission middleware | `requirePermission(<key>, handler)` enforces a granular `PermissionKey` against `RequestContext.appPermissions`. Composes with `withApiErrorHandling`. Audit on denial. | `src/lib/security/permission-middleware.ts` |
| C.1 — Route → permission map | Declarative map from URL regex to `PermissionKey`. Single source of truth for which routes need which keys; a CI guardrail keeps it in sync with the filesystem. | `src/lib/security/route-permissions.ts` |
| C.2 — Local secret-detection | `.husky/pre-commit` runs `scripts/detect-secrets.sh` against staged files only. Inline `pragma: allowlist secret` carve-out. | `scripts/detect-secrets.sh`, `.husky/pre-commit`, `.secret-patterns` |
| C.2 — CI secret-detection | `tests/guardrails/no-secrets.test.ts` walks `git ls-files` with the same patterns; `REPO_BASELINE` lists known-placeholder fixtures. | `tests/guardrails/no-secrets.test.ts` |
| C.3 — Session metadata + lifecycle | `UserSession` table (sessionId, ip, ua, expiresAt, lastActiveAt, revokedAt). NextAuth `jwt` callback records on first mint; touches throttled to 5min; honours revoked + expired as `SessionRevoked`. | `src/lib/security/session-tracker.ts` |
| C.3 — Concurrent-session + max-duration policy | `TenantSecuritySettings.maxConcurrentSessions` (revoke-oldest on overflow); `sessionMaxAgeMinutes` caps `expiresAt` at insert. | same module + `prisma/schema.prisma` |
| C.3 — Admin sessions UI | Sessions column + modal on `/admin/members`. Uses `GET /admin/sessions[?userId=]` + `DELETE /admin/sessions`. | `src/app/t/[tenantSlug]/(app)/admin/members/page.tsx` |
| C.4 — Audit event streaming | Best-effort outbound stream of every committed audit row to a tenant-configured webhook. Per-tenant buffer, 100-event / 5-second flush, HMAC-SHA256 signed, fail-safe. | `src/app-layer/events/audit-webhook.ts` |
| C.5 — Server-side sanitisation | `sanitizeRichTextHtml` / `sanitizePlainText` / `sanitizePolicyContent`. Wired into `policy.createPolicyVersion`, `task.addTaskComment`, `issue.addIssueComment` — sanitise before persist. | `src/lib/security/sanitize.ts` |
| Disclosure | Coordinated disclosure policy + safe-harbour. | `SECURITY.md` |

## Environment variables

Epic C does not introduce any new global env vars. All policy is
**per-tenant** through `TenantSecuritySettings`:

| Field | Default | Effect when set |
|---|---|---|
| `sessionMaxAgeMinutes` | `null` (NextAuth default — 30 days) | Hard cap on `UserSession.expiresAt`. |
| `maxConcurrentSessions` | `null` (unlimited) | When the user is at the cap, the oldest session (by `lastActiveAt` ASC) is revoked with `revokedReason: 'policy:concurrent-limit'` to make room. |
| `auditWebhookUrl` | `null` (streaming disabled) | HTTPS endpoint that audit batches POST to. |
| `auditWebhookSecretEncrypted` | `null` | HMAC-SHA256 secret. **Stored encrypted** via the Epic B field-encryption manifest — write/read round-trips through the middleware automatically. |

There are no kill-switch env vars; degraded behaviour is built into
each layer (see "Failure modes" below).

## Verification runbook

Run the whole Epic C test bundle locally before promoting:

```bash
npx jest \
  tests/unit/security/ \
  tests/unit/audit-webhook.test.ts \
  tests/guardrails/api-permission-coverage.test.ts \
  tests/guardrails/admin-route-coverage.test.ts \
  tests/guardrails/no-secrets.test.ts \
  --no-coverage
```

Expected: every suite green. Reference run-time on this repo: ≈ 3s.

### V.1 — Permission denied flow (C.1)

**Goal:** prove that an unprivileged session is rejected at the API
boundary AND that the denial is recorded.

```bash
# Sign in as a READER, then probe an admin endpoint.
curl -i -X GET https://app.example.com/api/t/<slug>/admin/scim \
     -H "cookie: next-auth.session-token=<reader session cookie>"
```

Expected:

- `HTTP/2 403`
- Body: `{"error":{"code":"FORBIDDEN","message":"Permission denied", …}}`
- The message is **generic** — the response never echoes the
  `admin.scim` key (response-side hardening; the audit row carries the
  key for security review).
- A new row in `AuditLog`:
  ```sql
  SELECT entity, "entityId", action, "detailsJson"
  FROM "AuditLog"
  WHERE action = 'AUTHZ_DENIED'
  ORDER BY "createdAt" DESC LIMIT 1;
  ```
  `entity = 'Permission'`, `entityId = 'admin.scim'`,
  `detailsJson.category = 'access'`,
  `detailsJson.event = 'authz_denied'`.

### V.2 — Secret detection (C.2)

**Goal:** prove both the local hook and the CI guardrail catch a
planted secret.

Local (Husky pre-commit):

```bash
echo 'const k = "AKIAIOSFODNN7EXAMPLE";' > /tmp/leak.ts  # pragma: allowlist secret — AWS canonical "this-is-fake" placeholder used in AWS's own docs
git add /tmp/leak.ts            # not in repo, but the hook scans staged files
git commit -m 'leaks AWS key'
# Expected:
#   ✖ Possible secrets detected in staged changes
#   :  AWS Access Key ID
git restore --staged /tmp/leak.ts
rm /tmp/leak.ts
```

CI guardrail:

```bash
npx jest tests/guardrails/no-secrets.test.ts --no-coverage
```

Expected: green. If a real new secret has slipped in, the failure
message names the file + pattern + line and tells the developer how to
fix it (rotate, allowlist, or move to `tests/fixtures/secrets/`).

### V.3 — Concurrent session enforcement (C.3)

**Goal:** prove that a 4th sign-in evicts the oldest session when
`maxConcurrentSessions = 3`.

```sql
-- Set the policy on a test tenant.
UPDATE "TenantSecuritySettings"
SET "maxConcurrentSessions" = 3
WHERE "tenantId" = '<tenant-id>';
```

```bash
# Sign in 4 times for the same user from 4 different curl/browser
# sessions. After the 4th sign-in:
SELECT "sessionId", "lastActiveAt", "revokedAt", "revokedReason"
FROM "UserSession"
WHERE "userId" = '<user-id>'
  AND "tenantId" = '<tenant-id>'
ORDER BY "createdAt" DESC;
```

Expected: 3 rows with `revokedAt IS NULL`, 1 row with
`revokedReason = 'policy:concurrent-limit'` and a `revokedAt`
timestamp matching the 4th sign-in.

Max-duration enforcement:

```sql
UPDATE "TenantSecuritySettings"
SET "sessionMaxAgeMinutes" = 60
WHERE "tenantId" = '<tenant-id>';
```

Then sign in. The new `UserSession.expiresAt` should be ≈ 60 minutes
out, NOT 30 days.

### V.4 — Audit event streaming (C.4)

**Goal:** prove a committed audit row reaches the configured SIEM with
a verifiable signature.

```sql
-- One-time setup — point a test tenant at a webhook.site bucket.
UPDATE "TenantSecuritySettings"
SET "auditWebhookUrl" = 'https://webhook.site/<bucket-uuid>',
    "auditWebhookSecretEncrypted" = 'shhh-test-secret'
WHERE "tenantId" = '<tenant-id>';
-- Note: the field-encryption middleware encrypts on write.
```

Trigger any audited action (deny a permission, revoke a session,
create a control). Within 5 seconds, the bucket should receive a POST:

```jsonc
{
  "schemaVersion": 1,
  "tenantId": "<tenant-id>",
  "sentAt": "...",
  "count": 1,
  "events": [{ "id": "...", "action": "...", "actorType": "USER", ... }]
}
```

Header `X-Inflect-Signature: sha256=<hex>` must equal
`computeHmacSha256(<body>, 'shhh-test-secret', 'hex')` — the existing
`verifyHmacSha256` helper in `src/app-layer/integrations/webhook-crypto.ts`
verifies it.

To exercise the batch-by-count path (100 events), drive a load test
that emits ≥100 audit-relevant actions for a single tenant in <5s; the
single resulting POST will carry `count: 100`.

### V.5 — Sanitisation before storage (C.5)

**Goal:** prove that a hostile rich-text payload lands clean in the
database, not just clean in the rendered UI.

```bash
# Create an HTML policy version with an embedded <script>.
curl -X POST https://app.example.com/api/t/<slug>/policies/<id>/versions \
     -H 'cookie: ...' -H 'content-type: application/json' \
     -d '{"contentType":"HTML","contentText":"<h1>Title</h1><script>alert(1)</script>","changeSummary":"v1"}'
```

Then read the row directly:

```sql
SELECT "contentText"
FROM "PolicyVersion"
ORDER BY "createdAt" DESC LIMIT 1;
```

Expected: `<h1>Title</h1>` — the `<script>` tag and its body must be
absent. Verify the same is true for task / issue comments via
`addTaskComment` / `addIssueComment`.

## Failure modes (by design)

Each layer degrades gracefully rather than failing closed when its
telemetry / outbound surface is unavailable:

| Layer | Degradation | Why |
|---|---|---|
| C.1 | If `appendAuditEntry` for the AUTHZ_DENIED row fails, the 403 still reaches the client and a `logger.warn` records the audit failure. | Telemetry side; never trade a working denial for a broken audit. |
| C.2 | A pre-commit bypass (`git commit --no-verify`) is intentional — the CI guardrail catches anything that escapes locally. | Developer ergonomics + final CI gate. |
| C.3 | `recordNewSession` swallows DB failures and returns a placeholder rowId so a Prisma blip can't lock users out at sign-in. `verifyAndTouchSession` is fail-open on DB errors. The classic `User.sessionVersion` check remains as a backstop. | Sign-in is on the hot path; transient DB unavailability must not sign every active user out. |
| C.4 | Outbound POST failures (timeout, non-2xx, connection reset) log a warning and drop the batch. Subsequent events are still buffered. | The audit row is already committed — streaming is a side-view. |
| C.5 | `sanitize*` returns `''` for null / undefined / non-string. A future TS-loose call site can't bypass sanitisation. | Defensive defaults; never throw out of a sanitiser. |

## Rollback procedure

Use only in a genuine incident. Each sub-epic rolls back independently.

### C.1 — Permission middleware

If a specific permission key is mis-mapped, hot-fix the rule in
`src/lib/security/route-permissions.ts` and the corresponding
`requirePermission(<key>, …)` call site. The change is just a
TypeScript edit + redeploy — the guardrail at
`tests/guardrails/api-permission-coverage.test.ts` will block a
regression.

If the entire layer needs to be disabled for one route in a 5-alarm
fire, `git revert` the commit that wrapped it with
`requirePermission`. The legacy `requireAdminCtx` swap-back is gone —
the helper was deleted 2026-05-21. Do NOT swap to unguarded
`getTenantCtx`; that drops the role check entirely.

### C.2 — Secret detection

Local hook: `git commit --no-verify` (per-commit). If the hook itself
is wedged, `git config core.hooksPath ''` disables Husky entirely —
the CI guardrail still runs.

CI guardrail: an emergency PR bypass is **not** provided. If
`tests/guardrails/no-secrets.test.ts` is failing CI for a known-safe
fixture, add it to `REPO_BASELINE` with a written `reason` in the same
PR.

### C.3 — Session limits

Set `maxConcurrentSessions = NULL` and/or `sessionMaxAgeMinutes = NULL`
on `TenantSecuritySettings` for the affected tenant. Existing
`UserSession` rows with `revokedAt` set stay revoked — clear them only
if you're certain a row was wrongly evicted:

```sql
UPDATE "UserSession"
SET "revokedAt" = NULL, "revokedReason" = NULL
WHERE "tenantId" = '<id>'
  AND "revokedReason" = 'policy:concurrent-limit'
  AND "revokedAt" > NOW() - INTERVAL '10 minutes';
```

### C.4 — Audit streaming

Set `auditWebhookUrl = NULL` to disable streaming for a tenant. The
in-process buffer drops un-flushed events on the next flush attempt
(the resolver returns null → silent drop) — the audit table itself is
never affected.

### C.5 — Sanitisation

Sanitisation is purely a write-path transformation; rolling back means
either deleting the call site (allowing raw input through) OR leaving
it in place and accepting cleaner-than-required content. There is no
operator action to take — sanitisation never fails the request.

## Remaining non-blocking caveats

1. **The audit-stream buffer is per-process.** In a multi-instance
   deployment, each Node process has its own buffer. This is fine for
   at-least-once-per-process semantics but means a slow consumer can't
   coalesce across instances. Future hardening: move the buffer into
   Redis (the swap point is `getBuffer` in
   `src/app-layer/events/audit-webhook.ts`).

2. **Session `lastActiveAt` is throttled to 5 minutes.** Activity
   bursts within a 5-minute window touch the row only once. This is
   intentional — the alternative (a write per request) would dominate
   the row's WAL footprint. Consequence: the admin "last active"
   timestamp can be up to 5 minutes stale.

3. **The OpenAI / Anthropic regex tightness assumes today's key
   prefixes.** If either provider rotates their format, update the
   pattern in `.secret-patterns` and add a positive case in
   `tests/unit/security/detect-secrets.test.ts`.

4. **Revoke-oldest is the chosen overflow policy.** A future tenant
   with strict access-control posture may prefer "deny new" — switch
   the strategy in `evictOldestSessionsToFit` (one function, ~15
   lines). The unit test fixtures cover both shapes.

5. **`category: 'access'` is the canonical audit-details category for
   authn/authz events.** The audit-details schema is closed
   (`entity_lifecycle | data_lifecycle | status_change | relationship | access | custom`); a new event type that doesn't fit needs to land
   in `src/app-layer/schemas/json-columns.schemas.ts` first or it
   will be silently dropped by `validateAuditDetailsJson`.

6. **The sanitiser allowlist is conservative on purpose.** If the
   product needs additional formatting (footnotes, KaTeX, embedded
   images), widen `RICH_TEXT_ALLOWED_TAGS` / `RICH_TEXT_ALLOWED_ATTRS`
   in `src/lib/security/sanitize.ts` and add positive + negative test
   cases in `tests/unit/security/sanitize.test.ts`. Do not add `style`,
   `class`, `id`, `<svg>`, `<iframe>`, `<object>`, `<embed>` without a
   security review.

## SCIM at the Edge (2026-08-19)

`/api/scim/` is in `PUBLIC_PATH_PREFIXES`, which looks alarming and is not.

A SCIM bearer is an opaque token compared against a SHA-256 hash in
`TenantScimToken`. The Edge middleware runs on the Edge runtime with no
database, and `getToken()` understands only a NextAuth JWE — so the Edge
**cannot** verify a SCIM credential. Before the carve-out it did the only thing
it could: `getToken()` returned `null` and every SCIM request was answered
`401 {"error":"Unauthorized"}`. Provisioning had never worked for anyone, since
the feature shipped, and CI could not see it because the SCIM tests import
`authenticateScimRequest` directly and never cross the middleware.

**Authentication for these routes lives in the handlers**, via
`authenticateScimRequest`. That is not a convention anyone has to remember:

| control | what it holds |
|---|---|
| `tests/guards/scim-routes-self-authenticate.test.ts` | Fail-closed. Derives the route inventory from the filesystem, so a NEW route under `/api/scim` is covered the moment it exists. One written exemption: `ServiceProviderConfig` (RFC 7644 §4 discovery metadata, no DB access), and the guard fails if that file ever grows a database call. |
| `tests/unit/scim-edge-reachability.test.ts` | Executing. Drives the real middleware; asserts SCIM passes and that a normal tenant route with the same unusable bearer still 401s. |
| `tests/e2e/scim-provisioning.spec.ts` | Real HTTP. A bad token must return the **SCIM Error schema**, not the Edge's generic body — that is the difference between "the handler rejected you" and "the handler never ran". |
| `src/lib/rate-limit/scimRateLimit.ts` | Budget. See below. |

**Tenant isolation is stronger here than a URL slug, not weaker.**
`authenticateScimRequest` resolves the tenant from the token itself, so a token
can only ever act on its own tenant; there is no slug in the path to mismatch.

**The token-minting route is NOT covered by the carve-out.**
`POST /api/t/:slug/admin/scim` stays behind the session gate and
`requirePermission('admin.scim')` — the trailing slash on `/api/scim/` is what
keeps the carve-out from widening, and both the unit test and the e2e assert a
SCIM bearer cannot reach it.

### Rate limiting

SCIM had **no** tier at all: the read tier requires an `/api/t/` prefix, and the
mutation tier lives in `withApiErrorHandling`, which the SCIM handlers do not
use. Now that these routes are anonymous at the Edge, they are the one API
surface where an unauthenticated caller reaches a token comparison — a
brute-force oracle if unbudgeted.

`SCIM_LIMIT` (300/min per bearer) and `SCIM_IP_LIMIT` (600/min per IP) in
`src/lib/security/rate-limit.ts`. **Both are required.** Per-bearer alone does
nothing against the attack: a caller who sends a fresh guess each request gets a
fresh bucket each request and is never limited. Per-IP alone would throttle
innocent tenants, because Entra egresses several tenants' syncs from one
Microsoft IP pool — hence the ceiling being double the per-tenant budget. The
bearer is hashed into the rate-limit key so a live credential never lands in
Redis or a log.

Operator knobs: `RATE_LIMIT_ENABLED=0` bypasses (all tiers),
`RATE_LIMIT_MODE=memory` forces the in-process store. Fail-open on backend
error — an Upstash outage must not take provisioning down.


## Signed webhooks at the Edge (2026-08-20)

Three endpoints join SCIM in `PUBLIC_PATH_PREFIXES`:

| route | credential |
|---|---|
| `/api/stripe/webhook` | Stripe signature via `constructWebhookEvent` |
| `/api/storage/av-webhook` | HMAC-SHA256 over the raw body, `timingSafeEqual` |
| `/api/integrations/webhooks/:provider` | per-connection secret via `processIncomingWebhook` |

**They had never been delivered.** Their senders — Stripe, the AV scanner, a
third-party service — cannot carry a NextAuth session cookie, so `getToken()`
returned null and the middleware answered `401 {"error":"Unauthorized"}` before
any handler ran. Verified by driving the real middleware.

Latent rather than live on the current deployment (Stripe unconfigured, AV
scanning disabled), which is exactly what let it survive: it fails **silently**
the day either is enabled. Set `STRIPE_SECRET_KEY` and subscription state
simply never updates — payments succeed, plans never change, nothing errors.

**Every handler fails CLOSED with no secret configured**, which is what makes
opening the Edge safe: Stripe throws (`STRIPE_WEBHOOK_SECRET is not
configured`), the AV webhook 500s in production, integrations 401. The AV
webhook has an explicit dev-only bypass, gated on `NODE_ENV !== 'production'`.

### The guard is general, not per-route

`tests/guards/public-routes-self-authenticate.test.ts` enforces **both**
directions of one rule, derived from the filesystem:

- **A** — a route reading a credential header and verifying it must be
  reachable. Six instances of this failing shipped (`token.error`, `iflk_`,
  SCIM, and these three).
- **B** — a route behind a public prefix must verify something.

Either alone is worse than none: A without B turns dead endpoints into
anonymous ones; B without A leaves them dead. When first run it flagged
`/api/staging/seed` and the integrations webhook — both legitimate, and the
DETECTOR was widened rather than the routes exempted, because an exemption
would hide the next genuinely-anonymous route added under either prefix.

`tests/unit/webhook-edge-reachability.test.ts` is the behavioural half: it
drives the real middleware, and includes a negative control plus assertions
that the neighbouring paths (`/api/stripe/customers`,
`/api/integrations/connections`, `/api/storage/upload`) are still gated.

### Rate limiting

They share the SCIM tier (`SCIM_LIMIT` 300/min per credential, `SCIM_IP_LIMIT`
600/min per IP). Same traffic class — machine-to-machine, signed, bursty on
retry — and a separate budget would be a number nobody could justify
differently. The point is the same as SCIM's: an anonymous caller reaching a
signature comparison is unbounded database and log load, since every handler
logs a warn on a bad signature.
