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
| `DATA_ENCRYPTION_KEY_PREVIOUS` | Optional (≥32 chars) | unset | Set ONLY during a master-key rotation. When set, `decryptField` tries primary, then falls back to previous on auth-tag failure. **Remove after the rotation job reports zero remaining v1 rows.** |

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
        a. Generate the NEW key material.
        b. Deploy with
              DATA_ENCRYPTION_KEY=<new>
              DATA_ENCRYPTION_KEY_PREVIOUS=<old>
           Dual-KEK fallback keeps all reads working.
        c. Per tenant, trigger rotation:
              POST /api/t/{tenantSlug}/admin/key-rotation
           The background job re-wraps the tenant DEK + re-encrypts
           any remaining v1 ciphertexts under the new KEK.
        d. When every tenant reports zero v1 rows remaining,
           deploy with DATA_ENCRYPTION_KEY_PREVIOUS unset.
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
- [ ] New `DATA_ENCRYPTION_KEY` generated (`openssl rand -base64 48`).
- [ ] Both replicas have the new key deployed in env AND the old key as `DATA_ENCRYPTION_KEY_PREVIOUS`.
- [ ] Rolling restart completed; smoke-test reads/writes still work.

Per tenant:

```bash
curl -X POST \
  -H "Cookie: <admin session>" \
  https://inflect.example.com/api/t/<tenantSlug>/admin/key-rotation
```

Response `202 Accepted` with a `jobId`. Poll state:

```bash
curl -H "Cookie: <admin session>" \
  "https://inflect.example.com/api/t/<tenantSlug>/admin/key-rotation?jobId=<id>"
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

Post-flight, once every tenant is rotated:
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
| Failed rotation | The job's `attempts: 1` policy means no auto-retry. Re-enqueue manually after diagnosing the per-tenant error. The job is idempotent: already-rewritten rows match `NOT LIKE 'v1:%'` on a second run and are skipped. |

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
