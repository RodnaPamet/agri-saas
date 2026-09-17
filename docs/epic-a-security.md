# Epic A — Tenant Isolation & Rate Limiting (operator + contributor index)

> Three layers, one defense-in-depth story. Read the deep-dive docs
> linked below when you need details; come back here for the
> architecture summary, env-var reference, and verification runbook.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│ Request                                                              │
│   ─▶ withApiErrorHandling (src/lib/errors/api.ts)                    │
│        ├─ x-request-id + tracing + metrics                           │
│        └─ Epic A.2 — rate limit (default API_MUTATION_LIMIT)         │
│             429 short-circuit + Retry-After                          │
│        ─▶ handler                                                    │
│             ├─ auth (NextAuth POST / credentials)                    │
│             │    ─ Epic A.3 — progressive delay + lockout            │
│             │    ─ HIBP on signup                                    │
│             └─ usecase                                               │
│                  ─▶ runInTenantContext (src/lib/db/rls-middleware.ts)│
│                       ─ SET LOCAL ROLE app_user                      │
│                       ─ set_config('app.tenant_id', …, true)         │
│                       ─▶ Prisma queries                              │
│                            ─ Epic A.1 — RLS policies in Postgres     │
│                                  tenant_isolation / superuser_bypass │
└─────────────────────────────────────────────────────────────────────┘
```

| Layer | What it does | Canonical doc |
|---|---|---|
| A.1 — RLS | Postgres enforces `tenantId = current_setting('app.tenant_id')` on every tenant-scoped table | [`docs/rls-tenant-isolation.md`](./rls-tenant-isolation.md) |
| A.2 — Global rate limiting | `withApiErrorHandling` default + per-route overrides (`LOGIN_LIMIT`, `API_KEY_CREATE_LIMIT`) | — this file, §"Rate limit presets" |
| A.3 — Auth brute-force + HIBP | Progressive delay + lockout; breached-password rejection at signup | — this file, §"Auth brute-force" |

## Environment variables

| Variable | Values | Default | When to set |
|---|---|---|---|
| `RATE_LIMIT_ENABLED` | `0` / `1` / unset | unset (enabled in prod, auto-bypass in tests) | Set `0` to kill-switch all rate limits during an incident. Set `1` inside a specific test that needs to exercise the limiter. |
| `RATE_LIMIT_MODE` | `upstash` / `memory` | `upstash` | Prod/staging: `upstash` for cross-instance counters. Dev/CI: `memory` for zero-dependency runs. |
| `AUTH_TEST_MODE` | `0` / `1` / unset | unset | `1` short-circuits Upstash credential check + progressive auth delay. Used by E2E scripts; **never set in prod**. |

Rate-limit auto-bypass rule inside `withApiErrorHandling`:

```
NODE_ENV === 'test' AND RATE_LIMIT_ENABLED !== '1'  →  bypass
RATE_LIMIT_ENABLED === '0'                          →  bypass
otherwise                                           →  enforce
```

The NextAuth POST and `authenticateWithPassword` honour the same rule.

## Rate limit presets

All defined in `src/lib/security/rate-limit.ts`. Applied via `withApiErrorHandling` options.

| Preset | Budget | Window | Lockout | Used by |
|---|---:|---|---|---|
| `API_MUTATION_LIMIT` | 60 | 1 min | — | Default for POST/PUT/DELETE/PATCH on every `withApiErrorHandling` route |
| `LOGIN_LIMIT` | 10 | 15 min | 15 min | `src/app/api/auth/[...nextauth]/route.ts` POST |
| `API_KEY_CREATE_LIMIT` | 5 | 1 hr | 1 hr | `src/app/api/t/[tenantSlug]/admin/api-keys/route.ts` POST |
| `MFA_VERIFY_LIMIT` | 5 | 15 min | 5 min | MFA challenge verify (inline in route) |
| `MFA_ENROLL_VERIFY_LIMIT` | 10 | 15 min | — | MFA enrollment verify (inline in route) |
| `EMAIL_DISPATCH_LIMIT` | 5 | 1 hr | — | Available for future magic-link / reset-email routes |

**Ordering invariant** (asserted by `tests/unit/rate-limit-middleware.test.ts`): `API_KEY_CREATE_LIMIT` ≤ `LOGIN_LIMIT` ≤ `API_MUTATION_LIMIT` on `maxAttempts`. Don't loosen a higher-risk preset without updating the test.

## Auth brute-force

Defined in `src/lib/security/rate-limit.ts` as `LOGIN_PROGRESSIVE_POLICY`; wired into `authenticateWithPassword`.

| Failures | Next attempt |
|---:|---|
| 0–2 | no delay (typo allowance) |
| 3–4 | **5s delay** before bcrypt verify |
| 5–9 | **30s delay** before bcrypt verify |
| 10+ | **15-min lockout** — returns `rate_limited` + `retryAfterSeconds` without touching bcrypt; `dummyVerify` equalises timing so the attacker can't distinguish lockout from wrong-password |

Window: 1 hour. Successful verify resets the counter. Lockout auto-expires after 15 min and the counter resets to zero on the next legitimate attempt.

**Identifier is SHA-256(email)** — plaintext emails are never stored in the in-memory rate-limit keys, so a memory dump can't be scraped to enumerate accounts.

## HIBP password check

`src/lib/security/password-check.ts` — k-anonymity query to `api.pwnedpasswords.com/range/{prefix}` with only the first 5 chars of the SHA-1.

- Enforced on signup (`src/app/api/auth/register/route.ts`) after length policy, before `hashPassword`.
- **Fails open**: HIBP outage, timeout, 5xx, or parse error returns `skipped: true` and registration continues. The layer improves user security when available without becoming a single point of failure.
- 2s timeout via `AbortController`.
- `Add-Padding: true` header — HIBP-recommended, constant response size so a network observer can't fingerprint the prefix.
- Never logs the password, SHA-1 hash, or suffix — enforced by test.

## Observability signals

Grep the structured log stream for these keys when investigating:

| Log key | Source | Meaning |
|---|---|---|
| `rate-limit.blocked` | `rate-limit-middleware` | A request was 429'd. Includes `scope`, `ip`, `hasUserId`. |
| `rate-limit.allowed` (debug) | `rate-limit-middleware` | Every allowed mutation. Noisy — use for troubleshooting. |
| `request rate-limited` | `api` | Matching request-level log from the shared wrapper. Carries `scope` + `durationMs`. |
| `rls-middleware.bypass_invoked` | `rls-middleware` | Every `runWithoutRls` call. Fields: `reason` (typed), `caller` (module/file.ts:line). Audit trail for every bypass. |
| `rls-middleware.missing_tenant_context` | `rls-middleware` | Tripwire — tenant-scoped query ran without `runInTenantContext`. `warn` on writes, `debug` on reads. |
| `password-check.upstream_error` / `.timeout` / `.network` / `.parse_error` | `password-check` | HIBP unavailable. `warn` level. Never contains password material. |
| `authentication: rate_limited` (audit row) | `security-events` via `appendAuditEntry` | Progressive lockout or per-email limit trip. Attributed to the user's tenant if the email resolves. |

OTel spans on `api.request` carry `rate_limit.scope` as an attribute when a 429 is produced — usable for per-route breakdowns in Jaeger/Grafana without new metric wiring.

## Verification runbook

Each section can be run against the live dev DB (port 5437 direct) and the running Next.js server.

### V.1 — Cross-tenant isolation (RLS)

**Goal:** prove that a session scoped to tenant-A cannot read tenant-B's rows.

```bash
# Quickest path: dedicated guardrail test.
npx jest tests/guardrails/rls-coverage.test.ts
npx jest tests/integration/rls-middleware.test.ts

# Manual check via `psql`-style Prisma query:
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma studio   # or a scratch script
```

Expected:
- Guardrail reports every tenant-scoped model has `tenant_isolation` + `superuser_bypass` + FORCE RLS.
- Integration test reports own-tenant = N rows, cross-tenant = 0 rows.

For a full manual SQL walk-through see [`docs/rls-tenant-isolation.md`](./rls-tenant-isolation.md#testing).

### V.2 — Mutation endpoint rate limiting

**Goal:** prove a burst of POSTs beyond `API_MUTATION_LIMIT` returns 429 with `Retry-After`.

Option A — automated:
```bash
npx jest tests/unit/rate-limit-rollout.test.ts tests/integration/epic-a-security.test.ts
```

Option B — against a running dev server (replace `<cookie>` with a valid session):
```bash
# Pick a cheap, idempotent POST. 61 bursts from one IP, same session:
for i in $(seq 1 61); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "cookie: <cookie>" \
    -H "content-type: application/json" \
    -X POST http://localhost:3000/api/t/<tenantSlug>/notifications/mark-all-read
done
echo
# Expect 60× "200 " followed by "429". Inspect the 429 response headers:
curl -i -H "cookie: <cookie>" \
  -X POST http://localhost:3000/api/t/<tenantSlug>/notifications/mark-all-read
```

Expected in the 429:
- `Retry-After: <seconds>`
- `X-RateLimit-{Limit,Remaining,Reset}`
- `x-request-id` present
- Body: `{"error":{"code":"RATE_LIMITED","scope":"api-mutation","retryAfterSeconds":…}}`

### V.3 — Brute-force login lockout

**Goal:** prove that 10 bad credentials against one email triggers lockout.

Option A — automated (includes a 5s live-delay assertion):
```bash
npx jest tests/unit/auth-brute-force.test.ts tests/unit/progressive-rate-limit.test.ts
```

Option B — against a running dev server:
```bash
EMAIL='victim@example.com'
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code} " \
    -H "content-type: application/json" \
    -X POST http://localhost:3000/api/auth/callback/credentials \
    -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-$i\",\"csrfToken\":\"<token>\"}"
done
echo
```

Expected: attempts 4+ should take noticeably longer (5s / 30s). The 11th attempt returns within the RFC-7231 response window (no bcrypt executed) and the NextAuth credentials surface shows a `rate_limited` failure reason.

Also expected: a hash-chained audit row per failure visible to the tenant admin. Search the audit log:
```sql
SELECT action, reason, "createdAt"
FROM "AuditLog"
WHERE action = 'AUTH_LOGIN_FAILURE'
  AND "createdAt" > NOW() - INTERVAL '15 minutes'
ORDER BY "createdAt" DESC;
```

### V.4 — HIBP breach rejection

**Goal:** prove that a famously-breached password is rejected at signup.

Option A — automated (HIBP mocked):
```bash
npx jest tests/unit/password-check.test.ts
```

Option B — against a running dev server (live HIBP — the string `password` is in the corpus ~10 million times):
```bash
curl -i -H "content-type: application/json" \
  -X POST http://localhost:3000/api/auth/register \
  -d '{"action":"register","email":"test-hibp@example.com","password":"password","name":"Test","orgName":"TestOrg"}'
```

Expected: 400 with body `{"error":"This password appears in known data breaches. Please choose a different password."}`.

If HIBP is unavailable (air-gapped environment), registration proceeds — look for `password-check.upstream_error` / `.timeout` / `.network` in the logs.

## Rollback procedure

Use only in a genuine incident. All three layers rollback independently.

### Rate limiting (A.2)

```bash
# Kill-switch via env var — no deploy needed:
export RATE_LIMIT_ENABLED=0
# Restart the Next.js + worker processes to pick it up.
```

Effect: default mutation limit, `LOGIN_LIMIT`, `API_KEY_CREATE_LIMIT`, progressive auth delay all become no-ops. MFA-specific rate limits (inline in their routes) are NOT affected by this switch.

### Brute-force (A.3)

Set `AUTH_TEST_MODE=1` — short-circuits both the Upstash per-email check and the progressive layer. **Never use in prod unless the limiter itself is the incident.** The HIBP check keeps running.

### RLS (A.1)

**There is no safe kill-switch.** Dropping RLS policies is the nuclear option and would leak cross-tenant data. If an RLS policy is wrong:

1. Hot-fix the specific policy in a follow-up migration (idempotent `DROP POLICY IF EXISTS … CREATE POLICY …`).
2. If a route absolutely must query cross-tenant (an admin dashboard, say), use `runWithoutRls({ reason: 'admin-script', … })` — the helper is typed, logged, and auditable.

Never run `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` in production.

## Remaining non-blocking caveats

1. **The in-memory rate-limit store is per-process.** For multi-instance deployments, the counters on `withApiErrorHandling` do NOT share state. The edge-runtime Upstash limiter in `src/lib/rate-limit/authRateLimit.ts` handles the edge/middleware surface with a shared Redis; the Node-side counters are intentionally local so MFA / progressive-delay don't require a Redis call. If global consistency becomes a product requirement, the swap point is `store` in `src/lib/security/rate-limit.ts` — one file, behind the existing API.

2. **The progressive brute-force counter is in-memory.** Same caveat as above. A determined attacker rotating between app replicas could sustain ~10 failures × N_REPLICAS per hour before hitting any single replica's lockout. Given each replica still incurs bcrypt cost per attempt, this is back-pressure rather than a loss. If this matters, the same swap point applies.

3. **HIBP check is not enforced on password change / reset.** Those routes don't exist in the codebase yet. When they land, call `checkPasswordAgainstHIBP` alongside `validatePasswordPolicy` the same way `/api/auth/register` does — test coverage pattern is in `tests/unit/password-check.test.ts`.

4. **`runWithoutRls` caller fingerprint uses `Error.stack`.** Stack trace format is Node-implementation-dependent; a future V8 change could subtly change the `module/file.ts:line` format. Tests cover the happy-path extraction; if the format changes, the log field silently becomes `'unknown'` (documented behaviour). Not a security regression — just a telemetry regression.

5. **The `allow_all` policy tripwire** in the guardrail test covers the residue of `prisma/rls-fix.sql` stopgaps. If a future migration adds its own `allow_all` for a new reason, the guardrail will fail — at which point either legitimise the pattern with a comment + allowlist, or adopt the EXISTS-based pattern from `PolicyControlLink`.
