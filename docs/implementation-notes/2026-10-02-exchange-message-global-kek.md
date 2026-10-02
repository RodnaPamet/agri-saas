# 2026-10-02 — #1222: the Exchange message a recipient could not read

**Commit:** `<sha> fix(exchange): encrypt message bodies under the global KEK so both parties can read them`

## The defect

`ExchangeMessage` was not in `ENCRYPTED_FIELDS`, so the middleware's write path
took

```ts
const targetModel = isEncryptedModel(model) ? model : '*';
```

and the `'*'` fan-out matches encrypted field **names** across the whole
manifest. `TaskComment: ['body']` puts `body` in that flat set, so
`ExchangeMessage.body` was encrypted — **under the writer's tenant DEK**,
because that is whose context the write runs in.

`listThreadMessages` reads inside the **viewing** party's tenant context. So
each side read its own messages as text and the other side's as `v2:…`.

Measured on production: both messages on the only live thread were written by
one tenant, so the recipient could read **neither**. One side of the only real
Exchange conversation on the deployment.

## Why five months of green said nothing

Nothing failed. The writer's own reads were perfect, every suite that exercises
one tenant passed, and the ciphertext was well-formed. The defect is only
visible from a context no test entered.

The pre-existing `exchange-messaging-rls.test.ts` could not have caught it
either: it creates listings with no `description` at all, through a bare
`PrismaClient` with no extensions.

## The fix, and why not the alternatives

| option | verdict |
| --- | --- |
| per-tenant DEK (status quo) | **impossible.** Letting B decrypt A's message means handing B party A's DEK, which exposes *all* of A's `v2:` data, not one message |
| thread-scoped key | new schema, new key-management path, new migration — for a property the global KEK already provides |
| plaintext | inconsistent with house style for business free text (`Task.description`, `TaskComment.body`, `Contract.terms`, `ParcelLease.lessorName`) and with the content, which is farm-to-farm trade negotiation |
| **global KEK** | the only key both parties share; the mechanism already exists |

So: `ExchangeMessage: ['body']` is **declared** in `ENCRYPTED_FIELDS` — making
the encryption a decision rather than an accident of the flat name set, and
incidentally taking the model off the `'*'` path — and the model joins
`GLOBAL_KEK_MODELS`.

## What the global KEK does NOT widen

The obvious objection is that a deployment-wide key lets every tenant read every
message. It does not, and the test that pins this is one I wrote expecting the
opposite result: a third tenant gets **nothing**, because `ExchangeMessage`
carries `exchange_message_party_isolation`, an RLS policy that joins through
`ExchangeThread` and `ExchangeListing` to confirm the reader is a party.

RLS decides who may see the row; encryption-at-rest decides what a stolen
database yields. Two controls, each doing its own job, and changing the key model
does not widen access by one row.

## The guard found a second model, and it was deliberate

`tests/guards/global-kek-models-covers-tenantless.test.ts` enforces the rule
`GLOBAL_KEK_MODELS`' own docblock states. On its first run it flagged
**`PromotionLead`** — no `tenantId`, encrypted fields, absent from the set.

Adding it to go green would have reversed a recorded design decision. CLAUDE.md
and `prisma/schema/promotions.prisma` both state the posture: the lead "belongs
to the farmer, so per-tenant key isolation is the correct posture. A reader
outside that tenant (the future digest job) must therefore resolve each lead's
tenant context to decrypt."

So the rule as written was wrong, not the model. The distinction is **how many
tenants must read the row**, not whether a `tenantId` column exists:

- `ExchangeMessage` — both parties read every message. No per-tenant key works.
- `PromotionLead` — one tenant reads it. Per-tenant isolation is achievable and
  chosen.

The prose rule is corrected and the exception is recorded with its reason, with
a stale-entry check so the exemption cannot become a hiding place.

## Deployment order matters, in a way I did not expect

A pre-existing `v2:` row becomes unreadable by **both** parties once the fix
ships — not just the recipient. `resolveTenantDekPair` returns the empty pair for
anything in `GLOBAL_KEK_MODELS`, so the middleware never resolves a tenant DEK on
this model and a leftover v2 value cannot be decrypted by anyone.

So the fix briefly makes the broken rows *more* broken until the repair runs. On
production that is the minutes between the deploy and the repair call, over two
rows on one thread. `repairMisplacedV2` is unaffected because it calls
`getTenantDek` directly rather than through the middleware.

I found this because a test assertion I was confident about failed.

## `repairMisplacedV2`

Declaring the field fixes every future write and nothing already written.
`repairMisplacedV2` (in `global-key-rotation.ts`, beside the KEK sweep it shares
machinery with) decrypts with the **writing** tenant's DEK — primary, falling
back to that tenant's previous DEK mid-rotation — and re-encrypts with
`encryptField`.

It will be needed again: the `'*'` fan-out encrypts 19 non-manifest models, and
each one promoted into `GLOBAL_KEK_MODELS` arrives with the same question about
its existing rows. The per-model "which column names the writing tenant" map is
**declared**, not derived — only the row knows, under a model-specific name
(`senderTenantId` here, since the row has no `tenantId`) — and a model with
misplaced rows and no entry is an **error**, not a skip.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/encrypted-fields.ts` | `ExchangeMessage: ['body']` declared |
| `src/lib/db/encryption-middleware.ts` | model added to `GLOBAL_KEK_MODELS`; the rule's prose corrected; the set exported |
| `src/app-layer/usecases/global-key-rotation.ts` | `repairMisplacedV2`, `countMisplacedV2`, the declared tenant-column map |
| `tests/integration/exchange-message-both-parties-read.test.ts` | the cross-party read, and the third-tenant RLS property |
| `tests/integration/exchange-message-v2-repair.test.ts` | the migration preserves the plaintext and unblocks the other party |
| `tests/guards/global-kek-models-covers-tenantless.test.ts` | both directions of the rule, with the documented exception |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | `ExchangeMessage` classified — `sanitizePlainText` at one write seam |

## Not in this change

**The other 18 models.** The fan-out encrypts them too, and that half is owned
separately (#1222). Two things it must respect, both established while scoping
this:

- **Declare before narrowing.** Narrowing `'*'` stops the middleware
  *decrypting* a non-manifest model as well as encrypting it, so the 13
  tenant-scoped models must be declared in `ENCRYPTED_FIELDS` first.
  `Location.description` (1/1 encrypted) and `LogEntry.notes` (3/3) are live rows
  that would turn into visible ciphertext if the order were reversed.
- **`ExchangeListing.description` is the one to think hardest about.** It has the
  same shape as `ExchangeMessage.body` — no `tenantId`, cross-tenant by
  construction (the repository does a "GLOBAL browse of ACTIVE listings across
  ALL tenants") — and the real write path *does* encrypt it. But the usecase
  groups it with `commodity` and `sellerDisplayName` as "PUBLIC free text (every
  tenant reads them)", and those two are plaintext. Encrypting one of three is
  incoherent, so the coherent answer is plaintext for all three — which makes it
  a *narrowing* case, not a global-KEK one. Free-text search covers `commodity`,
  `regionName` and `regionCode`, not `description`, so queryability does not
  decide it either way.

Production's single `ExchangeListing` row is plaintext only because it was
hand-written with raw SQL as a fixture; the normal path encrypts.
