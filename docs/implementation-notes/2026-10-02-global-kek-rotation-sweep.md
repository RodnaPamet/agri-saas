# 2026-10-02 — the global master-KEK sweep: making `DATA_ENCRYPTION_KEY_PREVIOUS` retirable

**Commit:** `<sha> feat(security): sweep the GLOBAL-key columns so the previous KEK can be retired`

P1.1 made the master KEK rotatable. This makes a rotation *finishable*, which
turns out to be a different and unmet claim.

## Two defects, found by measuring a real rotation plan

### 1. The rotation sweep was blind to an entire encryption manifest

`src/app-layer/jobs/key-rotation.ts` iterates `ENCRYPTED_FIELDS` and does
`if (!hasTenantId) continue`. Two populations are therefore invisible to it:

- models with no `tenantId` — `User`, `Account`;
- the **whole PII manifest** (`PII_FIELD_MAP` in `pii-middleware.ts`: `User`,
  `UserIdentityLink`, `NotificationOutbox`, `Account`), a second encryption
  manifest that file has never referenced.

Measured on production 2026-10-02, with a rotation actually pending:

| | |
| --- | --- |
| values the per-tenant job could re-encrypt | **0** |
| `v1:` values in the PII manifest | **40** — 6 user emails, 6 names, **6 OAuth access tokens, 6 refresh tokens**, 16 outbox addresses |

So a KEK rotation would have re-wrapped three DEKs and moved nothing.
`DATA_ENCRYPTION_KEY_PREVIOUS` could never be removed, and an exposed key would
have stayed able to decrypt every ciphertext in the deployment — including
third-party OAuth credentials.

### 2. "Zero v1 rows remain" is a count that never reaches zero

`encryptField` emits a `v1:` envelope, so **re-encrypting a v1 value produces
another v1 value**. `WHERE "col" LIKE 'v1:%'` matches a migrated row exactly as
it matches an unmigrated one. The existing job's documented idempotency — *"rows
already processed in a prior run are skipped by the SELECT"* — is false, and the
runbook instruction *"remove `DATA_ENCRYPTION_KEY_PREVIOUS` once every tenant
reports zero v1 rows"* names a quantity that cannot reach zero.

`decryptField` cannot answer it either: it tries the primary, falls back to the
previous, and returns the plaintext without saying which key worked.

`isV1UnderPrimaryKey` is the predicate that does. A successful decrypt under the
**primary** key means the row is already on the new key. That is what makes
progress observable and the previous key safely retirable.

## Design

```
GET  /api/admin/key-rotation   -> { remaining, previousKeyRetirable, columns[] }
POST /api/admin/key-rotation   -> one sweep pass; call until remaining === 0
```

- **Derives the union of BOTH manifests.** One sweep, one list. A sweep blind to
  a manifest is defect 1, and the only structural defence is not having a second
  list to forget.
- **Proves it can see every column before touching anything.**
  `assertSweepableColumns` queries `information_schema` and THROWS, naming what
  is missing. The existing job's `continue` on a missing `tenantId` is a skip
  indistinguishable from "nothing to do".
- **No tenant filter.** A `v1:` envelope IS the master-KEK envelope, so every v1
  value needs moving regardless of which tenant (if any) owns the row. This
  subsumes the per-tenant job's v1 work.
- **Skips values already under the primary key**, so a re-run converges and
  `remaining` means something.
- **Synchronous and batched, not a job.** An operator mid-rotation wants to see
  progress and decide when to stop; a background job's completion is one more
  thing to go and check.

## The naming trap: two manifests, two conventions

The first version of the sweep threw 42703 on its own pre-flight, and the
message named `PromotionLead.requestMessage` as a missing column. It is not
missing — it is **`@map("message")`**, and the field was named uniquely *on
purpose*: the Epic B middleware's fan-out encrypt path matches a FLAT set of
field names across the whole manifest and cannot tell which model a key belongs
to, so a manifest entry called `message` silently encrypted
`Notification.message`, `ExchangeInquiry.message` and `InsuranceLead.message`
too. The schema comment in `prisma/schema/promotions.prisma` says so.

So:

| manifest | holds |
| --- | --- |
| `ENCRYPTED_FIELDS` | **Prisma field** names (`requestMessage`) |
| `PII_FIELD_MAP.encrypted` | **physical column** names (`emailEncrypted`) |

Nothing at either call site says which. `resolvePhysical` goes through the DMMF
and accepts both spellings, failing loudly on a name that is neither.

**The existing job has this latent.** It interpolates `ENCRYPTED_FIELDS` names
straight into raw SQL. Measured: zero `@map`'d encrypted fields sit on a
tenant-scoped model, so it has never hit it — it skips `PromotionLead` for
having no `tenantId`, an unrelated reason.
`tests/guards/encrypted-manifests-resolve-to-columns.test.ts` holds that
precondition, so `@map`-ing one on a tenant-scoped model fails CI instead of
throwing mid-rotation after rows have been rewritten.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/encryption.ts` | `isV1UnderPrimaryKey`, `kekRotationInFlight` |
| `src/app-layer/usecases/global-key-rotation.ts` | The union sweep, the pre-flight, the completion count |
| `src/app/api/admin/key-rotation/route.ts` | GET the verdict, POST a pass; platform-key gated |
| `src/lib/auth/guard.ts` | Edge opening — exact entry + children prefix |
| `src/app-layer/jobs/key-rotation.ts` | Its false idempotency claim and its two blind spots, written down |
| `tests/unit/global-key-rotation-columns.test.ts` | The union, the resolution, the predicate |
| `tests/integration/global-key-rotation-sweep.test.ts` | `_PREVIOUS` is retirable — with its control |
| `tests/guards/encrypted-manifests-resolve-to-columns.test.ts` | Both manifests resolve; the `@map` precondition |
| `tests/unit/admin-key-rotation-route.test.ts` | Gate, reachability, the retirable verdict |

## Decisions

- **`isV1UnderPrimaryKey` THROWS on a `v2:` input** rather than returning false.
  A v2 ciphertext is wrapped under a per-tenant DEK; answering `false` would tell
  a sweep to migrate something it must not touch.
- **It cannot distinguish "needs the previous key" from "corrupt"**, and says so.
  A caller that goes on to decrypt finds out, because a corrupt value fails under
  both keys. For "is there work left" the two are alike.
- **Hash columns are excluded, asserted.** `emailHash` derives from
  `LOOKUP_HMAC_KEY` (P1.1), not the master KEK, so a rotation does not move it —
  which is why this sweep is a pure ciphertext migration with no rehash pass
  beside it. A test asserts no swept column ends in `Hash`, so a later
  "be thorough" change cannot add one and break every lookup by email.
- **`rotationInFlight` is reported.** A sweep run with no previous key
  configured cannot migrate anything off an old key; it re-encrypts values under
  the key they already carry and would report a `rewritten` count that reads like
  progress it is not making.
- **Deduped on the PHYSICAL pair**, not the manifest name — two manifests can
  name one column by two spellings, and sweeping it twice makes `remaining`
  disagree with reality.
- **Cursor on `id`, not `OFFSET`.** Rows are UPDATEd as the walk proceeds; an
  OFFSET walk over a changing set skips rows. The predicate does not change under
  us (a rewritten row is still `v1:`), so an ascending cursor is stable and
  complete.

## What the proofs caught

**The integration test would have passed for free.** Every positive assertion
also passes on a build where the sweep does nothing — if the test never removes
the previous key. So a third row is crafted under the old key and inserted
*after* the sweep, standing for a column the sweep missed: with `_PREVIOUS` gone
the swept rows decrypt and that one does not. Same removal, opposite outcomes,
one run.

**Three mutations, all reddening:** removing the PII manifest from the union
(10 failures), removing the already-under-primary check (1 — the convergence
test), and dropping the `@map` resolution (7). Sources md5-restored; control
21/21.

**A vacuous assertion of my own**, caught by `typecheck` rather than by thought:
`expect(result.manifestsCovered ?? [...]).toBeTruthy()` — a field I had invented,
with a fallback that made the assertion true either way. Removed rather than
weakened; the route reports manifests, the usecase does not.

**A sort assertion that was wrong about itself.** It composed two sort chains
that matched neither the implementation nor each other. Rewritten to compare
against a freshly-computed expectation.

## Follow-up, same day: the completion signal did not cover the wrapped DEKs

Caught while writing the rotation runbook, before running the rotation — which
is the only reason it was caught at all, because nothing was red.

`Tenant.encryptedDek` holds a per-tenant DEK wrapped by `wrapDek`, which is
`encryptField` — so it is a `v1:` envelope under the master KEK, unwrapped by
`decryptField` with the same dual-key fallback as any other ciphertext. But it
is in **neither** encryption manifest, because it is key material rather than a
business field, so the column union does not reach it.

The sweep as first merged therefore reported **`previousKeyRetirable: true`
while every DEK was still wrapped under the OLD key.** Acting on that signal —
removing `DATA_ENCRYPTION_KEY_PREVIOUS` — makes every DEK unwrappable and every
`v2:` ciphertext unreadable. It is the same defect this whole file exists to
fix, one level up: **a completion signal that does not cover what the decision
depends on.**

Two things were missing, not one:

- **Counting.** `remaining` is now `columnsRemaining + unwrappedDeks`, and the
  route reports both separately — "columns done, DEKs outstanding" and the
  reverse are different operator situations and a single total hides which.
- **Doing.** `jobs/key-rotation.ts` does re-wrap, but only through
  `POST /api/t/{slug}/admin/key-rotation`, which needs a tenant **admin
  session** per tenant. An operator rotating the master key holds a platform
  key and has no reason to have admin sessions for every tenant, so the
  rotation could not be completed from the surface that owns it. An unfiltered
  platform pass now re-wraps them, which makes the global endpoint a superset of
  the per-tenant job for a master rotation.

**The safety property is that the DEK BYTES do not change** — only the wrap.
Asserted by unwrapping before and after and comparing, because "it re-wrapped"
and "it re-wrapped the same key" are different claims and only the second is
safe; if the bytes moved, every `v2:` ciphertext in that tenant would be lost
while the wrap looked perfectly healthy.

A filtered pass deliberately does **not** touch DEKs: a filter names manifest
columns, a wrapped DEK is not one, and re-wrapping key material because someone
asked to sweep `User.emailEncrypted` would be a side effect they did not
request.

Mutation-proved both ways — neutering `countUnwrappedDeks` reddens the two
counting assertions (the defect itself), and re-wrapping with fresh bytes
reddens the safety property and the decisive test.

**And I walked into the shared-database aggregate problem a second time.**
`rewrapTenantDeks` has no filter, so other suites' tenants — whose DEKs are
wrapped under the dev fallback key — are correctly counted as errors, and my
`expect(result.errors).toBe(0)` was wrong for exactly the reason the column
sweep's aggregate zeros were wrong an hour earlier. Knowing the lesson is not
the same as applying it to the next aggregate.

## Not in this change

- **The rotation itself.** This is the tool; the operator runbook step is to set
  the new key, run POST until `remaining` is 0, confirm `previousKeyRetirable`,
  then remove `DATA_ENCRYPTION_KEY_PREVIOUS`.
- **Making the per-tenant job resolve `@map`'d names.** Its precondition is now
  guarded, so the hazard fails CI rather than production. Converting it is
  tidying, not a fix.
