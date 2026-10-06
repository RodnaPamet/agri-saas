# Epic B — Field Encryption & Key Rotation (operator + contributor index)

> Four layers, one envelope story. Read the Epic 8 legacy doc
> (`docs/encryption-data-protection.md`) for the PII-column
> posture; this file covers Epic B (business-content fields +
> per-tenant DEKs + rotation) and links back.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 0 — ROOT SECRET                                               │
│  DATA_ENCRYPTION_KEY         (operator-managed env var; primary)     │
│  DATA_ENCRYPTION_KEY_PREVIOUS (optional; only set during rotation)   │
│     │                                                                 │
│     │  HKDF-SHA256 (existing getEncryptionKey in encryption.ts)      │
│     ▼                                                                 │
│  LAYER 1 — GLOBAL KEK   (256-bit, cached per key generation)         │
│     │                                                                 │
│     │  AES-256-GCM(iv, base64(DEK_bytes))                            │
│     ▼                                                                 │
│  LAYER 2 — PER-TENANT DEK (32 bytes per Tenant row)                  │
│  Stored wrapped on Tenant.encryptedDek                               │
│  Unwrapped at request time, cached in the tenant-key-manager         │
│     │                                                                 │
│     │  AES-256-GCM (called inside the Prisma middleware)             │
│     ▼                                                                 │
│  LAYER 3 — FIELD CIPHERTEXT (every manifest field)                   │
│    Written to the same column as the plaintext used to live          │
│    Envelope: 'v1:' (global KEK, legacy)                              │
│             'v2:' (tenant DEK, Epic B.2+)                            │
└──────────────────────────────────────────────────────────────────────┘
```

| Layer | Module | What it owns |
|---|---|---|
| 0 root secret | env / operator | `DATA_ENCRYPTION_KEY` (+ optional `_PREVIOUS`) |
| 1 global KEK | `src/lib/security/encryption.ts` | HKDF derivation, `encryptField`/`decryptField` (v1), `encryptWithKey`/`decryptWithKey` (v2) |
| 2 per-tenant DEK | `src/lib/security/tenant-keys.ts` + `tenant-key-manager.ts` | DEK generation, wrap/unwrap, in-memory cache |
| 3 field ciphertext | `src/lib/db/encryption-middleware.ts` | Prisma `$use` hook; transparent encrypt-on-write + decrypt-on-read; manifest-driven |

## Environment variables

| Variable | Required | Default | When to set |
|---|---|---|---|
| `DATA_ENCRYPTION_KEY` | **REQUIRED** in production (≥32 chars). Dev: dev-fallback + WARN log. Test: dev-fallback (silent). | — | Production boot exits 1 if missing, too short, or equal to the dev-fallback string. Three independent checks — zod schema (`src/env.ts`), startup hook (`src/instrumentation.ts` + `scripts/worker.ts` + `scripts/scheduler.ts`), and Compose `:?error` syntax — each refuses to start the process. Set once in every prod environment, identical across replicas, distinct between staging and prod. |
| `DATA_ENCRYPTION_KEY_PREVIOUS` | Optional (≥32 chars) | unset | Set ONLY during a master-key rotation. When set, `decryptField` tries primary, then falls back to previous on auth-tag failure. **Remove when `GET /api/admin/key-rotation` reports `previousKeyRetirable: true`** — NOT when "v1 rows reach zero", which never happens (a re-encrypted value is still `v1:`). |

`AUTH_TEST_MODE` / `RATE_LIMIT_ENABLED` don't affect the encryption layer directly — they gate the Epic A middleware this system integrates with.

## What is encrypted

**Manifest:** `src/lib/security/encrypted-fields.ts` (`ENCRYPTED_FIELDS`).
14 models / 32 fields — business-content narratives (Finding.description, Risk.treatmentNotes, PolicyVersion.contentText, etc.). See the module's JSDoc for the full list + philosophy.

**Also encrypted by the legacy PII middleware** (`src/lib/security/pii-middleware.ts`): email, name, phone, OAuth tokens, MFA secrets. Epic B leaves that layer untouched.

**Deliberately NOT encrypted** (see manifest comments for reasoning):

| Field class | Why plaintext |
|---|---|
| `Risk.description` / `Policy.description` / `Evidence.content` | Searched via `contains` LIKE in their repositories. Moving them requires a product decision to drop substring search. |
| Titles, statuses, categories, enums, dates, FKs, numbers | Load-bearing for filters, indexes, dashboards |
| `AuditLog.*` | Hash-chained immutability — encryption would break `entryHash` |
| `Tenant`, `User`, `Framework`, `Clause`, `ControlTemplate`, `PolicyTemplate`, etc. | Global / non-tenant / no breach value |
| `*Json` columns | Queryable JSON; structured keys would need per-key encryption |

## Deployment order

The system tolerates mixed state at every stage. A given environment can sit at any step for days without ill effect — only the forward progress matters.

```
  1. Ship the schema + primitives + middleware code (Epic B.1 foundation).
        ▶ The encryption middleware is installed. No data changes yet.

  2. Run the plaintext backfill to encrypt existing rows:
        npx tsx scripts/encrypt-existing-data.ts              # dry-run
        npx tsx scripts/encrypt-existing-data.ts --execute     # write
     Produces v1 ciphertext under the global KEK for every
     plaintext manifest field in the database.

  3. Ship the tenant-DEK layer (Epic B.2):
        Tenant.encryptedDek column, tenant-keys.ts, tenant-key-manager.ts
        `/api/auth/register` generates + wraps a DEK inline via
        `generateAndWrapDek()` and writes it on the same `tx.tenant.create`
        call that opens the atomic registration transaction — it cannot
        call `createTenantWithDek` directly because that helper uses the
        singleton Prisma client and can't join a transaction. (This
        mirrors `createTenantWithOwner` in
        `src/app-layer/usecases/tenant-lifecycle.ts`, the platform-admin
        bootstrap path, which replicates the same `generateAndWrapDek()` +
        `tx.tenant.create` pattern for the same reason.) The DEK cache is
        not primed at signup; it unwraps lazily on first use, same as any
        other tenant.
        middleware emits v2 once a tenant context carries a DEK.

  4. Backfill tenant DEKs for any tenants that existed before step 3:
        npx tsx scripts/generate-tenant-deks.ts              # dry-run
        npx tsx scripts/generate-tenant-deks.ts --execute     # write
     Idempotent (NULL filter). The lazy-init path in
     tenant-key-manager catches anything the script misses.

  5. Operate in steady state.
        New writes from authenticated API requests → v2 (tenant DEK)
        New writes from seed / system / cross-tenant sweeps → v1 (global KEK)
        Reads dispatch per-value on envelope prefix.

  6. Periodic master-KEK rotation (Epic B.3):
        a. CHECK /api/readyz capabilities.lookupKey.pinned == true.
           While false the lookup hash still derives from the KEK and
           rotating it breaks every lookup by email, SILENTLY. See the
           banner in CLAUDE.md.
        b. Generate the NEW key material.
        c. Deploy with
              DATA_ENCRYPTION_KEY=<new>
              DATA_ENCRYPTION_KEY_PREVIOUS=<old>
           Dual-KEK fallback keeps all reads working.
        d. ONE platform call does the whole rotation:
              POST /api/admin/key-rotation      (repeat until remaining == 0)
           It sweeps both encryption manifests AND re-wraps every tenant
           DEK. The per-tenant route is NOT needed for a master rotation —
           it needs a tenant admin session per tenant, which an operator
           holding a platform key has no reason to have.
        e. GET /api/admin/key-rotation -> previousKeyRetirable == true,
           THEN deploy with DATA_ENCRYPTION_KEY_PREVIOUS unset.
           Do NOT use "zero v1 rows" as the condition — see below.
```

## Runbooks

### Deploying the middleware

The middleware auto-registers at Next.js startup via
`src/lib/prisma.ts` (for the web process) and `scripts/worker.ts` (for
the BullMQ worker). No manual wiring per route. Install order is
`PII → soft-delete → audit → RLS tripwire`; the Epic B encryption
middleware is installed alongside.

Sanity check after deploy:

```bash
npx jest tests/integration/tenant-dek-schema.test.ts
npx jest tests/unit/encryption-middleware.test.ts
```

Both should be green. Any red here means either a schema mismatch
(re-run migrations) or a broken `DATA_ENCRYPTION_KEY` env (check
the startup logs for "Using development fallback encryption key").

### Encrypting existing data

```bash
# 1. Dry-run to preview scope.
npx tsx scripts/encrypt-existing-data.ts
#    Prints per-model / per-field counts, verifies zero errors.

# 2. Execute, with verify.
npx tsx scripts/encrypt-existing-data.ts --execute --verify
#    The --verify flag roundtrip-decrypts every written row so a
#    mis-configured key fails loudly instead of silently writing
#    unreadable ciphertext.

# 3. Confirm zero remaining plaintext:
#    (run inside psql / Prisma Studio against the live DB)
SELECT COUNT(*) FROM "Risk"
  WHERE "treatmentNotes" IS NOT NULL
    AND "treatmentNotes" NOT LIKE 'v1:%'
    AND "treatmentNotes" NOT LIKE 'v2:%';
-- Expected: 0
```

Rerun is safe — idempotent via the `NOT LIKE 'v1:%'` SELECT filter.

### Backfilling tenant DEKs

```bash
npx tsx scripts/generate-tenant-deks.ts                 # dry-run
npx tsx scripts/generate-tenant-deks.ts --execute        # write
```

Verify:

```sql
SELECT COUNT(*) FROM "Tenant" WHERE "encryptedDek" IS NULL;
-- Expected: 0 after the run.
```

### Rotating keys safely

Pre-flight:
- [ ] **`GET /api/readyz` reports `capabilities.lookupKey.pinned: true`.** While it is false the
      lookup hash still derives from `DATA_ENCRYPTION_KEY`, and rotating it makes every lookup by
      email MISS — sign-in reports no such user, reset/invite/SCIM stop matching, and registration
      silently creates duplicates. Fix by setting `LOOKUP_HMAC_KEY` to the material
      `DATA_ENCRYPTION_KEY` holds *today* (the same bytes, not a new secret) and restarting.
- [ ] New `DATA_ENCRYPTION_KEY` generated (`openssl rand -base64 48`).
- [ ] The new key in env AND the old key as `DATA_ENCRYPTION_KEY_PREVIOUS`.
      (One VM, one `app` container — `deploy/apply.sh`, not a rolling restart. Note Watchtower
      recreates containers with the EXISTING env, so an image pull alone does NOT load a new
      variable.)
- [ ] Restart completed; `/api/readyz` still `ready`.

**Global columns first** — `User`, `Account` and the whole PII manifest have no tenant to be
scoped by, and the per-tenant job below cannot see them:

```bash
# repeat until .remaining is 0
curl -sX POST -H "X-Platform-Admin-Key: $PLATFORM_ADMIN_API_KEY" \
  https://app.agrent.bg/api/admin/key-rotation | jq '{rewritten:.totalRewritten, remaining, errors:.totalErrors}'

# the completion signal — this is the condition for retiring the previous key
curl -s -H "X-Platform-Admin-Key: $PLATFORM_ADMIN_API_KEY" \
  https://app.agrent.bg/api/admin/key-rotation | jq '{remaining, previousKeyRetirable}'
```

`--data '{"only":[{"model":"Account","column":"accessTokenEncrypted"}]}'` narrows a pass, e.g. to
move third-party OAuth credentials first and watch them finish. A filtered run's `remaining: 0` is
a claim about those columns only, which is why the response carries `filtered` — and a filtered
pass deliberately does NOT touch DEKs, because a filter names manifest columns and a wrapped DEK
is not one.

**The wrapped tenant DEKs are counted in the verdict, and that is load-bearing.**
`Tenant.encryptedDek` holds a per-tenant DEK wrapped by `wrapDek` — which is `encryptField`, so a
`v1:` envelope under the master KEK — but it is in NEITHER encryption manifest, because it is key
material rather than a business field. The column union therefore does not reach it, and an earlier
version of this endpoint would answer `previousKeyRetirable: true` while every DEK was still
wrapped under the OLD key. Removing the previous key on that signal makes every DEK unwrappable and
every `v2:` ciphertext unreadable. `remaining` is now `columnsRemaining + unwrappedDeks`, and the
response reports both so "columns done, DEKs outstanding" is distinguishable from the reverse.

An unfiltered pass re-wraps them. The DEK BYTES do not change — only the wrap — so it is invisible
to every reader and safe to re-run.

Per tenant — **not needed for a master-KEK rotation**, kept for a single-tenant operation:

```bash
curl -X POST \
  -H "Cookie: <admin session>" \
  https://app.agrent.bg/api/t/<tenantSlug>/admin/key-rotation
```

Response `202 Accepted` with a `jobId`. Poll state:

```bash
curl -H "Cookie: <admin session>" \
  "https://app.agrent.bg/api/t/<tenantSlug>/admin/key-rotation?jobId=<id>"
```

Success looks like:

```json
{
  "jobId": "...",
  "state": "completed",
  "result": {
    "dekRewrapped": true,
    "totalScanned": 1247,
    "totalRewritten": 1247,
    "totalErrors": 0
  }
}
```

Post-flight:
- [ ] **`GET /api/admin/key-rotation` reports `previousKeyRetirable: true`** (and `filtered: false`).
      Any non-zero `remaining` is a value that does not decrypt under the new key — either still on
      the old one, or corrupt. Removing the previous key with work outstanding loses data.
- [ ] Remove `DATA_ENCRYPTION_KEY_PREVIOUS` from env.
- [ ] Rolling restart.
- [ ] Verify smoke-test reads still work.
- [ ] Archive the old key material per your key-rotation policy.

### Key-compromise incident response

If `DATA_ENCRYPTION_KEY` is suspected compromised:

1. **Do NOT delete the old key** — you need it to read existing ciphertext.
2. Generate a new key. Deploy with new=primary, compromised=previous.
3. Run `POST /api/t/{slug}/admin/key-rotation` for every tenant.
4. When all report zero remaining v1 under the old key, remove the old key from env.
5. Audit `AuditLog` for the rotation window — hash-chained integrity confirms nobody tampered with the trail during the incident.

## Observability signals

Grep the structured log stream for these keys when troubleshooting:

| Log key | Source | Meaning |
|---|---|---|
| `encryption-middleware.decrypt_failed` | middleware | A single field couldn't decrypt. Fields: `model`, `field`, `version`, `reason`. Never contains plaintext or DEK bytes. |
| `encryption-middleware.dek_resolve_failed` | middleware | `getTenantDek(tenantId)` threw — tenant not found or DB error. |
| `tenant-key-manager.tenant_created_with_dek` | key manager | New tenant received a DEK on creation. |
| `tenant-key-manager.dek_backfilled` | key manager | `ensureTenantDek` wrote a DEK for a previously-NULL tenant (usually from the backfill script or lazy init). |
| `tenant-key-manager.dek_backfill_raced` | key manager | Two writers concurrently tried to backfill; the loser's UPDATE was a no-op. Not an error — expected under concurrency. |
| `key-rotation.complete` | rotation job | Rotation finished for a tenant. Includes totalScanned / totalRewritten / totalErrors / durationMs / jobRunId. |
| `key-rotation.decrypt_failed` | rotation job | A specific v1 row couldn't decrypt. If both KEKs are configured and this fires, the row may be corrupt or encrypted with a completely unrelated key. |
| `key-rotation.update_failed` | rotation job | A specific v1 row's UPDATE blew up (DB transient, likely). Counted as an error; batch continues. |
| `AUTH`-prefixed `AuditLog` rows | audit writer | `KEY_ROTATION_INITIATED` / `KEY_ROTATION_STARTED` / `KEY_ROTATION_COMPLETED` — the hash-chained audit trail for who fired rotation when. |

## Rollback procedure

| Layer | Rollback |
|---|---|
| Middleware | Uninstall: remove the `registerEncryptionMiddleware(prisma)` call from `src/lib/prisma.ts` / `src/instrumentation.ts`. Restart. Existing ciphertexts stay on disk; app treats them as opaque strings. Decrypt-on-read is lost but data isn't destroyed. |
| Plaintext backfill | Irreversible without the KEK + a reverse script. In practice: don't. |
| Tenant-DEK column | `ALTER TABLE "Tenant" DROP COLUMN "encryptedDek"` — safe but deprecates every v2 ciphertext (they require the wrapped DEK). Only sensible if you immediately re-encrypt everything as v1. |
| Rotation in flight | Remove `DATA_ENCRYPTION_KEY_PREVIOUS` before completing the job ⇒ partially-rotated tenants can't read rows written under the old KEK. **Never** remove the previous key mid-rotation. |
| Failed rotation | The job's `attempts: 1` policy means no auto-retry. Re-enqueue manually after diagnosing the per-tenant error. Re-running is SAFE but **not a no-op**: see the next row. |
| "already-rewritten rows are skipped" | **FALSE, and this row used to assert it.** `encryptField` emits a `v1:` envelope, so a re-encrypted value is still `v1:` and `LIKE 'v1:%'` matches it again on every run. A re-run re-encrypts everything (same plaintext, fresh IV — harmless, but it is work). More importantly it means **"zero v1 rows remain" is a count that never reaches zero**, so it cannot be the condition for removing the previous key. Use `GET /api/admin/key-rotation` → `previousKeyRetirable`, which is derived from whether each value decrypts under the PRIMARY key (`isV1UnderPrimaryKey`). |
| The per-tenant job alone | Does **not** finish a rotation. It iterates `ENCRYPTED_FIELDS` and does `if (!hasTenantId) continue`, so `User`, `Account` and the entire PII manifest (`PII_FIELD_MAP`) are invisible to it. Measured on production 2026-10-02: it could re-encrypt **0** values while **40** sat in the PII manifest, including six OAuth access tokens and six refresh tokens. Run `POST /api/admin/key-rotation` as well. |

## Remaining non-blocking caveats

1. **`AuditLog` is not encrypted.** It carries the hash-chained integrity contract; encrypting the fields would break `entryHash` and our immutability trigger. Investigation needs plaintext audit entries anyway.

2. **Per-tenant DEK rotation is not yet implemented.** Master-KEK rotation is shipped; rotating a tenant's DEK (generating new DEK, re-encrypting every v2 ciphertext for that tenant) requires a schema column to hold old + new DEKs atomically. Deferred.

3. **Raw-SQL paths bypass the middleware.** Seeds, backfill scripts, and `$queryRawUnsafe` calls see on-disk ciphertext. This is intentional (the backfill scripts rely on it) but means debugging against a Prisma Studio session will show ciphertext for encrypted columns on production-like databases.

4. **Search on encrypted fields is not supported.** `Risk.description`, `Policy.description`, and `Evidence.content` are deliberately excluded from the manifest because their repositories use `contains` search. Moving them requires dropping substring search — a product decision, not a technical one.

5. **Key material lives in process memory.** The per-tenant DEK cache is an in-memory Map. A hostile coredump / debugger attach could lift key material. Same posture as the cached KEK in `encryption.ts`. Hardening (memzero on eviction, KMS-backed unwrap) is a future concern.

6. **Multi-replica DEK cache is NOT shared.** Each replica maintains its own `tenantId → Buffer` map. On a rotation, `clearTenantDekCache` runs on the replica that executed the job; other replicas' caches stale until TTL or restart. **Mitigation:** rolling restart after rotation completes, OR call the admin API endpoint on each replica if strict cache coherence is required. In practice the staleness window produces identical DEK bytes (rotation doesn't change the DEK, only the wrapping) so there's no correctness issue.

## Testing map

| Test | What it guarantees |
|---|---|
| `tests/unit/encryption-middleware.test.ts` (29) | Manifest, write path, read path, nested relations, idempotency, null/empty safety |
| `tests/unit/encryption-middleware.perf.test.ts` (11) | Measured perf budget: <50ms for 100-row list, <120ms with 1000 nested nodes, <20% overhead vs raw AES-GCM |
| `tests/unit/encryption-middleware.tenant-dek.test.ts` (21) | Tenant-DEK write/read, v1/v2 dispatch, cross-tenant isolation, bypass-source fallback, recursion guard |
| `tests/unit/encryption-dual-key.test.ts` (9) | Dual-KEK fallback during master-key rotation, three-generation round-trip |
| `tests/unit/tenant-keys.test.ts` (20) | DEK primitives: generate/wrap/unwrap, round-trip, length + privacy invariants |
| `tests/unit/tenant-key-manager.test.ts` (13) | Runtime layer: createTenantWithDek, ensureTenantDek, getTenantDek, LRU cache |
| `tests/unit/encrypt-existing-data.test.ts` (15) | Plaintext-backfill script: batch loop, dry-run, error isolation, privacy logging |
| `tests/unit/generate-tenant-deks.test.ts` (9) | Tenant-DEK backfill script: idempotency, dry-run, race loss, no DEK in logs |
| `tests/unit/key-rotation-job.test.ts` (9) | Rotation job: DEK re-wrap, v1 re-encrypt, per-row error isolation, audit bookends |
| `tests/unit/key-rotation-admin-api.test.ts` (8) | Admin API: ADMIN gate, enqueue, rate-limit preset, cross-tenant 404 guard |
| `tests/integration/tenant-dek-schema.test.ts` (5) | Live DB: schema shape, round-trip, rotation-ready UPDATE |
| `tests/integration/epic-b-encryption.test.ts` (6) | **End-to-end**: register → write → raw-SQL ciphertext on disk → plaintext read → cross-tenant fails → rotate → read still works |

**Total Epic B: 155 tests across 12 suites. Typecheck + lint clean.**

---

# Detail relocated from CLAUDE.md (2026-10-06)

CLAUDE.md is loaded in full on every session, and this section had grown to 262
lines — roughly 3,800 tokens paid on every session and inherited by every
subagent. Its own last line already said "See `docs/epic-b-encryption.md`", so
the summary-plus-pointer shape was the intent; the section had simply outgrown
it.

Nothing here was deleted. CLAUDE.md keeps every RULE as an imperative; what
follows is the reasoning, the incident history and the mechanism detail that
explains why those rules exist. **Read this before changing anything in
`src/lib/security/encrypted-fields.ts` or the Prisma extension** — the rules in
CLAUDE.md are the what, and this is the why, and the why is what stops someone
re-introducing a defect the rule was written to prevent.

Business-content fields (Task.description, Task.resolution,
TaskComment.body, ParcelLease.lessorName, FarmProfile.egn,
Contract.terms, …) are encrypted at
rest by a Prisma `$extends({ query })` client extension (migrated
from the Prisma 5 `$use` middleware, which Prisma 7 removed — see
`src/lib/prisma.ts`). The manifest lives in
`src/lib/security/encrypted-fields.ts`; **never** add or remove
encrypted columns outside it. Add a model here ⇒ its manifest
fields encrypt on every write and decrypt on every read
transparently.

**That sentence was ASPIRATIONAL until 2026-10-02 (#1222), and the
gap is worth knowing about because it will rhyme.** The middleware
resolved a model absent from the manifest to `'*'`, and the `'*'`
branch matches field NAMES across the whole manifest without being
able to tell models apart — so 18 `(model, field)` pairs were
encrypted by collision rather than by decision.
`ExchangeListing.description` was encrypted because `Task`,
`AccessReview` and `CostEntry` each declare a `description`: three
unrelated models deciding a fourth model's fate. The visible symptom
was that an Exchange message recipient read `v2:…` instead of the
message — two tenants, one tenant's DEK — but the cause was generic
and the blast radius was 18 columns, not one.

The write and read paths now pass the REAL model, so an undeclared
field is simply not encrypted; `'*'` survives only for its documented
purpose, a node whose model is structurally unknowable. **Which means
the rule above is now enforced rather than hoped for.**

Two consequences for anyone touching this:

- **A field that carries a manifest field NAME but should stay
  plaintext goes in `DELIBERATELY_PLAINTEXT`** (same file), keyed
  `Model.field` — per FIELD, not per model, because a model can carry
  two manifest-named fields wanting different answers. Each entry
  needs a written reason; `tests/guards/deliberately-plaintext-is-honest.test.ts`
  enforces no stale entries, no contradiction with `ENCRYPTED_FIELDS`,
  and that the field is genuinely at risk.
- **Narrowing stops DECRYPTION too, so order matters.** Declaring a
  field must land in the same change as (or before) any narrowing —
  a field left undeclared with ciphertext in it becomes unreadable to
  everyone, with no error and no log. Measure first:
  `npm run preflight:fanout` counts `v1:` AND `v2:` per affected pair,
  derived from the manifest × schema rather than listed. It counts
  both envelopes deliberately — `FeatureFlag.description` held a `v1:`
  row, so a "misplaced v2" check would have missed it.

Key hierarchy: `DATA_ENCRYPTION_KEY` (master KEK) wraps a per-tenant
DEK on `Tenant.encryptedDek`. New tenants get a DEK at creation via
`createTenantWithDek` (from `src/lib/security/tenant-key-manager.ts`);
existing tenants get one via `scripts/generate-tenant-deks.ts`.
Ciphertexts carry `v1:` (global KEK, legacy) or `v2:` (per-tenant
DEK) envelope — the middleware dispatches per-value on read.

**GAP-03 — production fail-fast.** The master KEK is REQUIRED in
production. Three independent checks each refuse to start a prod
process whose `DATA_ENCRYPTION_KEY` is missing, shorter than 32
chars, or equal to the documented dev fallback:

  1. zod schema in `src/env.ts` — fires at module load, `superRefine`
     on the field reads `process.env.NODE_ENV` directly.
  2. startup hook in `src/instrumentation.ts` (web) +
     `scripts/worker.ts` (BullMQ worker) + `scripts/scheduler.ts`
     (deploy-time scheduler) — exits 1 with `[startup] FATAL: …`.
     All three surfaces run BOTH halves — the config check and the
     encrypt → decrypt sentinel. (The scheduler used to run only the
     config check while the worker ran both, with nothing saying why;
     #698 collapsed the two standalone entrypoints onto one shared
     gate, so there is now one answer instead of two undocumented ones.)
     **The sentinel cannot fail for the reason its docblock used to
     give** — measured: every key clearing the 32-char floor
     round-trips, because `deriveKey` is HMAC-SHA256 over
     `Buffer.from(raw,'utf8')`, which never throws. It is a
     forward-looking guard on a future derivation that CAN throw, not
     live defence. See the docblock in `startup-encryption-check.ts`.
     The two standalone entrypoints share ONE awaited gate —
     `assertProductionEncryptionReady` in `@/lib/security/startup-gate`
     (`scripts/worker.ts`, `scripts/scheduler.ts`) — which is the one
     place THEIR `NODE_ENV === 'production'` decision and both halves
     live. `src/instrumentation.ts` was never migrated onto it and never
     needed to be: `register()` is async and has awaited
     `checkProductionEncryptionKey` + `runEncryptionSentinel` inline all
     along, so the web tier never had the #698 bug — it still spells its
     own `NODE_ENV === 'production'` branch, and the guardrail checks it
     by those two helper names rather than by the gate. Until
     #698 the two standalone entrypoints ran the check in a
     **non-awaited async IIFE**, so the worker was subscribed to its
     queues and the scheduler mid-registration by the time `FATAL`
     printed. `scripts/worker.ts` therefore has a real `main()`:
     nothing constructs a `Worker` (which is what subscribes) until the
     gate and the runtime bootstrap have both resolved. The structural
     guardrail asserts `await`, not merely presence — `void`-ing the
     call is the defect and is invisible to a presence check; the
     ordering itself is asserted behaviourally by spawning the real
     processes.
  3. Compose `:?error` syntax in **every manifest that carries the
     key** — `docker-compose.prod.yml`, `docker-compose.staging.yml`,
     `deploy/docker-compose.prod.yml` AND `deploy/docker-compose.vm.yml`
     (the one the live agrent stack actually runs, absent from this
     list until 2026-08-21). Aborts container start before the app
     process is spawned. `docker-compose.yml` and
     `docker-compose.test.yml` pass no key at all, so the rule does
     not apply to them — the guard derives that from content rather
     than from a list of "production" filenames.

Dev gets the in-source fallback key (`encryption-constants.ts`) with
a WARN log on every server start; test gets the same fallback
silently. The fallback is well-known + refused in prod, not secret.
The runtime + structural enforcement is unit-tested in
`tests/unit/security/startup-encryption-check.test.ts` +
`tests/unit/env.test.ts`, and the wiring across all five surfaces
is locked by `tests/guardrails/encryption-key-enforcement.test.ts`.
Those cover the LOGIC and the SOURCE TEXT. What actually boots a
process with a bad key and watches it die is
`tests/unit/security/startup-fail-fast-execution.test.ts` — child
processes for all three Node surfaces, plus a real `docker compose
config` for the Compose layer (docker-gated, with a visible skip
banner and `STARTUP_GUARD_REQUIRE_DOCKER=1` to make absence a
failure). Until #674 only check 1 had ever executed.

Master-KEK rotation: set `DATA_ENCRYPTION_KEY_PREVIOUS` alongside
the new primary. `decryptField` falls back transparently. **It takes
TWO sweeps, and the per-tenant one alone does not finish a rotation.**

`POST /api/t/{slug}/admin/key-rotation` enqueues the background job in
`src/app-layer/jobs/key-rotation.ts`, which re-wraps that tenant's DEK
and re-encrypts its `v1:` ciphertexts. It iterates `ENCRYPTED_FIELDS`
and does `if (!hasTenantId) continue`, so `User`, `Account` and the
ENTIRE PII manifest (`PII_FIELD_MAP` in `pii-middleware.ts`) are
invisible to it — a second encryption manifest it has never
referenced. Measured on production 2026-10-02: it could re-encrypt
**0** values while **40** `v1:` values sat in the PII manifest,
including six OAuth access tokens and six refresh tokens.

`POST /api/admin/key-rotation` (platform-key gated) covers the union
of both manifests, with no tenant filter — a `v1:` envelope IS the
master-KEK envelope — AND re-wraps every tenant DEK. So one platform
call finishes a master rotation and the per-tenant route is not needed
for one (it requires a tenant admin session per tenant, which an
operator holding a platform key has no reason to have). Call it until
`remaining` is 0; `only` narrows a pass to named columns and then
deliberately skips the DEKs.

**`Tenant.encryptedDek` is master-KEK ciphertext in NEITHER manifest.**
`wrapDek` is `encryptField`, so a wrapped DEK is a `v1:` envelope, but
it is key material rather than a business field and the manifest union
does not reach it. An earlier version of the endpoint therefore reported
`previousKeyRetirable: true` with every DEK still on the old key —
removing the previous key then makes every DEK unwrappable and every
`v2:` ciphertext unreadable. `remaining` is now
`columnsRemaining + unwrappedDeks`.

**Do NOT use "zero `v1:` rows" as the stop condition** — this
paragraph said to, and it is unreachable. `encryptField` emits a `v1:`
envelope, so a re-encrypted value is still `v1:` and `LIKE 'v1:%'`
matches it on every run; the count never falls to zero and
`key-rotation.ts`'s matching idempotency claim is false for the same
reason. The measurable condition is
`GET /api/admin/key-rotation` → `previousKeyRetirable`, derived from
whether each value decrypts under the PRIMARY key
(`isV1UnderPrimaryKey`). Only then remove
`DATA_ENCRYPTION_KEY_PREVIOUS`.

Full runbook: `docs/epic-b-encryption.md`.

> **⚠️ ROTATING `DATA_ENCRYPTION_KEY` IS SAFE ONLY WHILE
> `LOOKUP_HMAC_KEY` IS PINNED. Check `/api/readyz` first — not this
> paragraph.** P1.1 shipped the mechanism; whether it is ACTIVE is a
> per-deployment fact, and the two are easy to confuse.
>
> `capabilities.lookupKey.pinned` on `/api/readyz` is the answer:
>
> - **`true`** — the lookup hash derives from `LOOKUP_HMAC_KEY`, which stays
>   put while the KEK moves. Rotate with `DATA_ENCRYPTION_KEY_PREVIOUS` + the
>   sweep as described above; every `User.emailHash` keeps resolving and
>   nothing needs rehashing. Proved end to end by
>   `tests/integration/kek-rotation-login.test.ts`, which also reproduces the
>   damage with the key unpinned so the positive half cannot pass for free.
> - **`false`** — the key is BOOTSTRAPPED off `DATA_ENCRYPTION_KEY`, which is
>   the pre-P1.1 behaviour, so **the hazard below is live and the master KEK is
>   un-rotatable.** The fix is one environment variable, not a code change: set
>   `LOOKUP_HMAC_KEY` to the material `DATA_ENCRYPTION_KEY` holds **today** —
>   the same bytes, not a new secret — and restart. Setting it is inert until a
>   rotation happens, so it is safe to do at any time.
>
> **What goes wrong when it is unpinned**, because the failure is silent and
> worth knowing by heart. `hashForLookup` HMACs with a key derived from the
> material it is given, and the rotation job re-wraps DEKs and re-encrypts
> `v1:` ciphertexts — it contains **zero** references to `hashForLookup` or
> `emailHash` (verified 2026-10-02). A hash has no authentication failure to
> trigger a previous-key fallback, so a wrong key does not error; the lookup
> simply MISSES:
>
> - sign-in reports no such user;
> - password reset, email verification, invite redemption and SCIM matching
>   all fail to find existing accounts;
> - **registration SUCCEEDS and creates a DUPLICATE `User`**, because its
>   uniqueness check is the same `emailHash` that now misses — and the
>   `@unique` constraint is on the hash, so the database does not refuse it
>   either. That is silent data corruption, not an outage, and it is the
>   expensive half.
>
> Sixteen files look a user up by `emailHash` (`src/auth.ts`,
> `credentials.ts`, `password-management.ts`, `email-verification.ts`,
> `invite-redemption.ts`, `scim-users.ts`, `tenant-invites.ts`,
> `org-invites.ts`, `tenant-lifecycle.ts`, `sso.ts`, the register and
> resend routes, and others) — and they do it THEMSELVES, passing
> `emailHash: hashForLookup(email)` straight through. That matters:
> `src/lib/security/pii-middleware.ts` rewrites a plain `where: { email }` to
> the hash column and is the rotation-safe path, but those sixteen never hand
> it a plain field, so the middleware never sees them. Both populations are
> affected by a KEK rotation (they derive from the same material); only the
> middleware one is covered by the previous-key widening below.
> `tests/guards/lookup-hash-call-sites-registered.test.ts` classifies all of
> them and fails on a new one.
>
> **Rotating the LOOKUP key itself is a different, harder event.** Set
> `LOOKUP_HMAC_KEY_PREVIOUS` and READS resolve under either key —
> `hashForLookupCandidates` widens the predicate to `{ in: [...] }`, and
> `pii-middleware` downgrades `findUnique` to `findFirst` when it does, because
> Prisma rejects an `in` in a unique where. WRITES addressed by a unique where
> (`update` / `delete` / `upsert`) use the **primary alone**, so a row not yet
> rehashed is briefly not addressable BY EMAIL for those.
>
> **And the sixteen explicit call sites get no widening at all**, because they
> never pass a plain field — so during a LOOKUP-key rotation a sign-in, a reset
> and the registration uniqueness check all read the primary hash only and miss
> any row not yet rehashed. Converting them to `hashForLookupCandidates` is
> part of **P1.3** alongside the rehash sweep; the registry guard above is the
> shrinking list. Until both land, treat a lookup-key rotation as unfinished
> business and a KEK rotation as the supported one. A KEK rotation is
> unaffected by any of this: the lookup key does not move, so no hash changes
> and no fallback is wanted.
>
> **A new identifier kind gets its OWN HKDF info string; an existing one's is
> frozen.** `LOOKUP_INFO` in `encryption.ts` maps `email` to the original
> `inflect-data-lookup-hash`, and that inconsistency is load-bearing — every
> stored `User.emailHash` and `UserIdentityLink.emailAtLinkTimeHash` was
> computed with it. Renaming it is a REHASH, not an edit.

Per-tenant DEK rotation (generating a fresh DEK for a single
compromised tenant without touching the global KEK) is implemented
at `rotateTenantDek` in `src/lib/security/tenant-key-manager.ts`.
The admin surface is `POST /api/t/:slug/admin/tenant-dek-rotation`,
gated by `admin.tenant_lifecycle` (OWNER-only). The flow:
atomic UPDATE moves the old wrapped DEK into
`Tenant.previousEncryptedDek` and writes a fresh wrapped DEK to
`Tenant.encryptedDek`; the response is 202 + a job id for the
`tenant-dek-rotation` BullMQ sweep that re-encrypts every v2
ciphertext under the new DEK and clears `previousEncryptedDek` on
completion. Mid-flight reads remain correct via
`decryptWithKeyOrPrevious` in the encryption layer — primary first,
fall back to previous on AES-GCM auth failure. The per-tenant DEK
fallback is locked in by
`tests/guardrails/tenant-dek-rotation-fallback.test.ts`.

**See `docs/epic-b-encryption.md`** for deployment order,
rotation runbook, observability signals, rollback procedure, and
the full test coverage map.
