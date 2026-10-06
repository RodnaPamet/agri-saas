# P3.4 — `FarmIdentityClaim`: the table, the index and the blind-index kind

Part of [social] P3 (#1194). Table-only, shipped a release ahead of the usecase
and route per expand-and-contract (`docs/deployment.md`), so the write path
lands against columns already in production.

## What is here

- `prisma/schema/farm-identity.prisma` — `FarmIdentityClaim` and
  `FarmIdentityClaimStatus`. A new domain file rather than an addition to
  `social.prisma`, whose header states its models are platform-scoped and that
  "there is no `tenantId` here" — true today, and adding a tenant-scoped model
  there would have quietly made it false.
- The migration — table, a **partial** unique index, and the canonical
  three-policy RLS shape.
- `LookupKind` gains `'eik'`, with its own HKDF info string.
- Two suites, both mutation-proved below.

## Three things that are not obvious from the brief

### 1. A pre-insert "is this ЕИК taken?" check is structurally blind

RLS scopes reads to the calling tenant. So the query a usecase would run before
inserting returns **zero rows precisely when the incumbent belongs to another
farm** — the only case the check exists for. It is not merely racy; it cannot
see the conflict at all, and the caller concludes the ЕИК is free.

That is why uniqueness is a partial unique index and not usecase logic: a
constraint is enforced on the heap, beneath the policies.
`farm-identity-claim-unique.test.ts` asserts the silent zero directly, as the
justification for the design rather than as a curiosity.

### 2. The collision resolves against the claimant, never the incumbent

"Collisions go to DISPUTED" has a reading in which *both* rows go to DISPUTED.
That reading is a griefing primitive: anyone who can type a verified farm's ЕИК
— a public number, it is in the Търговски регистър — could knock that farm out
of verified status at will, with no access to anything of theirs. A claim is not
evidence against an already-verified one, so only the arriving claim is
disputed. Pinned by a test.

### 3. The index cannot see across a lookup-key rotation

`eikHash` holds the hash under the **current** key.
`hashForLookupCandidates` reads under current *and* previous during a rotation,
but a row written before the rotation still carries the old value — so two
claims on one ЕИК, either side of a rotation, are two different strings and the
partial unique index does not relate them.

The guarantee is therefore **one VERIFIED claim per ЕИК per key generation**.
Closing the gap is the verification path's job (P3.9): look the ЕИК up with the
full candidate set before promoting, and re-hash the row it promotes. Recorded
in the model docblock so the next reader does not mistake the index for the
whole rule.

## A correction, found by mutation

The migration first claimed `tenant_isolation_insert` was load-bearing because
"USING is not consulted on INSERT". **That is false.** Dropping that policy in
isolation against the live database left the foreign-attribution insert refused
and the own-tenant insert working: on a `FOR ALL` policy with `WITH CHECK`
unspecified, Postgres uses the USING expression as the check for new rows, for
INSERT as well as UPDATE. `tenant_isolation` already covers attribution alone.

The policy stays — `tests/guardrails/rls-coverage.test.ts` demands the name, and
an explicit INSERT rule survives a future edit narrowing `tenant_isolation` to
`FOR SELECT`, which would otherwise remove INSERT protection with nothing to
catch it. But the comment now says what is true.

A second mutation found a test with no teeth: "app_user cannot plant a claim
attributed to another farm" **still passes with both policies dropped**, because
FORCE RLS plus a false `superuser_bypass` denies `app_user` everything, so the
insert is refused for a reason unrelated to attribution. Its paired positive
control is what carries the meaning, and the test now says so rather than
reading as self-sufficient.

## Mutation proofs

Each mutation applied, suite run, mutation reverted. The point is which
assertions execute what was broken, not that the suite is red.

| Mutation | Expected | Result |
| --- | --- | --- |
| `eik` reuses `HMAC_INFO` | separation dies | 2 failed, incl. the invariant (not only the pin) |
| drop the partial unique index | uniqueness + race die | 4 failed, incl. the concurrency case |
| widen it to a FULL unique index | partiality dies | 4 failed, incl. "PENDING pile up freely" |
| drop `tenant_isolation_insert` | attribution dies | **1 failed** — only the policy count. See the correction above |
| drop `tenant_isolation` | reads leak | 3 failed, incl. the silent-zero case |
| drop both policies | attribution dies | 3 failed — but *not* the attribution case |

## Deliberately not here

- **Identical responses and the ±50ms timing property.** Both belong to the
  route, which does not exist yet. Asserting them now would be a green test for
  an absent control.
- **Whether claims should be fail-closed audited.** A VERIFIED claim is what
  vouches for a farm's legal identity, which argues for adding
  `FarmIdentityClaim` to `FAIL_CLOSED_ENTITIES` alongside the identity-
  federation entries. It is left out of this PR on purpose: fail-closed means a
  failed audit write *blocks* the operation, and that belongs with the write
  path as a visible decision rather than as a side effect of a schema change.
- **`isValidEik`.** The claim path must reject an impossible ЕИК before hashing
  it, so no row and no index entry exist for a typo. The checksum lands in
  `src/lib/bg-identifiers.ts` on #1336 (P3.2) and will be imported, not
  reimplemented.

## Local verification

```
tests/integration/farm-identity-claim-unique.test.ts   10 passed
tests/unit/lookup-kind-eik-separation.test.ts           8 passed
tests/guardrails/rls-coverage.test.ts                  30 passed
full tsc --noEmit (buildinfo deleted first)            exit 0
npm run lint                                           exit 0
```

The integration suite migrates and runs against the per-checkout slotted
database (`agri_saas_test_c<hash>`), so nothing here touched a database another
session uses.
